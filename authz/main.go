// Command apps-authz is the sidecar the apps-operator puts in front of an
// App's container when the App restricts who may open it. It is configured
// only through environment variables:
//
//	AUTHZ_LISTEN         proxy address (default :8080)
//	AUTHZ_HEALTH_LISTEN  /healthz, /readyz, /upstreamz, no token (default :8082)
//	AUTHZ_UPSTREAM       the app container, e.g. http://127.0.0.1:8081
//	AUTHZ_ISSUERS        accepted iss values, comma-separated (public and in-cluster realm URL)
//	AUTHZ_JWKS_URL       the realm's certs endpoint
//	AUTHZ_CLIENT_ID      the gateway's OIDC client; must equal azp or appear in aud
//	AUTHZ_GROUPS         allowed groups, comma-separated
//	AUTHZ_GROUPS_CLAIM   claim holding the user's groups (default groups)
//	AUTHZ_USERS          allowed usernames, comma-separated, case-insensitive
//	AUTHZ_USERS_CLAIM    claim holding the username (default preferred_username)
//	AUTHZ_PASSTHROUGH    true: check no tokens, only record activity (unrestricted Apps that may idle)
//
// A request passes when its bearer access token verifies (signature against
// the realm's JWKS, exp/nbf, iss, client) and the user is in any allowed
// group OR is an allowed user. At least one of AUTHZ_GROUPS and AUTHZ_USERS
// must be set. A request without an Authorization header gets 401 (the
// gateway forwarded no token); every other refusal is 403.
//
// In passthrough mode every request is proxied unchecked. Either way the
// health port's /activity reports when the app last served a request, which
// the operator reads to scale idle Apps to zero.
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
	log.Info("starting", "upstream", cfg.Upstream.String(), "issuers", cfg.Issuers,
		"clientID", cfg.ClientID, "groups", len(cfg.Groups), "users", len(cfg.Users), "passthrough", cfg.Passthrough)
	if err := gate.Run(ctx, cfg, log); err != nil {
		log.Error("server failed", "error", err.Error())
		os.Exit(1)
	}
}
