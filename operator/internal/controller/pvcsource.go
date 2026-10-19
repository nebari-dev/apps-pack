package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlreconcile "sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// MountableLabel must be "true" on a PersistentVolumeClaim before an App's
// pvc source may mount it. Without the opt-in, any user could publish a
// team's shared volume on a (possibly public) subdomain.
const MountableLabel = "apps.nebari.dev/mountable"

func (r *AppReconciler) checkMountable(ctx context.Context, app *appsv1alpha1.App) error {
	name := app.Spec.Source.PVC.ClaimName
	pvc := &corev1.PersistentVolumeClaim{}
	err := r.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: name}, pvc)
	if apierrors.IsNotFound(err) {
		return fmt.Errorf("source.pvc: PersistentVolumeClaim %q not found in namespace %q", name, app.Namespace)
	}
	if err != nil {
		return fmt.Errorf("reading PersistentVolumeClaim %q: %w", name, err)
	}
	if pvc.Labels[MountableLabel] != "true" {
		return fmt.Errorf("source.pvc: PersistentVolumeClaim %q is not labeled %s=true; "+
			"its owner must opt in before apps can mount it", name, MountableLabel)
	}
	return nil
}

// appsMountingClaim maps a PVC event to the Apps in its namespace that use it.
func (r *AppReconciler) appsMountingClaim(ctx context.Context, obj client.Object) []ctrlreconcile.Request {
	apps := &appsv1alpha1.AppList{}
	if err := r.List(ctx, apps, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var reqs []ctrlreconcile.Request
	for _, app := range apps.Items {
		src := app.Spec.Source
		if src.Type == appsv1alpha1.SourceTypePVC && src.PVC != nil && src.PVC.ClaimName == obj.GetName() {
			reqs = append(reqs, ctrlreconcile.Request{NamespacedName: types.NamespacedName{
				Namespace: app.Namespace, Name: app.Name,
			}})
		}
	}
	return reqs
}
