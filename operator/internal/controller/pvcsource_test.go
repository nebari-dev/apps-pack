package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func pvcApp(ns, claim string) *appsv1alpha1.App {
	app := inlineApp(ns)
	app.Spec.Source = appsv1alpha1.AppSource{
		Type: appsv1alpha1.SourceTypePVC,
		PVC:  &appsv1alpha1.PVCSource{ClaimName: claim},
	}
	return app
}

func claim(ns, name string, labels map[string]string) *corev1.PersistentVolumeClaim {
	return &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: labels}}
}

func TestReconcileRejectsUnlabeledPVC(t *testing.T) {
	for _, tc := range []struct {
		name string
		objs []*corev1.PersistentVolumeClaim
	}{
		{"unlabeled", []*corev1.PersistentVolumeClaim{claim("team-a", "shared", nil)}},
		{"label false", []*corev1.PersistentVolumeClaim{claim("team-a", "shared", map[string]string{MountableLabel: "false"})}},
		{"missing", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := pvcApp("team-a", "shared")
			r, c := newReconciler(t, managedNamespace("team-a"), app)
			for _, p := range tc.objs {
				if err := c.Create(context.Background(), p); err != nil {
					t.Fatal(err)
				}
			}
			reconcile(t, r, app)
			if got := getApp(t, c, "docs-site", "team-a"); got.Status.Phase != appsv1alpha1.AppPhaseFailed {
				t.Errorf("phase = %q, want Failed", got.Status.Phase)
			}
			deploy := &appsv1.Deployment{}
			if err := c.Get(context.Background(), types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err == nil {
				t.Error("Deployment created for a claim that did not opt in")
			}
		})
	}
}

func TestReconcileMountsLabeledPVC(t *testing.T) {
	app := pvcApp("team-a", "shared")
	r, c := newReconciler(t, managedNamespace("team-a"), app,
		claim("team-a", "shared", map[string]string{MountableLabel: "true"}))
	reconcile(t, r, app)
	if got := getApp(t, c, "docs-site", "team-a"); got.Status.Phase == appsv1alpha1.AppPhaseFailed {
		t.Fatalf("labeled claim rejected: %s", got.Status.Message)
	}
}

func TestClaimEventRequeuesMountingApps(t *testing.T) {
	user := pvcApp("team-a", "shared")
	other := pvcApp("team-a", "other")
	other.Name = "other-app"
	r, _ := newReconciler(t, managedNamespace("team-a"), user, other)
	reqs := r.appsMountingClaim(context.Background(), claim("team-a", "shared", nil))
	if len(reqs) != 1 || reqs[0].Name != "docs-site" {
		t.Fatalf("requeue = %+v, want only docs-site", reqs)
	}
}
