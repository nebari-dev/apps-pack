package controller

import (
	"context"
	"fmt"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
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
func (r *AppReconciler) aggregateStatus(ctx context.Context, app *appsv1alpha1.App, idle idleState) error {
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
	prevWorkload := ""
	if c := meta.FindStatusCondition(app.Status.Conditions, appsv1alpha1.ConditionWorkloadReady); c != nil {
		prevWorkload = c.Reason
	}
	app.Status.Replicas = &appsv1alpha1.AppReplicas{Desired: desired, Ready: ready}

	switch {
	case desired > 0 && ready >= desired && rolledOut(deploy, desired):
		setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionTrue,
			"ReplicasReady", fmt.Sprintf("%d/%d replicas ready", ready, desired))
	case desired > 0 && ready >= desired:
		// Old pods still serve while the new template rolls out.
		setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionFalse,
			"RollingOut", fmt.Sprintf("%d/%d replicas updated", deploy.Status.UpdatedReplicas, desired))
	default:
		setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionFalse,
			"ReplicasNotReady", fmt.Sprintf("%d/%d replicas ready", ready, desired))
	}
	workloadReady := meta.IsStatusConditionTrue(app.Status.Conditions, appsv1alpha1.ConditionWorkloadReady)

	// An image the kubelet refuses to start (root user, failed pull) is
	// reported as such rather than as an endless Deploying.
	var problem, problemMsg string
	if isImage(app) && desired > 0 && !workloadReady {
		if problem, problemMsg = r.imagePodProblem(ctx, app); problem != "" {
			if problem != prevWorkload && r.Recorder != nil {
				r.Recorder.Event(app, corev1.EventTypeWarning, problem, problemMsg)
			}
			setCondition(app, appsv1alpha1.ConditionWorkloadReady, metav1.ConditionFalse, problem, problemMsg)
		}
	}

	// Routing readiness mirrors the NebariApp Ready condition.
	routingReady := r.readNebariAppReady(ctx, app)

	app.Status.URL = r.Config.Scheme() + "://" + r.Config.Hostname(app)

	switch {
	case idle.idle:
		app.Status.Phase = appsv1alpha1.AppPhaseIdle
		app.Status.Message = fmt.Sprintf("scaled to zero after %s without requests; the next request to its URL starts it",
			formatMinutes(idle.timeout))
	case desired == 0:
		app.Status.Phase = appsv1alpha1.AppPhaseStopped
		app.Status.Message = "app is scaled to zero"
	case problem != "":
		app.Status.Phase = appsv1alpha1.AppPhaseFailed
		app.Status.Message = problemMsg
	case idle.waking:
		app.Status.Phase = appsv1alpha1.AppPhaseDeploying
		app.Status.Message = "waking up: a request arrived while the app was idle"
	case workloadReady && routingReady && !idle.viaActivator:
		app.Status.Phase = appsv1alpha1.AppPhaseRunning
		app.Status.Message = "all replicas ready"
	default:
		app.Status.Phase = appsv1alpha1.AppPhaseDeploying
		app.Status.Message = "waiting for workload and routing to become ready"
	}
	return nil
}

// rolledOut mirrors `kubectl rollout status`: the deployment controller has
// seen the current template, every desired replica runs it, and no pods of an
// older template remain.
func rolledOut(d *appsv1.Deployment, desired int32) bool {
	s := d.Status
	return s.ObservedGeneration >= d.Generation &&
		s.UpdatedReplicas >= desired &&
		s.Replicas <= s.UpdatedReplicas
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
			// The NebariApp's reason names the cause, such as
			// GroupsNotResolved (an access.groups path missing in Keycloak).
			msg, _ := cond["message"].(string)
			if reason, _ := cond["reason"].(string); reason != "" {
				msg = reason + ": " + msg
			}
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

// formatMinutes renders an idle timeout as "30 minutes".
func formatMinutes(d time.Duration) string {
	m := int(d / time.Minute)
	if m == 1 {
		return "1 minute"
	}
	return fmt.Sprintf("%d minutes", m)
}
