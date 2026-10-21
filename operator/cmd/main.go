package main

import (
	"flag"
	"os"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
	"github.com/nebari-dev/nebari-apps-pack/operator/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(appsv1alpha1.AddToScheme(scheme))
}

func main() {
	var metricsAddr, probeAddr string
	var enableLeaderElection, secureMetrics bool
	cfg := controller.OperatorConfig{}

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8443",
		"The address the metrics endpoint binds to; 0 disables it.")
	flag.BoolVar(&secureMetrics, "metrics-secure", true,
		"Serve metrics over HTTPS and require a token allowed to GET /metrics (authenticated and authorized by the API server).")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&enableLeaderElection, "leader-elect", false, "Enable leader election for controller manager.")
	flag.StringVar(&cfg.AppsDomain, "apps-domain", envOr("APPS_DOMAIN", ""),
		"Domain apps are exposed under (https://<subdomain>.<apps-domain>), e.g. apps.example.ai.")
	flag.StringVar(&cfg.Gateway, "gateway", envOr("GATEWAY", "public"),
		"Shared Gateway NebariApps attach to (public|internal).")
	flag.StringVar(&cfg.StaticImage, "static-image", envOr("STATIC_IMAGE", "nginxinc/nginx-unprivileged:1.27-alpine"),
		"Image serving static app content; must listen on 8080 as non-root.")
	flag.StringVar(&cfg.GitImage, "git-image", envOr("GIT_IMAGE", "alpine/git:v2.47.2"),
		"Image used by init containers to fetch git sources.")
	flag.StringVar(&cfg.PythonImage, "python-image", envOr("PYTHON_IMAGE", "ghcr.io/prefix-dev/pixi:0.68.1-noble"),
		"Image running Python/pixi apps (runtime.pixiTask); must provide pixi and run as non-root.")
	flag.StringVar(&cfg.AuthzImage, "authz-image", envOr("AUTHZ_IMAGE", ""),
		"apps-authz sidecar image, added to Apps that restrict access.groups or access.users (required for those Apps).")
	var authzPullPolicy string
	flag.StringVar(&authzPullPolicy, "authz-image-pull-policy", envOr("AUTHZ_IMAGE_PULL_POLICY", ""),
		"Pull policy for the authz sidecar image (Always|IfNotPresent|Never; empty: the Kubernetes default).")
	flag.StringVar(&cfg.KeycloakURL, "keycloak-url", envOr("KEYCLOAK_URL", ""),
		"Public Keycloak base URL; the authz sidecar accepts tokens issued under <url>/realms/<realm>.")
	flag.StringVar(&cfg.KeycloakInternalURL, "keycloak-internal-url", envOr("KEYCLOAK_INTERNAL_URL", ""),
		"In-cluster Keycloak base URL; the authz sidecar also accepts it as issuer and fetches signing keys from it.")
	flag.StringVar(&cfg.KeycloakRealm, "keycloak-realm", envOr("KEYCLOAK_REALM", "nebari"),
		"Keycloak realm nebari-operator provisions app clients in.")
	flag.BoolVar(&cfg.TLSDisabled, "tls-disabled", envOr("TLS_DISABLED", "") == "true",
		"Serve apps over plain HTTP (no certificates, no HTTPS listeners).")
	flag.BoolVar(&cfg.LandingPage, "landing-page", envOr("LANDING_PAGE", "") == "true",
		"Cluster default for showing apps as tiles on the Nebari landing page (spec.landingPage.enabled overrides per app).")

	var idleMinutes int
	var activatorAddr string
	flag.IntVar(&idleMinutes, "idle-timeout-minutes", envInt("IDLE_TIMEOUT_MINUTES", 0),
		"Cluster default for scaling an App to zero after this many minutes without a request (0: only Apps that set runtime.idleTimeoutMinutes idle).")
	flag.StringVar(&cfg.ActivatorService, "activator-service", envOr("ACTIVATOR_SERVICE", ""),
		"Service in front of the activator, which idle Apps route to; empty disables scale-to-zero.")
	flag.StringVar(&cfg.ActivatorNamespace, "activator-namespace", envOr("POD_NAMESPACE", ""),
		"Namespace of --activator-service (default: $POD_NAMESPACE).")
	flag.StringVar(&activatorAddr, "activator-bind-address", ":8090",
		"The address the activator (the page idle Apps serve while they start) binds to; 0 disables it.")

	opts := zap.Options{Development: false}
	var staticResources, pythonResources, authzResources string
	flag.StringVar(&staticResources, "default-static-resources", envOr("DEFAULT_STATIC_RESOURCES", ""),
		`Requests/limits (JSON, e.g. {"requests":{"cpu":"50m"},"limits":{"memory":"256Mi"}}) for static app pods that leave them unset.`)
	flag.StringVar(&pythonResources, "default-python-resources", envOr("DEFAULT_PYTHON_RESOURCES", ""),
		"Requests/limits (JSON) for Python/pixi app pods that leave them unset.")
	flag.StringVar(&authzResources, "authz-resources", envOr("AUTHZ_RESOURCES", ""),
		"Requests/limits (JSON) for the authz sidecar.")
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	var err error
	if cfg.StaticResources, err = controller.ParseResources(staticResources, controller.DefaultStaticResources); err != nil {
		setupLog.Error(err, "invalid --default-static-resources")
		os.Exit(1)
	}
	if cfg.PythonResources, err = controller.ParseResources(pythonResources, controller.DefaultPythonResources); err != nil {
		setupLog.Error(err, "invalid --default-python-resources")
		os.Exit(1)
	}

	if cfg.AuthzResources, err = controller.ParseResources(authzResources, controller.DefaultAuthzResources); err != nil {
		setupLog.Error(err, "invalid --authz-resources")
		os.Exit(1)
	}
	switch p := corev1.PullPolicy(authzPullPolicy); p {
	case "", corev1.PullAlways, corev1.PullIfNotPresent, corev1.PullNever:
		cfg.AuthzImagePullPolicy = p
	default:
		setupLog.Error(nil, "invalid --authz-image-pull-policy", "value", authzPullPolicy)
		os.Exit(1)
	}

	if idleMinutes < 0 {
		setupLog.Error(nil, "--idle-timeout-minutes must not be negative")
		os.Exit(1)
	}
	if idleMinutes > 0 && idleMinutes < 5 {
		setupLog.Error(nil, "--idle-timeout-minutes must be 0 or at least 5")
		os.Exit(1)
	}
	cfg.IdleTimeout = time.Duration(idleMinutes) * time.Minute
	if cfg.IdleTimeout > 0 && (cfg.ActivatorService == "" || cfg.ActivatorNamespace == "" || cfg.AuthzImage == "") {
		setupLog.Error(nil, "--idle-timeout-minutes needs --activator-service, --activator-namespace and --authz-image")
		os.Exit(1)
	}

	if cfg.AppsDomain == "" {
		setupLog.Error(nil, "--apps-domain (or APPS_DOMAIN) is required")
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsOptions(metricsAddr, secureMetrics),
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "apps-operator.apps.nebari.dev",
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}

	if err := (&controller.AppReconciler{
		Client:     mgr.GetClient(),
		Scheme:     mgr.GetScheme(),
		Config:     cfg,
		APIReader:  mgr.GetAPIReader(),
		Recorder:   mgr.GetEventRecorderFor("apps-operator"), //nolint:staticcheck // core v1 Events: the chart already grants them; events.k8s.io would need new RBAC
		HTTPClient: controller.NewActivityClient(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "App")
		os.Exit(1)
	}
	if activatorAddr != "0" {
		if err := mgr.Add(&controller.Activator{
			Client:     mgr.GetClient(),
			AppsDomain: cfg.AppsDomain,
			Addr:       activatorAddr,
			Log:        ctrl.Log.WithName("activator"),
		}); err != nil {
			setupLog.Error(err, "unable to add the activator")
			os.Exit(1)
		}
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("starting manager",
		"appsDomain", cfg.AppsDomain, "gateway", cfg.Gateway,
		"authzImage", cfg.AuthzImage, "keycloakIssuers", len(cfg.KeycloakURL+cfg.KeycloakInternalURL) > 0,
		"idleTimeout", cfg.IdleTimeout.String(), "activatorService", cfg.ActivatorNamespace+"/"+cfg.ActivatorService)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "problem running manager")
		os.Exit(1)
	}
}

// metricsOptions serves /metrics over HTTPS (a self-signed certificate the
// manager generates) behind TokenReview + SubjectAccessReview, so only a
// caller whose token may GET the /metrics non-resource URL can scrape it.
func metricsOptions(addr string, secure bool) metricsserver.Options {
	opts := metricsserver.Options{BindAddress: addr, SecureServing: secure}
	if secure {
		opts.FilterProvider = filters.WithAuthenticationAndAuthorization
	}
	return opts
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
