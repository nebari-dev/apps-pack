package controller

import (
	"context"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// The phase machine: every edge between Deploying, Running, Stopped and
// Failed, driven the way the cluster drives it (Deployment status from the
// deployment controller, the NebariApp's Ready condition from the
// nebari-operator, spec edits from users).

type deployStatus struct{ replicas, updated, ready int32 }

// setDeployment writes the Deployment's status as the deployment controller
// would, having observed the current template.
func setDeployment(t *testing.T, c client.Client, app *appsv1alpha1.App, s deployStatus) {
	t.Helper()
	ctx := context.Background()
	d := &appsv1.Deployment{}
	if err := c.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, d); err != nil {
		t.Fatal(err)
	}
	d.Status = appsv1.DeploymentStatus{
		ObservedGeneration: d.Generation,
		Replicas:           s.replicas,
		UpdatedReplicas:    s.updated,
		ReadyReplicas:      s.ready,
		AvailableReplicas:  s.ready,
	}
	if err := c.Status().Update(ctx, d); err != nil {
		t.Fatal(err)
	}
}

func setRoutingReady(t *testing.T, c client.Client, app *appsv1alpha1.App, ready bool) {
	t.Helper()
	ctx := context.Background()
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	if err := c.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, na); err != nil {
		t.Fatal(err)
	}
	status := "False"
	if ready {
		status = "True"
	}
	_ = unstructured.SetNestedSlice(na.Object, []any{
		map[string]any{"type": "Ready", "status": status, "reason": "Test", "message": "routing " + status},
	}, "status", "conditions")
	if err := c.Update(ctx, na); err != nil {
		t.Fatal(err)
	}
}

// editSpec applies a user edit; the apiserver bumps metadata.generation.
func editSpec(t *testing.T, c client.Client, app *appsv1alpha1.App, mutate func(*appsv1alpha1.AppSpec)) {
	t.Helper()
	got := getApp(t, c, app.Name, app.Namespace)
	mutate(&got.Spec)
	got.Generation++
	if err := c.Update(context.Background(), got); err != nil {
		t.Fatal(err)
	}
}

func wantPhase(t *testing.T, c client.Client, app *appsv1alpha1.App, want appsv1alpha1.AppPhase) *appsv1alpha1.App {
	t.Helper()
	got := getApp(t, c, app.Name, app.Namespace)
	if got.Status.Phase != want {
		t.Fatalf("phase = %q, want %q (message %q, conditions %+v)", got.Status.Phase, want, got.Status.Message, got.Status.Conditions)
	}
	return got
}

// runningApp reconciles a fresh App through Deploying to Running.
func runningApp(t *testing.T) (*AppReconciler, client.Client, *appsv1alpha1.App) {
	t.Helper()
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	setRoutingReady(t, c, app, true)
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
	return r, c, app
}

func TestPhaseDeployingUntilBothWorkloadAndRoutingAreReady(t *testing.T) {
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	reconcile(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionWorkloadReady) {
		t.Error("WorkloadReady should be True once the replica is ready")
	}

	setRoutingReady(t, c, app, true)
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
}

func TestPhaseRunningToDeployingDuringRollout(t *testing.T) {
	r, c, app := runningApp(t)

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) {
		s.Source.Inline.Files["index.html"] = "<h1>v2</h1>"
	})
	reconcile(t, r, app)
	// The old pod is still ready while the new one starts (maxSurge).
	setDeployment(t, c, app, deployStatus{replicas: 2, updated: 1, ready: 1})
	reconcile(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	if meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionWorkloadReady) {
		t.Error("WorkloadReady should be False while old pods remain")
	}

	// The new pod is ready and the old one is gone.
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
}

func TestPhaseRunningToDeployingWhenAReplicaFails(t *testing.T) {
	r, c, app := runningApp(t)
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 0})
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
}

func TestPhaseRunningToDeployingWhenRoutingDrops(t *testing.T) {
	r, c, app := runningApp(t)
	setRoutingReady(t, c, app, false)
	reconcile(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	cond := meta.FindStatusCondition(got.Status.Conditions, appsv1alpha1.ConditionRoutingReady)
	if cond == nil || cond.Reason != "NebariAppNotReady" || cond.Message != "routing False" {
		t.Errorf("RoutingReady should carry the NebariApp's reason and message: %+v", cond)
	}
}

func TestPhaseStoppedAndBack(t *testing.T) {
	r, c, app := runningApp(t)

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) { s.Runtime.Replicas = ptr.To(int32(0)) })
	reconcile(t, r, app)
	setDeployment(t, c, app, deployStatus{})
	reconcile(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseStopped)
	if got.Status.Replicas == nil || got.Status.Replicas.Desired != 0 {
		t.Errorf("replicas = %+v, want desired 0", got.Status.Replicas)
	}

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) { s.Runtime.Replicas = ptr.To(int32(1)) })
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	setDeployment(t, c, app, deployStatus{replicas: 1, updated: 1, ready: 1})
	reconcile(t, r, app)
	wantPhase(t, c, app, appsv1alpha1.AppPhaseRunning)
}

func TestPhaseFailedToDeployingOnceTheSpecIsFixed(t *testing.T) {
	r, c, app := runningApp(t)

	// Point the App at an unlabeled PVC: validation fails.
	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) {
		s.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypePVC, PVC: &appsv1alpha1.PVCSource{ClaimName: "missing"}}
	})
	reconcile(t, r, app)
	failed := wantPhase(t, c, app, appsv1alpha1.AppPhaseFailed)
	if meta.IsStatusConditionTrue(failed.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Error("Validated should be False")
	}

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) {
		s.Source = appsv1alpha1.AppSource{
			Type:   appsv1alpha1.SourceTypeInline,
			Inline: &appsv1alpha1.InlineSource{Files: map[string]string{"index.html": "<h1>fixed</h1>"}},
		}
	})
	reconcile(t, r, app)
	setDeployment(t, c, app, deployStatus{replicas: 2, updated: 1, ready: 1})
	reconcile(t, r, app)
	got := wantPhase(t, c, app, appsv1alpha1.AppPhaseDeploying)
	if !meta.IsStatusConditionTrue(got.Status.Conditions, appsv1alpha1.ConditionValidated) {
		t.Error("Validated should be True again")
	}
}

// Conditions say which generation they describe, so a client can tell a
// current WorkloadReady from one left over from before an edit.
func TestConditionsTrackTheGenerationThatSetThem(t *testing.T) {
	r, c, app := runningApp(t)

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) {
		s.Source = appsv1alpha1.AppSource{Type: appsv1alpha1.SourceTypePVC, PVC: &appsv1alpha1.PVCSource{ClaimName: "missing"}}
	})
	reconcile(t, r, app)
	failed := wantPhase(t, c, app, appsv1alpha1.AppPhaseFailed)
	if failed.Status.ObservedGeneration != failed.Generation {
		t.Errorf("observedGeneration = %d, want %d", failed.Status.ObservedGeneration, failed.Generation)
	}
	for _, cond := range failed.Status.Conditions {
		want := failed.Generation - 1 // set while Running; validation stops before re-checking them
		if cond.Type == appsv1alpha1.ConditionValidated {
			want = failed.Generation
		}
		if cond.ObservedGeneration != want {
			t.Errorf("%s observedGeneration = %d, want %d", cond.Type, cond.ObservedGeneration, want)
		}
	}

	editSpec(t, c, app, func(s *appsv1alpha1.AppSpec) {
		s.Source = appsv1alpha1.AppSource{
			Type:   appsv1alpha1.SourceTypeInline,
			Inline: &appsv1alpha1.InlineSource{Files: map[string]string{"index.html": "<h1>fixed</h1>"}},
		}
	})
	reconcile(t, r, app)
	got := getApp(t, c, app.Name, app.Namespace)
	for _, cond := range got.Status.Conditions {
		if cond.ObservedGeneration != got.Generation {
			t.Errorf("after recovery %s observedGeneration = %d, want %d", cond.Type, cond.ObservedGeneration, got.Generation)
		}
	}
}
