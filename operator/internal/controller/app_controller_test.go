package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

const testDomain = "apps.nebari.local"

func newTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	if err := appsv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	s.AddKnownTypeWithName(NebariAppGVK, &unstructured.Unstructured{})
	s.AddKnownTypeWithName(NebariAppGVK.GroupVersion().WithKind("NebariAppList"), &unstructured.UnstructuredList{})
	return s
}

func managedNamespace(name string) *corev1.Namespace {
	return &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: map[string]string{managedNamespaceLabel: "true"},
		},
	}
}

func inlineApp(ns string) *appsv1alpha1.App {
	return &appsv1alpha1.App{
		ObjectMeta: metav1.ObjectMeta{Name: "docs-site", Namespace: ns, Generation: 1},
		Spec: appsv1alpha1.AppSpec{
			DisplayName: "Docs Site",
			Source: appsv1alpha1.AppSource{
				Type:   appsv1alpha1.SourceTypeInline,
				Inline: &appsv1alpha1.InlineSource{Files: map[string]string{"index.html": "<h1>hi</h1>"}},
			},
			Access: appsv1alpha1.AppAccess{Public: true, Subdomain: "docs-site"},
		},
	}
}

func newReconciler(t *testing.T, objs ...client.Object) (*AppReconciler, client.Client) {
	t.Helper()
	s := newTestScheme(t)
	c := fake.NewClientBuilder().
		WithScheme(s).
		WithObjects(objs...).
		WithStatusSubresource(&appsv1alpha1.App{}).
		Build()
	r := &AppReconciler{
		Client: c,
		Scheme: s,
		Config: OperatorConfig{
			AppsDomain:    testDomain,
			Gateway:       "public",
			StaticImage:   "nginxinc/nginx-unprivileged:1.27-alpine",
			GitImage:      "alpine/git:v2.47.2",
		},
	}
	return r, c
}

func reconcile(t *testing.T, r *AppReconciler, app *appsv1alpha1.App) {
	t.Helper()
	_, err := r.Reconcile(context.Background(), ctrl.Request{
		NamespacedName: types.NamespacedName{Name: app.Name, Namespace: app.Namespace},
	})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func getApp(t *testing.T, c client.Client, name, ns string) *appsv1alpha1.App {
	t.Helper()
	app := &appsv1alpha1.App{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: name, Namespace: ns}, app); err != nil {
		t.Fatalf("get app: %v", err)
	}
	return app
}

func TestReconcileInlineStaticApp(t *testing.T) {
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	ctx := context.Background()

	cm := &corev1.ConfigMap{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site-content", Namespace: "team-a"}, cm); err != nil {
		t.Fatalf("content ConfigMap not created: %v", err)
	}
	if cm.Data["index.html"] != "<h1>hi</h1>" {
		t.Errorf("ConfigMap content mismatch: %q", cm.Data["index.html"])
	}

	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	if len(deploy.OwnerReferences) != 1 || deploy.OwnerReferences[0].Kind != "App" {
		t.Errorf("Deployment missing App ownerReference: %+v", deploy.OwnerReferences)
	}
	if deploy.Spec.Template.Annotations["apps.nebari.dev/content-checksum"] == "" {
		t.Error("expected content checksum annotation on pod template")
	}
	sc := deploy.Spec.Template.Spec.SecurityContext
	if sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Error("pod must run as non-root")
	}

	svc := &corev1.Service{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, svc); err != nil {
		t.Fatalf("Service not created: %v", err)
	}
	if svc.Spec.Ports[0].Port != AppPort {
		t.Errorf("Service port = %d, want %d", svc.Spec.Ports[0].Port, AppPort)
	}

	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, na); err != nil {
		t.Fatalf("NebariApp not created: %v", err)
	}

	got := getApp(t, c, "docs-site", "team-a")
	if got.Status.Phase != appsv1alpha1.AppPhaseDeploying {
		t.Errorf("phase = %q, want Deploying", got.Status.Phase)
	}
	if got.Status.URL != "https://docs-site.apps.nebari.local" {
		t.Errorf("url = %q", got.Status.URL)
	}
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Error("Validated condition should be True")
	}
}

func TestReconcileRunningWhenChildrenReady(t *testing.T) {
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	ctx := context.Background()

	// Simulate the Deployment becoming ready.
	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatal(err)
	}
	deploy.Status.ReadyReplicas = 1
	if err := c.Status().Update(ctx, deploy); err != nil {
		t.Fatal(err)
	}

	// Simulate the nebari-operator marking the NebariApp Ready.
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, na); err != nil {
		t.Fatal(err)
	}
	_ = unstructured.SetNestedSlice(na.Object, []any{
		map[string]any{"type": "Ready", "status": "True", "reason": "ReconcileSuccess"},
	}, "status", "conditions")
	if err := c.Update(ctx, na); err != nil {
		t.Fatal(err)
	}

	reconcile(t, r, app)

	got := getApp(t, c, "docs-site", "team-a")
	if got.Status.Phase != appsv1alpha1.AppPhaseRunning {
		t.Errorf("phase = %q, want Running (conditions: %+v)", got.Status.Phase, got.Status.Conditions)
	}
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionWorkloadReady) {
		t.Error("WorkloadReady should be True")
	}
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionRoutingReady) {
		t.Error("RoutingReady should be True")
	}
}

func TestReconcileRejectsUnmanagedNamespace(t *testing.T) {
	app := inlineApp("team-b")
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "team-b"}}
	r, c := newReconciler(t, ns, app)
	reconcile(t, r, app)

	got := getApp(t, c, "docs-site", "team-b")
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed {
		t.Errorf("phase = %q, want Failed", got.Status.Phase)
	}
	if meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Error("Validated should be False")
	}

	// No children should have been created.
	deploy := &appsv1.Deployment{}
	err := c.Get(context.Background(), types.NamespacedName{Name: "app-docs-site", Namespace: "team-b"}, deploy)
	if err == nil {
		t.Error("Deployment should not exist for an invalid App")
	}
}

func TestReconcileRejectsIncompleteSource(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypeGit}
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	got := getApp(t, c, "docs-site", "team-a")
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed {
		t.Errorf("phase = %q, want Failed (git source requires url)", got.Status.Phase)
	}
	if meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Error("Validated should be False")
	}
}

func TestReconcileGitSource(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Source = appsv1alpha1.AppSource{
		Type: appsv1alpha1.SourceTypeGit,
		Git:  &appsv1alpha1.GitSource{URL: "https://github.com/example/site", Ref: "v1.0", Subdir: "public"},
	}
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	deploy := &appsv1.Deployment{}
	if err := c.Get(context.Background(), types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	inits := deploy.Spec.Template.Spec.InitContainers
	if len(inits) != 1 || inits[0].Name != "git-clone" {
		t.Fatalf("expected git-clone init container, got %+v", inits)
	}
	env := map[string]string{}
	for _, e := range inits[0].Env {
		env[e.Name] = e.Value
	}
	if env["GIT_URL"] != "https://github.com/example/site" || env["GIT_REF"] != "v1.0" || env["GIT_SUBDIR"] != "public" {
		t.Errorf("git env mismatch: %+v", env)
	}
}

func TestReconcileStoppedAtZeroReplicas(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Runtime.Replicas = ptr.To(int32(0))
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	got := getApp(t, c, "docs-site", "team-a")
	if got.Status.Phase != appsv1alpha1.AppPhaseStopped {
		t.Errorf("phase = %q, want Stopped", got.Status.Phase)
	}
}

func TestInlineContentChangeRollsPods(t *testing.T) {
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	ctx := context.Background()
	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatal(err)
	}
	before := deploy.Spec.Template.Annotations["apps.nebari.dev/content-checksum"]

	// Change the content and reconcile again.
	got := getApp(t, c, "docs-site", "team-a")
	got.Spec.Source.Inline.Files["index.html"] = "<h1>changed</h1>"
	if err := c.Update(ctx, got); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, app)

	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatal(err)
	}
	after := deploy.Spec.Template.Annotations["apps.nebari.dev/content-checksum"]
	if before == after {
		t.Error("content checksum should change when inline files change")
	}

	cm := &corev1.ConfigMap{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site-content", Namespace: "team-a"}, cm); err != nil {
		t.Fatal(err)
	}
	if cm.Data["index.html"] != "<h1>changed</h1>" {
		t.Errorf("ConfigMap not updated: %q", cm.Data["index.html"])
	}
}
