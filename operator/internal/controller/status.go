package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func setCondition(app *appsv1alpha1.App, condType string, status metav1.ConditionStatus, reason, message string) {
	meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type:               condType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: app.Generation,
	})
}

// aggregateStatus reads the children back and folds their state into the
// App's phase, conditions, replica counts, and URL.
func (r *AppReconciler) aggregateStatus(ctx context.Context, app *appsv1alpha1.App) error {
	// Workload readiness.
	deploy := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, deploy)
	if err != nil {
		return client.IgnoreNotFound(err)
	}

	desired := int32(1)
	if deploy.Spec.Replicas != nil {
		desired = *deploy.Spec.Replicas
	}
	ready := deploy.Status.ReadyReplicas
	app.Status.Replicas = &appsv1alpha1.AppReplicas{Desired: desired, Ready: ready}

	workloadReady := desired > 0 && ready >= desired
	if workloadReady {
		setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionTrue,
			"ReplicasReady", fmt.Sprintf("%d/%d replicas ready", ready, desired))
	} else {
		setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionFalse,
			"ReplicasNotReady", fmt.Sprintf("%d/%d replicas ready", ready, desired))
	}

	// Routing readiness mirrors the NebariApp Ready condition.
	routingReady := r.readNebariAppReady(ctx, app)

	app.Status.URL = r.Config.Scheme() + "://" + r.Config.Hostname(app)

	switch {
	case desired == 0:
		app.Status.Phase = appsv1alpha1.AppPhaseStopped
		app.Status.Message = "app is scaled to zero"
	case workloadReady && routingReady:
		app.Status.Phase = appsv1alpha1.AppPhaseRunning
		app.Status.Message = "all replicas ready"
	default:
		app.Status.Phase = appsv1alpha1.AppPhaseDeploying
		app.Status.Message = "waiting for workload and routing to become ready"
	}
	return nil
}

// readNebariAppReady reports whether the child NebariApp has Ready=True, and
// records the RoutingReady condition on the App.
func (r *AppReconciler) readNebariAppReady(ctx context.Context, app *appsv1alpha1.App) bool {
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	err := r.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, na)
	if err != nil {
		reason, msg := "NebariAppMissing", "NebariApp has not been created yet"
		if !apierrors.IsNotFound(err) {
			reason, msg = "NebariAppUnreadable", err.Error()
		}
		setCondition(app, appsv1alpha1.ConditionRoutingReady, metav1.ConditionFalse, reason, msg)
		return false
	}

	conditions, _, _ := unstructured.NestedSlice(na.Object, "status", "conditions")
	for _, c := range conditions {
		cond, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if cond["type"] == "Ready" {
			if cond["status"] == "True" {
				setCondition(app, appsv1alpha1.ConditionRoutingReady, metav1.ConditionTrue,
					"NebariAppReady", "routing, TLS, and auth are configured")
				return true
			}
			msg, _ := cond["message"].(string)
			setCondition(app, appsv1alpha1.ConditionRoutingReady, metav1.ConditionFalse,
				"NebariAppNotReady", msg)
			return false
		}
	}
	setCondition(app, appsv1alpha1.ConditionRoutingReady, metav1.ConditionFalse,
		"NebariAppPending", "NebariApp has not reported a Ready condition yet")
	return false
}

// updateStatus persists status changes if anything actually changed.
func (r *AppReconciler) updateStatus(ctx context.Context, orig, app *appsv1alpha1.App) error {
	if equality.Semantic.DeepEqual(orig.Status, app.Status) {
		return nil
	}
	return r.Status().Update(ctx, app)
}
