package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func renderedPod(t *testing.T, app *appsv1alpha1.App) corev1.PodSpec {
	t.Helper()
	r, c := newReconciler(t, managedNamespace(app.Namespace), app)
	reconcile(t, r, app)
	deploy := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, deploy); err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	return deploy.Spec.Template.Spec
}

func assertBounded(t *testing.T, what string, rr corev1.ResourceRequirements) {
	t.Helper()
	for _, n := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		if _, ok := rr.Requests[n]; !ok {
			t.Errorf("%s: no %s request", what, n)
		}
		if _, ok := rr.Limits[n]; !ok {
			t.Errorf("%s: no %s limit", what, n)
		}
	}
}

// Every launched container, init containers included, is bounded, and app
// pods never mount a ServiceAccount token.
func TestLaunchedPodsAreBoundedAndTokenless(t *testing.T) {
	git := inlineApp("team-a")
	git.Name = "git-site"
	git.Spec.Source = appsv1alpha1.AppSource{
		Type: appsv1alpha1.SourceTypeGit,
		Git:  &appsv1alpha1.GitSource{URL: "https://github.com/example/site"},
	}
	for _, app := range []*appsv1alpha1.App{inlineApp("team-a"), pixiApp("team-a"), git} {
		pod := renderedPod(t, app)
		if pod.AutomountServiceAccountToken == nil || *pod.AutomountServiceAccountToken {
			t.Errorf("%s: AutomountServiceAccountToken = %v, want false", app.Name, pod.AutomountServiceAccountToken)
		}
		for _, c := range pod.Containers {
			assertBounded(t, app.Name+"/"+c.Name, c.Resources)
		}
		for _, c := range pod.InitContainers {
			assertBounded(t, app.Name+"/init "+c.Name, c.Resources)
		}
	}
}

func TestPythonAppsGetPythonDefaults(t *testing.T) {
	pod := renderedPod(t, pixiApp("team-a"))
	got := pod.Containers[0].Resources.Limits[corev1.ResourceMemory]
	if want := DefaultPythonResources.Limits[corev1.ResourceMemory]; got.Cmp(want) != 0 {
		t.Errorf("pixi memory limit = %s, want %s", got.String(), want.String())
	}
}

func TestExplicitResourcesKeptAndGapsFilled(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Runtime.Resources = corev1.ResourceRequirements{
		// A request above the default limit: the filled limit must not undercut it.
		Requests: corev1.ResourceList{corev1.ResourceMemory: resource.MustParse("1Gi")},
		Limits:   corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m")},
	}
	rr := renderedPod(t, app).Containers[0].Resources
	if q := rr.Requests[corev1.ResourceMemory]; q.String() != "1Gi" {
		t.Errorf("memory request = %s, want the App's 1Gi", q.String())
	}
	if q := rr.Limits[corev1.ResourceMemory]; q.String() != "1Gi" {
		t.Errorf("memory limit = %s, want raised to the 1Gi request", q.String())
	}
	if q := rr.Limits[corev1.ResourceCPU]; q.String() != "100m" {
		t.Errorf("cpu limit = %s, want the App's 100m", q.String())
	}
	if q := rr.Requests[corev1.ResourceCPU]; q.String() != "50m" {
		t.Errorf("cpu request = %s, want the 50m default (under the App's limit)", q.String())
	}
}

func TestParseResources(t *testing.T) {
	rr, err := ParseResources(`{"requests":{"cpu":"10m"},"limits":{"memory":"64Mi"}}`, DefaultStaticResources)
	if err != nil {
		t.Fatal(err)
	}
	if q := rr.Requests[corev1.ResourceCPU]; q.String() != "10m" {
		t.Errorf("cpu = %s", q.String())
	}
	if rr, _ := ParseResources("", DefaultPythonResources); rr.Limits.Memory().String() != "2Gi" {
		t.Errorf("empty input should return the fallback")
	}
	if _, err := ParseResources("{nope", DefaultStaticResources); err == nil {
		t.Error("want error for invalid JSON")
	}
}
