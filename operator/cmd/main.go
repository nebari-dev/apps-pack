package main

import (
	"flag"
	"os"

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
	flag.BoolVar(&cfg.TLSDisabled, "tls-disabled", envOr("TLS_DISABLED", "") == "true",
		"Serve apps over plain HTTP (no certificates, no HTTPS listeners).")
	flag.BoolVar(&cfg.LandingPage, "landing-page", envOr("LANDING_PAGE", "") == "true",
		"Cluster default for showing apps as tiles on the Nebari landing page (spec.landingPage.enabled overrides per app).")

	opts := zap.Options{Development: false}
	var staticResources, pythonResources string
	flag.StringVar(&staticResources, "default-static-resources", envOr("DEFAULT_STATIC_RESOURCES", ""),
		`Requests/limits (JSON, e.g. {"requests":{"cpu":"50m"},"limits":{"memory":"256Mi"}}) for static app pods that leave them unset.`)
	flag.StringVar(&pythonResources, "default-python-resources", envOr("DEFAULT_PYTHON_RESOURCES", ""),
		"Requests/limits (JSON) for Python/pixi app pods that leave them unset.")
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
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Config: cfg,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller", "controller", "App")
		os.Exit(1)
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
		"appsDomain", cfg.AppsDomain, "gateway", cfg.Gateway)
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
