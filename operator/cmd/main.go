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
	var enableLeaderElection bool
	cfg := controller.OperatorConfig{}

	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8443", "The address the metrics endpoint binds to.")
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

	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	if cfg.AppsDomain == "" {
		setupLog.Error(nil, "--apps-domain (or APPS_DOMAIN) is required")
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
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

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
