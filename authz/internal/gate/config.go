// Package gate is the apps-authz sidecar: a reverse proxy in front of an app
// container that records when the app last served a request (for the
// operator's idle check) and gives an image App's own port the pack's one
// front port. It checks no tokens: sign-in and access.groups are enforced at
// the gateway by the NebariApp's SecurityPolicy (nebari-operator v0.2.0+).
package gate

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Config is read from the environment only (see FromEnv); the operator
// writes it into the sidecar's container spec.
type Config struct {
	// Listen is the proxy's address; the Service and the NetworkPolicy
	// target it (AUTHZ_LISTEN, default :8080).
	Listen string
	// HealthListen serves /healthz, /readyz, /upstreamz and /activity, on
	// its own port so the app's own paths are never shadowed
	// (AUTHZ_HEALTH_LISTEN, default :8082).
	HealthListen string
	// Upstream is the app container, e.g. http://127.0.0.1:8081
	// (AUTHZ_UPSTREAM).
	Upstream *url.URL
}

// removedEnforcement are the variables of the enforcing mode this sidecar
// no longer has. An operator older than the sidecar may still set them for
// a restricted App; FromEnv refuses to start then, so the App stays down
// instead of running open to every signed-in user.
var removedEnforcement = []string{"AUTHZ_GROUPS", "AUTHZ_ISSUERS", "AUTHZ_JWKS_URL", "AUTHZ_CLIENT_ID"}

// FromEnv builds a Config from getenv (os.Getenv in main), reporting every
// missing or invalid variable at once. AUTHZ_PASSTHROUGH, which earlier
// operators set on Apps that only idle, is ignored: every request passes.
func FromEnv(getenv func(string) string) (Config, error) {
	cfg := Config{
		Listen:       orDefault(getenv("AUTHZ_LISTEN"), ":8080"),
		HealthListen: orDefault(getenv("AUTHZ_HEALTH_LISTEN"), ":8082"),
	}

	var errs []error
	if raw := strings.TrimSpace(getenv("AUTHZ_UPSTREAM")); raw == "" {
		errs = append(errs, errors.New("AUTHZ_UPSTREAM is required (e.g. http://127.0.0.1:8081)"))
	} else if u, err := url.Parse(raw); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("AUTHZ_UPSTREAM %q must be an http(s) URL with a host", raw))
	} else {
		cfg.Upstream = u
	}
	if cfg.Listen == cfg.HealthListen {
		errs = append(errs, errors.New("AUTHZ_LISTEN and AUTHZ_HEALTH_LISTEN must differ"))
	}
	for _, k := range removedEnforcement {
		if strings.TrimSpace(getenv(k)) != "" {
			errs = append(errs, fmt.Errorf("%s is set, but this sidecar no longer checks tokens or groups: "+
				"access.groups are enforced at the gateway, so upgrade the apps-operator to match this image", k))
		}
	}
	return cfg, errors.Join(errs...)
}

func orDefault(v, def string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return def
}
