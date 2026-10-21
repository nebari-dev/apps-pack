package controller

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func secretRefs(c corev1.Container) map[string]*corev1.SecretKeySelector {
	out := map[string]*corev1.SecretKeySelector{}
	for _, e := range c.Env {
		if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
			out[e.Name] = e.ValueFrom.SecretKeyRef
		}
	}
	return out
}

func TestSecretKeysInjectFromTheAppsOwnSecret(t *testing.T) {
	for _, tc := range []struct {
		name string
		app  *appsv1alpha1.App
	}{
		{"static", inlineApp("team-a")},
		{"pixi", pixiApp("team-a")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := tc.app
			app.Spec.Runtime.Env = []corev1.EnvVar{{Name: "MODE", Value: "prod"}}
			app.Spec.Runtime.SecretKeys = []string{"API_KEY", "DATABASE_URL"}
			// Restricted, so the pod also runs the authz sidecar.
			app.Spec.Access.Public = false
			app.Spec.Access.Groups = []string{"team"}
			r, _ := newReconciler(t)
			deploy, err := r.buildDeployment(app)
			if err != nil {
				t.Fatal(err)
			}
			pod := deploy.Spec.Template.Spec
			refs := secretRefs(pod.Containers[0])
			if len(refs) != 2 {
				t.Fatalf("app container secret env = %v, want API_KEY and DATABASE_URL", refs)
			}
			for _, key := range app.Spec.Runtime.SecretKeys {
				ref := refs[key]
				if ref == nil || ref.Name != "app-"+app.Name+"-secrets" || ref.Key != key {
					t.Errorf("%s: secretKeyRef = %+v, want app-%s-secrets/%s", key, ref, app.Name, key)
				}
				if ref != nil && ref.Optional != nil && *ref.Optional {
					t.Errorf("%s: secret ref must not be optional", key)
				}
			}
			if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
				t.Error("app pods must not mount a ServiceAccount token")
			}
			for _, c := range append(pod.InitContainers, pod.Containers[1:]...) {
				if len(secretRefs(c)) > 0 {
					t.Errorf("container %s must not get the app's secrets", c.Name)
				}
			}
			if len(app.Spec.Runtime.Env) != 1 {
				t.Errorf("building the pod changed the App's env: %v", app.Spec.Runtime.Env)
			}
		})
	}
}

func TestNoSecretKeysNoSecretEnv(t *testing.T) {
	app := inlineApp("team-a")
	app.Annotations = map[string]string{appsv1alpha1.SecretsVersionAnnotation: "42"}
	r, _ := newReconciler(t)
	deploy, err := r.buildDeployment(app)
	if err != nil {
		t.Fatal(err)
	}
	if refs := secretRefs(deploy.Spec.Template.Spec.Containers[0]); len(refs) > 0 {
		t.Errorf("unexpected secret env %v", refs)
	}
	if _, ok := deploy.Spec.Template.Annotations[appsv1alpha1.SecretsVersionAnnotation]; ok {
		t.Error("the secrets version only belongs on pods that read the Secret")
	}
}

func TestSecretRotationRollsPods(t *testing.T) {
	app := pixiApp("team-a")
	app.Spec.Runtime.SecretKeys = []string{"API_KEY"}
	app.Annotations = map[string]string{appsv1alpha1.SecretsVersionAnnotation: "100"}
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	ctx := context.Background()
	key := types.NamespacedName{Name: "app-py-app", Namespace: "team-a"}
	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, key, deploy); err != nil {
		t.Fatal(err)
	}
	if got := deploy.Spec.Template.Annotations[appsv1alpha1.SecretsVersionAnnotation]; got != "100" {
		t.Fatalf("pod template secrets version = %q, want 100", got)
	}

	got := getApp(t, c, "py-app", "team-a")
	got.Annotations[appsv1alpha1.SecretsVersionAnnotation] = "101"
	if err := c.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, app)
	if err := c.Get(ctx, key, deploy); err != nil {
		t.Fatal(err)
	}
	if got := deploy.Spec.Template.Annotations[appsv1alpha1.SecretsVersionAnnotation]; got != "101" {
		t.Errorf("pod template secrets version = %q after rotation, want 101", got)
	}
}

func TestSecretName(t *testing.T) {
	if got := appsv1alpha1.SecretName("docs"); got != "app-docs-secrets" {
		t.Errorf("SecretName = %q", got)
	}
}

func secretRefEnv(secret string) corev1.EnvVar {
	return corev1.EnvVar{Name: "STOLEN", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: secret}, Key: "API_KEY",
	}}}
}

func configMapRefEnv(cm string) corev1.EnvVar {
	return corev1.EnvVar{Name: "CM", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{
		LocalObjectReference: corev1.LocalObjectReference{Name: cm}, Key: "k",
	}}}
}

func TestCheckEnvRefs(t *testing.T) {
	for name, tc := range map[string]struct {
		env     corev1.EnvVar
		refused bool
	}{
		"another app's secret":        {secretRefEnv("app-victim-secrets"), true},
		"any other secret":            {secretRefEnv("db-credentials"), true},
		"own secret (use secretKeys)": {secretRefEnv("app-docs-site-secrets"), true},
		"another app's inline source": {configMapRefEnv("app-victim-content"), true},
		"another app's server config": {configMapRefEnv("app-victim-server"), true},
		"own content":                 {configMapRefEnv("app-docs-site-content"), false},
		"a team configmap":            {configMapRefEnv("team-settings"), false},
		"plain value":                 {corev1.EnvVar{Name: "A", Value: "b"}, false},
		"field ref": {corev1.EnvVar{Name: "POD_IP", ValueFrom: &corev1.EnvVarSource{
			FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.podIP"},
		}}, false},
		"resource field ref": {corev1.EnvVar{Name: "MEM", ValueFrom: &corev1.EnvVarSource{
			ResourceFieldRef: &corev1.ResourceFieldSelector{Resource: "limits.memory"},
		}}, false},
	} {
		app := inlineApp("team-a")
		app.Spec.Runtime.Env = []corev1.EnvVar{tc.env}
		err := checkEnvRefs(app)
		if (err != nil) != tc.refused {
			t.Errorf("%s: err = %v, refused want %v", name, err, tc.refused)
		}
		if err != nil && !isForbiddenEnvRef(err) {
			t.Errorf("%s: want a forbidden-reference error, got %v", name, err)
		}
	}
}

// An App that names another App's Secret fails validation with a clear
// reason and an event, and its workload is neither created nor updated.
func TestCrossAppSecretRefRefused(t *testing.T) {
	ctx := context.Background()
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	rec := record.NewFakeRecorder(10)
	r.Recorder = rec
	reconcile(t, r, app)

	key := types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}
	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, key, deploy); err != nil {
		t.Fatal(err)
	}

	got := getApp(t, c, "docs-site", "team-a")
	got.Spec.Runtime.Env = []corev1.EnvVar{secretRefEnv("app-victim-secrets")}
	if err := c.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, app)

	got = getApp(t, c, "docs-site", "team-a")
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed {
		t.Errorf("phase = %s, want Failed", got.Status.Phase)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionValidated)
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != ForbiddenEnvReference {
		t.Fatalf("Validated condition = %+v, want False/%s", cond, ForbiddenEnvReference)
	}
	if !strings.Contains(cond.Message, "app-victim-secrets") {
		t.Errorf("message %q should name the refused Secret", cond.Message)
	}
	select {
	case ev := <-rec.Events:
		if !strings.Contains(ev, "Warning "+ForbiddenEnvReference) {
			t.Errorf("event = %q", ev)
		}
	default:
		t.Error("no event recorded")
	}

	after := &appsv1.Deployment{}
	if err := c.Get(ctx, key, after); err != nil {
		t.Fatal(err)
	}
	for _, ctr := range after.Spec.Template.Spec.Containers {
		for _, e := range ctr.Env {
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
				t.Errorf("container %s got secret env %s: the refused spec reached the workload", ctr.Name, e.Name)
			}
		}
	}
}

func TestCrossAppSecretRefNeverCreatesAWorkload(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Runtime.Env = []corev1.EnvVar{secretRefEnv("app-victim-secrets")}
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app) // nil Recorder must be fine
	err := c.Get(context.Background(), types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, &appsv1.Deployment{})
	if !apierrors.IsNotFound(err) {
		t.Errorf("Deployment lookup = %v, want NotFound", err)
	}
}
