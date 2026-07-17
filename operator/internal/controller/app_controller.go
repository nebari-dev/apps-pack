package controller

import (
	"context"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// managedNamespaceLabel opts a namespace into Nebari management. It is the
// same label the nebari-operator requires, so an App and its NebariApp share
// one tenancy boundary.
const managedNamespaceLabel = "nebari.dev/managed"

// OperatorConfig is cluster-level configuration the operator is deployed with.
type OperatorConfig struct {
	// AppsDomain is the domain apps are exposed under:
	// https://<subdomain>.<AppsDomain>. Conventionally apps.<cluster-domain>,
	// e.g. my-app.apps.example.ai.
	AppsDomain string
	// Gateway is the shared Gateway NebariApps attach to (public|internal).
	Gateway string
	// StaticImage serves static app content. Must listen on AppPort as a
	// non-root user (default: nginxinc/nginx-unprivileged).
	StaticImage string
	// GitImage is used by init containers to fetch git sources.
	GitImage string
	// PythonImage runs Python/pixi apps (runtime.pixiTask). Must provide the
	// `pixi` binary and be runnable as a non-root user.
	PythonImage string
	// TLSDisabled serves apps over plain HTTP: emitted NebariApps set
	// routing.tls.enabled=false and status URLs use http://.
	TLSDisabled bool
}

// Scheme returns the URL scheme apps are served with.
func (c OperatorConfig) Scheme() string {
	if c.TLSDisabled {
		return "http"
	}
	return "https"
}

// AppReconciler reconciles an App into a Deployment, Service, and NebariApp.
type AppReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config OperatorConfig
}

// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services;configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups=reconcilers.nebari.dev,resources=nebariapps,verbs=get;list;watch;create;update;patch;delete

// Reconcile drives an App through the validate → workload → service →
// routing → status pipeline.
func (r *AppReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	app := &appsv1alpha1.App{}
	if err := r.Get(ctx, req.NamespacedName, app); err != nil {
		// Deleted: children are garbage-collected via ownerReferences.
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	orig := app.DeepCopy()
	app.Status.ObservedGeneration = app.Generation

	reconcileErr := r.reconcileApp(ctx, app)
	if reconcileErr != nil {
		log.Error(reconcileErr, "reconcile failed")
	}

	if err := r.updateStatus(ctx, orig, app); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, reconcileErr
}

func (r *AppReconciler) reconcileApp(ctx context.Context, app *appsv1alpha1.App) error {
	// 1. Validate.
	if err := r.validate(ctx, app); err != nil {
		setCondition(app, appsv1alpha1.ConditionValidated, metav1.ConditionFalse, "ValidationFailed", err.Error())
		app.Status.Phase = appsv1alpha1.AppPhaseFailed
		app.Status.Message = err.Error()
		// Invalid specs are terminal until the spec changes; don't requeue-error.
		return nil
	}
	setCondition(app, appsv1alpha1.ConditionValidated, metav1.ConditionTrue, "ValidationSucceeded", "spec is valid")

	// 2. Workload content (inline sources materialize as a ConfigMap).
	if cm := buildContentConfigMap(app); cm != nil {
		if err := r.apply(ctx, app, cm, func(existing, desired client.Object) {
			existing.(*corev1.ConfigMap).Data = desired.(*corev1.ConfigMap).Data
		}); err != nil {
			return fmt.Errorf("reconciling content ConfigMap: %w", err)
		}
	}

	// 3. Workload.
	deploy, err := r.buildDeployment(app)
	if err != nil {
		return err
	}
	if err := r.apply(ctx, app, deploy, func(existing, desired client.Object) {
		existing.(*appsv1.Deployment).Spec = desired.(*appsv1.Deployment).Spec
	}); err != nil {
		return fmt.Errorf("reconciling Deployment: %w", err)
	}

	// 4. Service.
	svc := buildService(app)
	if err := r.apply(ctx, app, svc, func(existing, desired client.Object) {
		e, d := existing.(*corev1.Service), desired.(*corev1.Service)
		e.Spec.Selector = d.Spec.Selector
		e.Spec.Ports = d.Spec.Ports
		e.Spec.Type = d.Spec.Type
	}); err != nil {
		return fmt.Errorf("reconciling Service: %w", err)
	}

	// 5. Routing/auth/landing via NebariApp.
	nebariApp := r.buildNebariApp(app)
	if err := r.apply(ctx, app, nebariApp, func(existing, desired client.Object) {
		e, d := existing.(*unstructured.Unstructured), desired.(*unstructured.Unstructured)
		e.Object["spec"] = d.Object["spec"]
	}); err != nil {
		return fmt.Errorf("reconciling NebariApp: %w", err)
	}

	// 6. Status aggregation.
	return r.aggregateStatus(ctx, app)
}

// validate checks that the App can be reconciled at all.
func (r *AppReconciler) validate(ctx context.Context, app *appsv1alpha1.App) error {
	ns := &corev1.Namespace{}
	if err := r.Get(ctx, types.NamespacedName{Name: app.Namespace}, ns); err != nil {
		return fmt.Errorf("reading namespace %q: %w", app.Namespace, err)
	}
	if ns.Labels[managedNamespaceLabel] != "true" {
		return fmt.Errorf("namespace %q is not opted in: label %s=true is required",
			app.Namespace, managedNamespaceLabel)
	}

	switch app.Spec.Source.Type {
	case appsv1alpha1.SourceTypeInline:
		if app.Spec.Source.Inline == nil || len(app.Spec.Source.Inline.Files) == 0 {
			return fmt.Errorf("source.inline.files is required for source type inline")
		}
		// File paths become volume item paths, which must stay relative and
		// inside the mount.
		for p := range app.Spec.Source.Inline.Files {
			if strings.HasPrefix(p, "/") || strings.Contains(p, "..") {
				return fmt.Errorf("source.inline.files: path %q must be relative and must not contain '..'", p)
			}
		}
	case appsv1alpha1.SourceTypeGit:
		if app.Spec.Source.Git == nil || app.Spec.Source.Git.URL == "" {
			return fmt.Errorf("source.git.url is required for source type git")
		}
		if strings.Contains(app.Spec.Source.Git.Subdir, "..") {
			return fmt.Errorf("source.git.subdir must not contain '..'")
		}
	case appsv1alpha1.SourceTypePVC:
		if app.Spec.Source.PVC == nil || app.Spec.Source.PVC.ClaimName == "" {
			return fmt.Errorf("source.pvc.claimName is required for source type pvc")
		}
	default:
		return fmt.Errorf("unknown source type %q", app.Spec.Source.Type)
	}

	if app.Spec.Access.Subdomain == "" {
		return fmt.Errorf("access.subdomain is required")
	}
	return nil
}

// apply creates obj or updates the existing object via the mutate callback,
// always setting the App as controller owner for garbage collection.
func (r *AppReconciler) apply(ctx context.Context, app *appsv1alpha1.App, obj client.Object,
	mutate func(existing, desired client.Object)) error {

	if err := controllerutil.SetControllerReference(app, obj, r.Scheme); err != nil {
		return err
	}

	existing := obj.DeepCopyObject().(client.Object)
	err := r.Get(ctx, client.ObjectKeyFromObject(obj), existing)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, obj)
	}
	if err != nil {
		return err
	}

	mutate(existing, obj)
	existing.SetLabels(obj.GetLabels())
	if err := controllerutil.SetControllerReference(app, existing, r.Scheme); err != nil {
		return err
	}
	return r.Update(ctx, existing)
}

// SetupWithManager wires the controller: it owns the Deployment, Service,
// ConfigMap, and NebariApp it creates, so changes to any of them requeue the
// parent App.
func (r *AppReconciler) SetupWithManager(mgr ctrl.Manager) error {
	nebariApp := &unstructured.Unstructured{}
	nebariApp.SetGroupVersionKind(NebariAppGVK)

	return ctrl.NewControllerManagedBy(mgr).
		For(&appsv1alpha1.App{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.ConfigMap{}).
		Owns(nebariApp).
		Named("app").
		Complete(r)
}

func intstrFromString(s string) intstr.IntOrString {
	return intstr.FromString(s)
}
