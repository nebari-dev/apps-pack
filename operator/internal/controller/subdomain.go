package controller

import (
	"context"
	"errors"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlreconcile "sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// SubdomainLabel mirrors spec.access.subdomain on every App so a hostname can
// be looked up with a label selector (`kubectl get apps -A -l ...`).
const SubdomainLabel = "apps.nebari.dev/subdomain"

// errSubdomainTaken marks a validation failure caused by another App holding
// the same subdomain.
type errSubdomainTaken struct{ holder string }

func (e errSubdomainTaken) Error() string {
	return fmt.Sprintf("access.subdomain is already used by app %s", e.holder)
}

func isSubdomainTaken(err error) bool {
	var t errSubdomainTaken
	return errors.As(err, &t)
}

// holdsBefore orders Apps competing for one subdomain: the oldest App keeps
// it, ties broken by namespace/name, so the winner never flips.
func holdsBefore(a, b *appsv1alpha1.App) bool {
	if !a.CreationTimestamp.Equal(&b.CreationTimestamp) {
		return a.CreationTimestamp.Before(&b.CreationTimestamp)
	}
	if a.Namespace != b.Namespace {
		return a.Namespace < b.Namespace
	}
	return a.Name < b.Name
}

// checkSubdomain fails when an older App, in any namespace, already claims
// app's subdomain. Apps being deleted no longer hold it.
func (r *AppReconciler) checkSubdomain(ctx context.Context, app *appsv1alpha1.App) error {
	apps := &appsv1alpha1.AppList{}
	if err := r.List(ctx, apps); err != nil {
		return fmt.Errorf("listing apps: %w", err)
	}
	for i := range apps.Items {
		other := &apps.Items[i]
		if (other.UID != "" && other.UID == app.UID) || (other.Namespace == app.Namespace && other.Name == app.Name) {
			continue
		}
		if other.DeletionTimestamp != nil || other.Spec.Access.Subdomain != app.Spec.Access.Subdomain {
			continue
		}
		if holdsBefore(other, app) {
			return errSubdomainTaken{holder: other.Namespace + "/" + other.Name}
		}
	}
	return nil
}

// ensureSubdomainLabel keeps the subdomain label in sync with the spec.
func (r *AppReconciler) ensureSubdomainLabel(ctx context.Context, app *appsv1alpha1.App) error {
	want := app.Spec.Access.Subdomain
	if want == "" || app.Labels[SubdomainLabel] == want {
		return nil
	}
	patch := client.MergeFrom(app.DeepCopy())
	if app.Labels == nil {
		app.Labels = map[string]string{}
	}
	app.Labels[SubdomainLabel] = want
	return r.Patch(ctx, app, patch)
}

// releaseHostname deletes the App's NebariApp so a losing App stops
// competing for the hostname the winner is routed on.
func (r *AppReconciler) releaseHostname(ctx context.Context, app *appsv1alpha1.App) error {
	na := &unstructured.Unstructured{}
	na.SetGroupVersionKind(NebariAppGVK)
	err := r.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, na)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return client.IgnoreNotFound(r.Delete(ctx, na))
}

// appsSharingSubdomain re-queues every other App that claims the same
// subdomain as obj, so a losing App is re-validated when the holder is
// deleted or changes.
func (r *AppReconciler) appsSharingSubdomain(ctx context.Context, obj client.Object) []ctrlreconcile.Request {
	app, ok := obj.(*appsv1alpha1.App)
	if !ok || app.Spec.Access.Subdomain == "" {
		return nil
	}
	apps := &appsv1alpha1.AppList{}
	if err := r.List(ctx, apps); err != nil {
		return nil
	}
	var reqs []ctrlreconcile.Request
	for _, other := range apps.Items {
		if other.Spec.Access.Subdomain != app.Spec.Access.Subdomain ||
			(other.Namespace == app.Namespace && other.Name == app.Name) {
			continue
		}
		reqs = append(reqs, ctrlreconcile.Request{NamespacedName: types.NamespacedName{
			Namespace: other.Namespace, Name: other.Name,
		}})
	}
	return reqs
}
