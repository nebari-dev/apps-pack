//go:build envtest

// The reconciler against a real apiserver (envtest): CRD validation, the
// generation bookkeeping the fake client does not do, and the watches that
// requeue an App when its children change. Run with
//
//	KUBEBUILDER_ASSETS=$(setup-envtest use -p path 1.37.0) go test -tags envtest ./internal/controller/
//
// CI does this in the "Operator envtest" job.
package controller

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// startEnv boots an apiserver with the App and NebariApp CRDs and runs the
// reconciler in a manager until the test ends.
func startEnv(t *testing.T) client.Client {
	t.Helper()
	env := &envtest.Environment{
		CRDDirectoryPaths: []string{
			filepath.Join("..", "..", "..", "charts", "nebari-apps", "crds"),
			filepath.Join("testdata", "crds"),
		},
		ErrorIfCRDPathMissing: true,
	}
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("starting envtest (is KUBEBUILDER_ASSETS set?): %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := appsv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:  scheme,
		Metrics: metricsserver.Options{BindAddress: "0"},
		// Each test runs its own manager in this process.
		Controller: config.Controller{SkipNameValidation: ptr.To(true)},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := &AppReconciler{
		Client: mgr.GetClient(),
		Scheme: scheme,
		Config: OperatorConfig{
			AppsDomain:      testDomain,
			Gateway:         "public",
			StaticImage:     "nginxinc/nginx-unprivileged:1.27-alpine",
			GitImage:        "alpine/git:v2.47.2",
			PythonImage:     "ghcr.io/prefix-dev/pixi:0.68.1-noble",
			StaticResources: DefaultStaticResources,
			PythonResources: DefaultPythonResources,
			AuthzImage:      testAuthzImage,
			AuthzResources:  DefaultAuthzResources,
			KeycloakURL:     "https://keycloak.nebari.local",
			KeycloakRealm:   "nebari",
		},
	}
	if err := r.SetupWithManager(mgr); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := mgr.Start(ctx); err != nil {
			t.Errorf("manager: %v", err)
		}
	}()
	t.Cleanup(func() { cancel(); <-done })

	// A direct client: reads see the apiserver, not the manager's cache.
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// eventually polls cond until it returns "" (success) or the deadline passes.
func eventually(t *testing.T, what string, cond func() string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	last := ""
	for time.Now().Before(deadline) {
		if last = cond(); last == "" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s: %s", what, last)
}

func phaseIs(c client.Client, key types.NamespacedName, want appsv1alpha1.AppPhase) func() string {
	return func() string {
		app := &appsv1alpha1.App{}
		if err := c.Get(context.Background(), key, app); err != nil {
			return err.Error()
		}
		if app.Status.Phase != want {
			return "phase " + string(app.Status.Phase) + ": " + app.Status.Message
		}
		return ""
	}
}

// reportRollout writes Deployment status as the deployment controller would
// once it has rolled out the current template (envtest runs no controllers).
func reportRollout(t *testing.T, c client.Client, key types.NamespacedName, replicas int32) {
	t.Helper()
	d := &appsv1.Deployment{}
	if err := c.Get(context.Background(), key, d); err != nil {
		t.Fatal(err)
	}
	d.Status = appsv1.DeploymentStatus{
		ObservedGeneration: d.Generation,
		Replicas:           replicas, UpdatedReplicas: replicas, ReadyReplicas: replicas, AvailableReplicas: replicas,
	}
	if err := c.Status().Update(context.Background(), d); err != nil {
		t.Fatal(err)
	}
}

func TestEnvtestAppLifecycle(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	app := inlineApp("team-a")
	app.Generation = 0
	if err := c.Create(ctx, app); err != nil {
		t.Fatal(err)
	}
	key := types.NamespacedName{Name: app.Name, Namespace: app.Namespace}
	child := types.NamespacedName{Name: childName(app), Namespace: app.Namespace}

	// Created: every child exists, owned by the App, and the App is Deploying.
	eventually(t, "Deploying", phaseIs(c, key, appsv1alpha1.AppPhaseDeploying))
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	for _, obj := range []client.Object{&appsv1.Deployment{}, &corev1.Service{}, na} {
		if err := c.Get(ctx, child, obj); err != nil {
			t.Fatalf("%T: %v", obj, err)
		}
		if refs := obj.GetOwnerReferences(); len(refs) != 1 || !ptr.Deref(refs[0].Controller, false) {
			t.Errorf("%T owner references = %+v", obj, refs)
		}
	}
	for _, name := range []string{child.Name + "-content", child.Name + "-server"} {
		if err := c.Get(ctx, types.NamespacedName{Name: name, Namespace: app.Namespace}, &corev1.ConfigMap{}); err != nil {
			t.Errorf("ConfigMap %s: %v", name, err)
		}
	}

	// The workload rolls out and the nebari-operator reports routing Ready:
	// the watches requeue the App with no nudge from the test.
	reportRollout(t, c, child, 1)
	if err := c.Get(ctx, child, na); err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedSlice(na.Object, []any{
		map[string]any{"type": "Ready", "status": "True", "reason": "ReconcileSuccess", "message": "",
			"lastTransitionTime": metav1.Now().UTC().Format(time.RFC3339)},
	}, "status", "conditions")
	if err := c.Status().Update(ctx, na); err != nil {
		t.Fatal(err)
	}
	eventually(t, "Running", phaseIs(c, key, appsv1alpha1.AppPhaseRunning))

	// Editing the content changes the pod template: the apiserver bumps the
	// Deployment's generation, and until the rollout is observed the App is
	// Deploying again.
	edit := &appsv1alpha1.App{}
	if err := c.Get(ctx, key, edit); err != nil {
		t.Fatal(err)
	}
	edit.Spec.Source.Inline.Files["index.html"] = "<h1>v2</h1>"
	if err := c.Update(ctx, edit); err != nil {
		t.Fatal(err)
	}
	eventually(t, "Deploying after an edit", phaseIs(c, key, appsv1alpha1.AppPhaseDeploying))
	reportRollout(t, c, child, 1)
	eventually(t, "Running after the rollout", phaseIs(c, key, appsv1alpha1.AppPhaseRunning))

	// Stop.
	if err := c.Get(ctx, key, edit); err != nil {
		t.Fatal(err)
	}
	edit.Spec.Runtime.Replicas = ptr.To(int32(0))
	if err := c.Update(ctx, edit); err != nil {
		t.Fatal(err)
	}
	eventually(t, "Stopped", phaseIs(c, key, appsv1alpha1.AppPhaseStopped))
	got := &appsv1alpha1.App{}
	if err := c.Get(ctx, key, got); err != nil {
		t.Fatal(err)
	}
	if got.Status.ObservedGeneration != got.Generation {
		t.Errorf("observedGeneration %d, generation %d", got.Status.ObservedGeneration, got.Generation)
	}
}

func TestEnvtestCRDRejectsInvalidApps(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*appsv1alpha1.App){
		"bad subdomain":       func(a *appsv1alpha1.App) { a.Spec.Access.Subdomain = "Not_A_Label" },
		"unknown source type": func(a *appsv1alpha1.App) { a.Spec.Source.Type = "ftp" },
		"negative replicas":   func(a *appsv1alpha1.App) { a.Spec.Runtime.Replicas = ptr.To(int32(-1)) },
		"idle timeout too short": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(4))
		},
		"idle timeout too long": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.IdleTimeoutMinutes = ptr.To(int32(43201))
		},
		"secret key not an env name": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.SecretKeys = []string{"API-KEY"}
		},
		"duplicate secret key": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.SecretKeys = []string{"API_KEY", "API_KEY"}
		},
		"env reads another app's secret": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.Env = []corev1.EnvVar{secretRefEnv("app-victim-secrets")}
		},
		"env reads an arbitrary secret": func(a *appsv1alpha1.App) {
			a.Spec.Runtime.Env = []corev1.EnvVar{{Name: "A", Value: "b"}, secretRefEnv("db-credentials")}
		},
		"image source without image": func(a *appsv1alpha1.App) {
			a.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeImage}
		},
		"image on the sidecar's port": func(a *appsv1alpha1.App) {
			a.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeImage,
				Image: &appsv1alpha1.ImageSource{Reference: "ghcr.io/org/app:1", Port: 8080}}
		},
		"image on a privileged port": func(a *appsv1alpha1.App) {
			a.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeImage,
				Image: &appsv1alpha1.ImageSource{Reference: "ghcr.io/org/app:1", Port: 80}}
		},
		"image as root": func(a *appsv1alpha1.App) {
			a.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeImage,
				Image: &appsv1alpha1.ImageSource{Reference: "ghcr.io/org/app:1", Port: 8501, RunAsUser: ptr.To(int64(0))}}
		},
	} {
		app := inlineApp("team-a")
		app.Generation = 0
		mutate(app)
		if err := c.Create(ctx, app); !apierrors.IsInvalid(err) {
			t.Errorf("%s: want an Invalid error from the CRD schema, got %v", name, err)
		}
	}
}

// The CRD admits other valueFrom kinds and edits elsewhere in the spec, and
// refuses a secretKeyRef added by an update, even to the App's own Secret.
func TestEnvtestCRDEnvReferences(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	app := inlineApp("team-a")
	app.Generation = 0
	app.Spec.Runtime.Env = []corev1.EnvVar{
		{Name: "POD_IP", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.podIP"}}},
		configMapRefEnv("team-settings"),
	}
	if err := c.Create(ctx, app); err != nil {
		t.Fatalf("fieldRef/configMapKeyRef refused: %v", err)
	}
	app.Spec.Runtime.Env = append(app.Spec.Runtime.Env, secretRefEnv("app-docs-site-secrets"))
	if err := c.Update(ctx, app); !apierrors.IsInvalid(err) {
		t.Errorf("update adding a secretKeyRef: want Invalid, got %v", err)
	}
}

// Restricting an App adds the authz sidecar and forwards the access token;
// lifting the restriction takes both away again.
func TestEnvtestRestrictedAppGetsAuthzSidecar(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	app := inlineApp("team-a")
	app.Generation = 0
	app.Spec.Access.Public = false
	app.Spec.Access.Groups = []string{"analysts"}
	if err := c.Create(ctx, app); err != nil {
		t.Fatal(err)
	}
	key := types.NamespacedName{Name: app.Name, Namespace: app.Namespace}
	child := types.NamespacedName{Name: childName(app), Namespace: app.Namespace}
	eventually(t, "Deploying", phaseIs(c, key, appsv1alpha1.AppPhaseDeploying))

	state := func(wantSidecar bool) func() string {
		return func() string {
			d := &appsv1.Deployment{}
			if err := c.Get(ctx, child, d); err != nil {
				return err.Error()
			}
			na := &unstructured.Unstructured{}
			na.SetGroupVersionKind(NebariAppGVK)
			if err := c.Get(ctx, child, na); err != nil {
				return err.Error()
			}
			fwd, _, _ := unstructured.NestedBool(na.Object, "spec", "auth", "forwardAccessToken")
			containers := d.Spec.Template.Spec.Containers
			hasSidecar := len(containers) == 2 && containers[1].Name == "authz"
			if hasSidecar != wantSidecar || fwd != wantSidecar || containers[0].Name != "app" {
				return fmt.Sprintf("containers %d, forwardAccessToken %v", len(containers), fwd)
			}
			return ""
		}
	}
	eventually(t, "sidecar and forwarded token", state(true))

	edit := &appsv1alpha1.App{}
	if err := c.Get(ctx, key, edit); err != nil {
		t.Fatal(err)
	}
	edit.Spec.Access.Groups = nil
	if err := c.Update(ctx, edit); err != nil {
		t.Fatal(err)
	}
	eventually(t, "no sidecar once unrestricted", state(false))
}

// setRuntimeRules swaps the CEL rules on spec.runtime in the installed App
// CRD (nil removes them) and returns the previous ones.
func setRuntimeRules(t *testing.T, c client.Client, rules []any) []any {
	t.Helper()
	crd := &unstructured.Unstructured{}
	crd.SetAPIVersion("apiextensions.k8s.io/v1")
	crd.SetKind("CustomResourceDefinition")
	if err := c.Get(context.Background(), types.NamespacedName{Name: "apps.apps.nebari.dev"}, crd); err != nil {
		t.Fatal(err)
	}
	versions, _, _ := unstructured.NestedSlice(crd.Object, "spec", "versions")
	v := versions[0].(map[string]any)
	path := []string{"schema", "openAPIV3Schema", "properties", "spec", "properties", "runtime"}
	runtimeSchema, _, _ := unstructured.NestedMap(v, path...)
	old, _ := runtimeSchema["x-kubernetes-validations"].([]any)
	if rules == nil {
		delete(runtimeSchema, "x-kubernetes-validations")
	} else {
		runtimeSchema["x-kubernetes-validations"] = rules
	}
	if err := unstructured.SetNestedMap(v, runtimeSchema, path...); err != nil {
		t.Fatal(err)
	}
	versions[0] = v
	if err := unstructured.SetNestedSlice(crd.Object, versions, "spec", "versions"); err != nil {
		t.Fatal(err)
	}
	if err := c.Update(context.Background(), crd); err != nil {
		t.Fatal(err)
	}
	return old
}

// An App stored with a secretKeyRef before the CRD refused it (an upgrade)
// is not served: the operator marks it Failed with ForbiddenEnvReference and
// creates no workload. Ratcheting keeps its status updates and unrelated
// edits working under the new rule.
func TestEnvtestStoredCrossAppSecretRef(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	rules := setRuntimeRules(t, c, nil)
	if len(rules) == 0 {
		t.Fatal("the CRD has no runtime rule to remove")
	}
	app := inlineApp("team-a")
	app.Generation = 0
	app.Spec.Runtime.Env = []corev1.EnvVar{secretRefEnv("app-victim-secrets")}
	eventually(t, "the CRD without the rule", func() string {
		if err := c.Create(ctx, app.DeepCopy()); err != nil {
			return err.Error()
		}
		return ""
	})
	setRuntimeRules(t, c, rules)
	probe := inlineApp("team-a")
	probe.Name, probe.Generation = "probe", 0
	probe.Spec.Access.Subdomain = "probe"
	probe.Spec.Runtime.Env = app.Spec.Runtime.Env
	eventually(t, "the CRD with the rule again", func() string {
		if err := c.Create(ctx, probe.DeepCopy()); !apierrors.IsInvalid(err) {
			_ = c.Delete(ctx, probe.DeepCopy())
			return fmt.Sprintf("create still allowed: %v", err)
		}
		return ""
	})

	key := types.NamespacedName{Name: app.Name, Namespace: app.Namespace}
	eventually(t, "the App to be refused", func() string {
		got := &appsv1alpha1.App{}
		if err := c.Get(ctx, key, got); err != nil {
			return err.Error()
		}
		cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionValidated)
		if got.Status.Phase != appsv1alpha1.AppPhaseFailed || cond == nil || cond.Reason != ForbiddenEnvReference {
			return fmt.Sprintf("phase %s, condition %+v", got.Status.Phase, cond)
		}
		return ""
	})
	err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, &appsv1.Deployment{})
	if !apierrors.IsNotFound(err) {
		t.Errorf("Deployment lookup = %v, want NotFound", err)
	}

	got := &appsv1alpha1.App{}
	if err := c.Get(ctx, key, got); err != nil {
		t.Fatal(err)
	}
	got.Spec.DisplayName = "Renamed"
	if err := c.Update(ctx, got); err != nil {
		t.Errorf("an edit that leaves runtime alone was refused: %v", err)
	}
}

// A complete image App is admitted by the CRD schema.
func TestEnvtestCRDAdmitsImageApp(t *testing.T) {
	c := startEnv(t)
	ctx := context.Background()
	if err := c.Create(ctx, managedNamespace("team-a")); err != nil {
		t.Fatal(err)
	}
	app := imageApp("team-a", "ghcr.io/org/dash@sha256:"+strings.Repeat("c", 64))
	app.Generation = 0
	app.Spec.Source.Image.Command = []string{"python", "-m", "app"}
	app.Spec.Source.Image.Args = []string{"--port", "8501"}
	app.Spec.Source.Image.RunAsUser = ptr.To(int64(1000))
	if err := c.Create(ctx, app); err != nil {
		t.Fatalf("image App refused: %v", err)
	}
}
