package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"

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
