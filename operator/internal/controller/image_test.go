package controller

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func imageApp(ns, ref string) *appsv1alpha1.App {
	return &appsv1alpha1.App{
		ObjectMeta: metav1.ObjectMeta{Name: "dash", Namespace: ns, Generation: 1},
		Spec: appsv1alpha1.AppSpec{
			DisplayName: "Dash",
			Source: appsv1alpha1.AppSource{
				Type:  appsv1alpha1.SourceTypeImage,
				Image: &appsv1alpha1.ImageSource{Reference: ref, Port: 8501},
			},
			Access: appsv1alpha1.AppAccess{Subdomain: "dash"},
		},
	}
}

func imageReconciler(t *testing.T, objs ...client.Object) (*AppReconciler, client.Client, *record.FakeRecorder) {
	t.Helper()
	r, c := newReconciler(t, objs...)
	r.Config.ImageRegistries = []string{"ghcr.io/org", "docker.io/library"}
	r.Config.ImagePullSecrets = []string{"registry-creds"}
	rec := record.NewFakeRecorder(10)
	r.Recorder = rec
	return r, c, rec
}

func getDeployment(t *testing.T, c client.Client, app *appsv1alpha1.App) *appsv1.Deployment {
	t.Helper()
	d := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestReconcileImageApp(t *testing.T) {
	app := imageApp("apps", "ghcr.io/org/dash:1.2.3")
	app.Spec.Source.Image.Command = []string{"streamlit"}
	app.Spec.Source.Image.Args = []string{"run", "app.py", "--server.port=8501"}
	app.Spec.Runtime.Env = []corev1.EnvVar{{Name: "MODE", Value: "demo"}}
	app.Spec.Runtime.SecretKeys = []string{"API_TOKEN"}
	r, c, _ := imageReconciler(t, managedNamespace("apps"), app)
	reconcile(t, r, app)

	got := getApp(t, c, app.Name, app.Namespace)
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Fatalf("not validated: %s", got.Status.Message)
	}
	pod := getDeployment(t, c, app).Spec.Template.Spec

	if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
		t.Error("image pods must not mount a ServiceAccount token")
	}
	if sc := pod.SecurityContext; sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot || sc.RunAsUser != nil {
		t.Errorf("pod security context = %+v, want runAsNonRoot and no uid override", sc)
	}
	if len(pod.ImagePullSecrets) != 1 || pod.ImagePullSecrets[0].Name != "registry-creds" {
		t.Errorf("imagePullSecrets = %+v", pod.ImagePullSecrets)
	}
	if len(pod.Volumes) != 0 || len(pod.InitContainers) != 0 {
		t.Errorf("image pods need no volumes or init containers: %+v %+v", pod.Volumes, pod.InitContainers)
	}
	if names(pod.Containers)[0] != "app" || len(pod.Containers) != 2 || pod.Containers[1].Name != authzContainer {
		t.Fatalf("containers = %v, want app then the authz sidecar", names(pod.Containers))
	}
	main := pod.Containers[0]
	if main.Image != "ghcr.io/org/dash:1.2.3" || main.ImagePullPolicy != corev1.PullAlways {
		t.Errorf("image %s pull %s", main.Image, main.ImagePullPolicy)
	}
	if strings.Join(main.Command, " ") != "streamlit" || strings.Join(main.Args, " ") != "run app.py --server.port=8501" {
		t.Errorf("command %v args %v", main.Command, main.Args)
	}
	if main.Ports[0].ContainerPort != 8501 {
		t.Errorf("app port = %d, want 8501", main.Ports[0].ContainerPort)
	}
	if sc := main.SecurityContext; sc == nil || *sc.AllowPrivilegeEscalation || len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" {
		t.Errorf("container security context = %+v", sc)
	}
	if lim := main.Resources.Limits; lim.Cpu().IsZero() || lim.Memory().IsZero() {
		t.Errorf("image app has no limits: %+v", main.Resources)
	}
	env := envOf(main)
	if env["PORT"] != "8501" || env["MODE"] != "demo" {
		t.Errorf("env = %v", env)
	}
	var secret *corev1.EnvVar
	for i := range main.Env {
		if main.Env[i].Name == "API_TOKEN" {
			secret = &main.Env[i]
		}
	}
	if secret == nil || secret.ValueFrom.SecretKeyRef.Name != "app-dash-secrets" {
		t.Errorf("secret key not injected from the App's own Secret: %+v", secret)
	}
	if main.ReadinessProbe.HTTPGet == nil || main.ReadinessProbe.HTTPGet.Path != "/upstreamz" {
		t.Errorf("readiness probe should go through the sidecar: %+v", main.ReadinessProbe)
	}
	side := envOf(pod.Containers[1])
	if side["AUTHZ_UPSTREAM"] != "http://127.0.0.1:8501" || side["AUTHZ_PASSTHROUGH"] != "true" {
		t.Errorf("sidecar env = %v", side)
	}
	if pod.Containers[1].Ports[0].Name != "http" || pod.Containers[1].Ports[0].ContainerPort != AppPort {
		t.Errorf("sidecar must take the Service's http port: %+v", pod.Containers[1].Ports)
	}
	if cm := r.Config.buildServerConfigMap(app); cm != nil {
		t.Error("image apps get no nginx config")
	}
}

func TestImageAppRestrictedAndDigest(t *testing.T) {
	digest := "sha256:" + strings.Repeat("b", 64)
	app := restrictedApp(imageApp("apps", "nginx@"+digest), []string{"analysts"})
	app.Spec.Source.Image.RunAsUser = ptr.To(int64(1000))
	r, c, _ := imageReconciler(t, managedNamespace("apps"), app)
	reconcile(t, r, app)
	pod := getDeployment(t, c, app).Spec.Template.Spec
	main := pod.Containers[0]
	if main.Image != "docker.io/library/nginx@"+digest || main.ImagePullPolicy != corev1.PullIfNotPresent {
		t.Errorf("image %s pull %s", main.Image, main.ImagePullPolicy)
	}
	if *pod.SecurityContext.RunAsUser != 1000 || !*pod.SecurityContext.RunAsNonRoot {
		t.Errorf("security context = %+v", pod.SecurityContext)
	}
	side := envOf(pod.Containers[1])
	if side["AUTHZ_GROUPS"] != "analysts" || side["AUTHZ_PASSTHROUGH"] != "" {
		t.Errorf("restricted image app sidecar env = %v", side)
	}
}

func TestImageAppValidation(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate     func(*appsv1alpha1.App)
		registries []string
		reason     string
		message    string
	}{
		"feature off": {func(*appsv1alpha1.App) {}, []string{}, appsv1alpha1.ReasonImageNotAllowed, "disabled"},
		"other registry": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image.Reference = "ghcr.io.evil.com/org/app:1"
		}, nil, appsv1alpha1.ReasonImageNotAllowed, "not in the allowed image registries"},
		"sibling org": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image.Reference = "ghcr.io/org-evil/app:1"
		}, nil, appsv1alpha1.ReasonImageNotAllowed, "ghcr.io/org-evil/app"},
		"no tag": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image.Reference = "ghcr.io/org/app"
		}, nil, "ValidationFailed", "tag"},
		"sidecar port": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image.Port = AppPort
		}, nil, "ValidationFailed", "sidecar"},
		"pixi task": {func(a *appsv1alpha1.App) {
			a.Spec.Runtime.PixiTask = "start"
		}, nil, "ValidationFailed", "pixiTask"},
		"root uid": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image.RunAsUser = ptr.To(int64(0))
		}, nil, "ValidationFailed", "runAsUser"},
		"missing image": {func(a *appsv1alpha1.App) {
			a.Spec.Source.Image = nil
		}, nil, "ValidationFailed", "source.image.reference is required"},
	} {
		t.Run(name, func(t *testing.T) {
			app := imageApp("apps", "ghcr.io/org/dash:1")
			tc.mutate(app)
			r, c, _ := imageReconciler(t, managedNamespace("apps"), app)
			if tc.registries != nil {
				r.Config.ImageRegistries = tc.registries
			}
			reconcile(t, r, app)
			got := getApp(t, c, app.Name, app.Namespace)
			cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionValidated)
			if got.Status.Phase != appsv1alpha1.AppPhaseFailed || cond == nil || cond.Reason != tc.reason ||
				!strings.Contains(cond.Message, tc.message) {
				t.Errorf("phase %s condition %+v, want %s containing %q", got.Status.Phase, cond, tc.reason, tc.message)
			}
		})
	}
}

// Shrinking the allowlist stops an image App that was running: the
// operator is the boundary for kubectl and GitOps authors too.
func TestDisallowedImageStopsRunningWorkload(t *testing.T) {
	app := imageApp("apps", "ghcr.io/org/dash:1")
	r, c, rec := imageReconciler(t, managedNamespace("apps"), app)
	reconcile(t, r, app)
	if got := *getDeployment(t, c, app).Spec.Replicas; got != 1 {
		t.Fatalf("replicas = %d", got)
	}
	r.Config.ImageRegistries = []string{"quay.io"}
	reconcile(t, r, app)
	if got := *getDeployment(t, c, app).Spec.Replicas; got != 0 {
		t.Errorf("replicas after the allowlist dropped the registry = %d, want 0", got)
	}
	select {
	case e := <-rec.Events:
		if !strings.Contains(e, appsv1alpha1.ReasonImageNotAllowed) {
			t.Errorf("event = %q", e)
		}
	default:
		t.Error("no ImageNotAllowed event")
	}
}

func waitingPod(t *testing.T, c client.Client, app *appsv1alpha1.App, reason, message string) {
	t.Helper()
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "dash-abc", Namespace: app.Namespace, Labels: selectorLabels(app)},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app", Image: "x"}}},
	}
	if err := c.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name:  "app",
		State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason, Message: message}},
	}}
	if err := c.Status().Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
}

func TestImageRunningAsRootFailsWithExplanation(t *testing.T) {
	app := imageApp("apps", "ghcr.io/org/dash:1")
	r, c, rec := imageReconciler(t, managedNamespace("apps"), app)
	reconcile(t, r, app)
	waitingPod(t, c, app, "CreateContainerConfigError",
		"container has runAsNonRoot and image will run as root (pod: \"dash-abc_apps\", container: app)")
	reconcile(t, r, app)
	reconcile(t, r, app) // the event is emitted once, not every reconcile

	got := getApp(t, c, app.Name, app.Namespace)
	cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionWorkloadReady)
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed || cond.Reason != appsv1alpha1.ReasonImageRunsAsRoot ||
		!strings.Contains(got.Status.Message, "runAsUser") {
		t.Errorf("phase %s condition %+v message %q", got.Status.Phase, cond, got.Status.Message)
	}
	pod := getDeployment(t, c, app).Spec.Template.Spec
	if !*pod.SecurityContext.RunAsNonRoot {
		t.Error("the policy must not be relaxed for a root image")
	}
	if n := len(rec.Events); n != 1 {
		t.Errorf("%d events, want one ImageRunsAsRoot", n)
	}
	if e := <-rec.Events; !strings.Contains(e, appsv1alpha1.ReasonImageRunsAsRoot) {
		t.Errorf("event = %q", e)
	}
}

func TestImagePullFailure(t *testing.T) {
	app := imageApp("apps", "ghcr.io/org/dash:1")
	r, c, _ := imageReconciler(t, managedNamespace("apps"), app)
	reconcile(t, r, app)
	waitingPod(t, c, app, "ImagePullBackOff", strings.Repeat("unauthorized ", 100))
	reconcile(t, r, app)
	got := getApp(t, c, app.Name, app.Namespace)
	cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionWorkloadReady)
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed || cond.Reason != appsv1alpha1.ReasonImagePullFailed {
		t.Errorf("phase %s condition %+v", got.Status.Phase, cond)
	}
	if len(got.Status.Message) > 600 {
		t.Errorf("kubelet message not bounded: %d bytes", len(got.Status.Message))
	}
}

func TestImageAppNeedsAuthzImage(t *testing.T) {
	app := imageApp("apps", "ghcr.io/org/dash:1")
	r, c, _ := imageReconciler(t, managedNamespace("apps"), app)
	r.Config.AuthzImage = ""
	reconcile(t, r, app)
	if got := getApp(t, c, app.Name, app.Namespace); got.Status.Phase != appsv1alpha1.AppPhaseFailed ||
		!strings.Contains(got.Status.Message, "--authz-image") {
		t.Errorf("phase %s message %q", got.Status.Phase, got.Status.Message)
	}
}

func TestTruncateKeepsRunes(t *testing.T) {
	if got := truncate("ééé", 3); got != "é..." {
		t.Errorf("truncate = %q", got)
	}
}
