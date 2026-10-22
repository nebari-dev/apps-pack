package controller

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
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
	// LandingPage is the cluster default for registering apps as tiles on
	// the Nebari landing page. An App's spec.landingPage.enabled overrides it.
	LandingPage bool
	// StaticResources and PythonResources fill any cpu/memory request or
	// limit an App leaves unset (static apps vs runtime.pixiTask apps).
	StaticResources corev1.ResourceRequirements
	PythonResources corev1.ResourceRequirements
	// ProxyImage is the apps-proxy sidecar added in front of Apps that can
	// idle and of image Apps (proxy.go).
	ProxyImage string
	// ProxyImagePullPolicy is the sidecar's pull policy (empty: the
	// Kubernetes default).
	ProxyImagePullPolicy corev1.PullPolicy
	// ProxyResources are the sidecar's requests/limits.
	ProxyResources corev1.ResourceRequirements
	// IdleTimeout is the cluster default for scaling an App to zero after
	// it goes this long without a request (0: Apps never idle unless they
	// set runtime.idleTimeoutMinutes). See idle.go.
	IdleTimeout time.Duration
	// ActivatorService and ActivatorNamespace name the Service in front of
	// the operator's activator (activator.go), which idle Apps route to.
	// Idling needs both, and ProxyImage.
	ActivatorService   string
	ActivatorNamespace string
	// ImageRegistries is the normalized allowlist for source type image
	// (ParseRegistryAllowlist; imageref.go has the matching rules). Empty
	// refuses every image App.
	ImageRegistries []string
	// ImagePullSecrets name Secrets in each App namespace that image Apps'
	// pods pull with (private registries).
	ImagePullSecrets []string
}

// LandingPageEnabled reports whether an App should appear on the landing page:
// its own spec.landingPage.enabled when set, else the cluster default.
func (c OperatorConfig) LandingPageEnabled(app *appsv1alpha1.App) bool {
	if app.Spec.LandingPage != nil && app.Spec.LandingPage.Enabled != nil {
		return *app.Spec.LandingPage.Enabled
	}
	return c.LandingPage
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
	// APIReader reads pods and the ReferenceGrant without caching them
	// cluster-wide (mgr.GetAPIReader()); nil uses the Client.
	APIReader client.Reader
	// Recorder emits Events on Apps (nil: none).
	Recorder record.EventRecorder
	// HTTPClient polls app pods' activity (nil: http.DefaultClient);
	// ActivityURL and Now are test hooks.
	HTTPClient  *http.Client
	ActivityURL func(podIP string) string
	Now         func() time.Time
}

// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps.nebari.dev,resources=apps/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services;configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=referencegrants,verbs=get;create;update
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

	if err := r.ensureSubdomainLabel(ctx, app); err != nil {
		return ctrl.Result{}, fmt.Errorf("labeling app with its subdomain: %w", err)
	}

	orig := app.DeepCopy()
	app.Status.ObservedGeneration = app.Generation

	requeue, reconcileErr := r.reconcileApp(ctx, app)
	if reconcileErr != nil {
		log.Error(reconcileErr, "reconcile failed")
	}

	if err := r.updateStatus(ctx, orig, app); err != nil {
		return ctrl.Result{}, err
	}
	if reconcileErr != nil {
		return ctrl.Result{}, reconcileErr
	}
	// An App that can idle is checked again before its idle timeout runs out.
	return ctrl.Result{RequeueAfter: requeue}, nil
}

func (r *AppReconciler) reconcileApp(ctx context.Context, app *appsv1alpha1.App) (time.Duration, error) {
	st, err := r.reconcileChildren(ctx, app)
	return st.requeue, err
}

func (r *AppReconciler) reconcileChildren(ctx context.Context, app *appsv1alpha1.App) (idleState, error) {
	// 1. Validate.
	if err := r.validate(ctx, app); err != nil {
		reason := "ValidationFailed"
		if isForbiddenEnvRef(err) {
			// The workload is left as it was: a spec that would read another
			// App's data never reaches a pod.
			reason = ForbiddenEnvReference
			if r.Recorder != nil {
				r.Recorder.Event(app, corev1.EventTypeWarning, reason, err.Error())
			}
		}
		if isImageNotAllowed(err) {
			// The allowlist is the boundary for kubectl and GitOps authors
			// too: an image App outside it (or one left behind when the
			// allowlist shrinks) runs no pods.
			reason = appsv1alpha1.ReasonImageNotAllowed
			if r.Recorder != nil {
				r.Recorder.Event(app, corev1.EventTypeWarning, reason, err.Error())
			}
			if serr := r.stopWorkload(ctx, app); serr != nil {
				return idleState{}, fmt.Errorf("scaling down a disallowed image: %w", serr)
			}
		}
		if isSubdomainTaken(err) {
			reason = "SubdomainTaken"
			if rerr := r.releaseHostname(ctx, app); rerr != nil {
				return idleState{}, fmt.Errorf("releasing hostname: %w", rerr)
			}
		}
		setCondition(app, appsv1alpha1.ConditionValidated, metav1.ConditionFalse, reason, err.Error())
		app.Status.Phase = appsv1alpha1.AppPhaseFailed
		app.Status.Message = err.Error()
		app.Status.LastActivityTime = nil
		// Invalid specs are terminal until the spec changes; don't requeue-error.
		return idleState{}, nil
	}
	setCondition(app, appsv1alpha1.ConditionValidated, metav1.ConditionTrue, "ValidationSucceeded", "spec is valid")

	// 2. Workload content (inline sources materialize as a ConfigMap) and,
	// for static apps, the nginx server config.
	if cm := buildContentConfigMap(app); cm != nil {
		if err := r.apply(ctx, app, cm, func(existing, desired client.Object) {
			existing.(*corev1.ConfigMap).Data = desired.(*corev1.ConfigMap).Data
		}); err != nil {
			return idleState{}, fmt.Errorf("reconciling content ConfigMap: %w", err)
		}
	}
	if cm := r.Config.buildServerConfigMap(app); cm != nil {
		if err := r.apply(ctx, app, cm, func(existing, desired client.Object) {
			existing.(*corev1.ConfigMap).Data = desired.(*corev1.ConfigMap).Data
		}); err != nil {
			return idleState{}, fmt.Errorf("reconciling server ConfigMap: %w", err)
		}
	}

	// 3. Idle check, then the workload: an idle App runs no pods.
	st, err := r.evaluateIdle(ctx, app)
	if err != nil {
		return idleState{}, err
	}
	deploy, err := r.buildDeployment(app)
	if err != nil {
		return idleState{}, err
	}
	if st.idle {
		deploy.Spec.Replicas = ptr.To(int32(0))
	}
	if err := r.apply(ctx, app, deploy, func(existing, desired client.Object) {
		existing.(*appsv1.Deployment).Spec = desired.(*appsv1.Deployment).Spec
	}); err != nil {
		return idleState{}, fmt.Errorf("reconciling Deployment: %w", err)
	}

	// 4. Service.
	svc := buildService(app)
	if err := r.apply(ctx, app, svc, func(existing, desired client.Object) {
		e, d := existing.(*corev1.Service), desired.(*corev1.Service)
		e.Spec.Selector = d.Spec.Selector
		e.Spec.Ports = d.Spec.Ports
		e.Spec.Type = d.Spec.Type
	}); err != nil {
		return idleState{}, fmt.Errorf("reconciling Service: %w", err)
	}

	// 5. Routing/auth/landing via NebariApp. An idle or waking App routes
	// to the activator, which serves the starting page and wakes it.
	nebariApp := r.buildNebariApp(app)
	if st.viaActivator {
		if err := r.ensureReferenceGrant(ctx, app.Namespace); err != nil {
			return idleState{}, fmt.Errorf("granting routes in %s access to the activator: %w", app.Namespace, err)
		}
		r.Config.routeToActivator(nebariApp)
	}
	if err := r.apply(ctx, app, nebariApp, func(existing, desired client.Object) {
		e, d := existing.(*unstructured.Unstructured), desired.(*unstructured.Unstructured)
		e.Object["spec"] = d.Object["spec"]
	}); err != nil {
		return idleState{}, fmt.Errorf("reconciling NebariApp: %w", err)
	}

	// 6. Status aggregation.
	return st, r.aggregateStatus(ctx, app, st)
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
		if err := validateGitURL(app.Spec.Source.Git.URL); err != nil {
			return fmt.Errorf("source.git.url: %w", err)
		}
		if strings.HasPrefix(app.Spec.Source.Git.Ref, "-") {
			return fmt.Errorf("source.git.ref must not start with '-'")
		}
		if strings.Contains(app.Spec.Source.Git.Subdir, "..") {
			return fmt.Errorf("source.git.subdir must not contain '..'")
		}
	case appsv1alpha1.SourceTypePVC:
		if app.Spec.Source.PVC == nil || app.Spec.Source.PVC.ClaimName == "" {
			return fmt.Errorf("source.pvc.claimName is required for source type pvc")
		}
		if err := r.checkMountable(ctx, app); err != nil {
			return err
		}
	case appsv1alpha1.SourceTypeImage:
		if err := r.Config.validateImageSource(app); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown source type %q", app.Spec.Source.Type)
	}

	if err := checkEnvRefs(app); err != nil {
		return err
	}
	if app.Spec.Access.Subdomain == "" {
		return fmt.Errorf("access.subdomain is required")
	}
	if err := r.Config.checkProxy(app); err != nil {
		return err
	}
	return r.checkSubdomain(ctx, app)
}

// validateImageSource checks an image App: the reference is inside the
// allowlist, the port leaves the sidecar's ports free, and the App does not
// also ask for a pixi task.
func (c OperatorConfig) validateImageSource(app *appsv1alpha1.App) error {
	src := app.Spec.Source.Image
	if src == nil || src.Reference == "" {
		return fmt.Errorf("source.image.reference is required for source type image")
	}
	if app.Spec.Runtime.PixiTask != "" {
		return fmt.Errorf("runtime.pixiTask cannot be combined with source type image: the image runs its own server")
	}
	if src.Port < 1024 || src.Port > 65535 || src.Port == AppPort || src.Port == proxyHealthPort {
		return fmt.Errorf("source.image.port %d must be 1024-65535 and not %d or %d (the proxy sidecar's ports)",
			src.Port, AppPort, proxyHealthPort)
	}
	if src.RunAsUser != nil && *src.RunAsUser < 1 {
		return fmt.Errorf("source.image.runAsUser must be a non-zero uid: image apps never run as root")
	}
	_, err := c.checkImage(src.Reference)
	return err
}

func isImageNotAllowed(err error) bool {
	var e errImageNotAllowed
	return errors.As(err, &e)
}

// stopWorkload scales an existing Deployment of the App to zero.
func (r *AppReconciler) stopWorkload(ctx context.Context, app *appsv1alpha1.App) error {
	deploy := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{Name: childName(app), Namespace: app.Namespace}, deploy)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if deploy.Spec.Replicas != nil && *deploy.Spec.Replicas == 0 {
		return nil
	}
	deploy.Spec.Replicas = ptr.To(int32(0))
	return r.Update(ctx, deploy)
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
		// A losing App is re-validated when the holder of its subdomain
		// changes or is deleted.
		Watches(&appsv1alpha1.App{}, handler.EnqueueRequestsFromMapFunc(r.appsSharingSubdomain)).
		// Labeling (or unlabeling) a claim re-validates the Apps that mount it.
		Watches(&corev1.PersistentVolumeClaim{}, handler.EnqueueRequestsFromMapFunc(r.appsMountingClaim)).
		Named("app").
		Complete(r)
}

func intstrFromString(s string) intstr.IntOrString {
	return intstr.FromString(s)
}
