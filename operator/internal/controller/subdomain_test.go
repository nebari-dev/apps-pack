package controller

import (
	"context"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func appWithSubdomain(name, ns, sub string, created time.Time) *appsv1alpha1.App {
	app := inlineApp(ns)
	app.Name = name
	app.Spec.Access.Subdomain = sub
	app.CreationTimestamp = metav1.NewTime(created)
	return app
}

func nebariAppExists(t *testing.T, r *AppReconciler, app *appsv1alpha1.App) bool {
	t.Helper()
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	err := r.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, na)
	return err == nil
}

func TestReconcileRejectsDuplicateSubdomain(t *testing.T) {
	now := time.Now()
	older := appWithSubdomain("first", "team-a", "shared", now.Add(-time.Hour))
	newer := appWithSubdomain("second", "team-b", "shared", now)
	r, c := newReconciler(t, managedNamespace("team-a"), managedNamespace("team-b"), older, newer)

	reconcile(t, r, older)
	reconcile(t, r, newer)

	if got := getApp(t, c, "first", "team-a"); got.Status.Phase == appsv1alpha1.AppPhaseFailed {
		t.Fatalf("older app should keep the subdomain, got Failed: %s", got.Status.Message)
	}
	got := getApp(t, c, "second", "team-b")
	if got.Status.Phase != appsv1alpha1.AppPhaseFailed {
		t.Fatalf("phase = %q, want Failed", got.Status.Phase)
	}
	cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionValidated)
	if cond == nil || cond.Status != metav1.ConditionFalse || cond.Reason != "SubdomainTaken" {
		t.Fatalf("Validated condition = %+v, want False/SubdomainTaken", cond)
	}
	if !nebariAppExists(t, r, older) {
		t.Error("holder's NebariApp missing")
	}
	if nebariAppExists(t, r, newer) {
		t.Error("losing app must not emit a NebariApp for the shared hostname")
	}
	if got.Labels[SubdomainLabel] != "shared" {
		t.Errorf("subdomain label = %q", got.Labels[SubdomainLabel])
	}
}

// An App that already emitted a NebariApp before a duplicate appeared (e.g.
// created by the old operator) drops it once it loses.
func TestLosingAppReleasesExistingNebariApp(t *testing.T) {
	now := time.Now()
	older := appWithSubdomain("first", "team-a", "shared", now.Add(-time.Hour))
	newer := appWithSubdomain("second", "team-a", "shared", now)
	r, c := newReconciler(t, managedNamespace("team-a"), newer)
	reconcile(t, r, newer) // alone: it wins and gets a NebariApp
	if !nebariAppExists(t, r, newer) {
		t.Fatal("expected NebariApp while alone")
	}
	if err := c.Create(context.Background(), older); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, getApp(t, c, "second", "team-a"))
	if nebariAppExists(t, r, newer) {
		t.Error("losing app kept its NebariApp")
	}
}

func TestLoserRequeuedWhenHolderChanges(t *testing.T) {
	now := time.Now()
	older := appWithSubdomain("first", "team-a", "shared", now.Add(-time.Hour))
	newer := appWithSubdomain("second", "team-b", "shared", now)
	other := appWithSubdomain("third", "team-b", "elsewhere", now)
	r, _ := newReconciler(t, managedNamespace("team-a"), managedNamespace("team-b"), older, newer, other)

	reqs := r.appsSharingSubdomain(context.Background(), older)
	if len(reqs) != 1 || reqs[0].Name != "second" || reqs[0].Namespace != "team-b" {
		t.Fatalf("requeue = %+v, want only team-b/second", reqs)
	}
}

func TestSubdomainFreedAfterHolderDeleted(t *testing.T) {
	now := time.Now()
	older := appWithSubdomain("first", "team-a", "shared", now.Add(-time.Hour))
	newer := appWithSubdomain("second", "team-a", "shared", now)
	r, c := newReconciler(t, managedNamespace("team-a"), older, newer)
	reconcile(t, r, newer)
	if getApp(t, c, "second", "team-a").Status.Phase != appsv1alpha1.AppPhaseFailed {
		t.Fatal("expected Failed while the holder exists")
	}
	if err := c.Delete(context.Background(), getApp(t, c, "first", "team-a")); err != nil {
		t.Fatal(err)
	}
	reconcile(t, r, newer)
	if got := getApp(t, c, "second", "team-a"); got.Status.Phase == appsv1alpha1.AppPhaseFailed {
		t.Fatalf("still Failed after the holder was deleted: %s", got.Status.Message)
	}
	if !nebariAppExists(t, r, newer) {
		t.Error("NebariApp not created after the subdomain was freed")
	}
}
