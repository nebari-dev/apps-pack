// Command apps-authz is the sidecar the apps-operator puts in front of the
// app container of Apps that can idle and of image Apps. It proxies every
// request to the app and reports, on the health port's /activity, when the
// app last served one, which the operator reads to scale idle Apps to zero.
// It checks no tokens: sign-in and access.groups are enforced at the gateway
// (nebari-operator v0.2.0+). It is configured only through environment
// variables:
//
//	AUTHZ_LISTEN         proxy address (default :8080)
//	AUTHZ_HEALTH_LISTEN  /healthz, /readyz, /upstreamz, /activity (default :8082)
//	AUTHZ_UPSTREAM       the app container, e.g. http://127.0.0.1:8081
//
// It refuses to start when AUTHZ_GROUPS (or another setting of the enforcing
// mode it no longer has) is set, so an App an older operator meant to restrict
// never runs open.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/nebari-dev/nebari-apps-pack/authz/internal/gate"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := gate.FromEnv(os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apps-authz: invalid configuration:\n%v\n", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("starting", "upstream", cfg.Upstream.String())
	if err := gate.Run(ctx, cfg, log); err != nil {
		log.Error("server failed", "error", err.Error())
		os.Exit(1)
	}
}
