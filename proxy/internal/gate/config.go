// Package gate is the apps-proxy sidecar: a reverse proxy in front of an app
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
	// target it (PROXY_LISTEN, default :8080).
	Listen string
	// HealthListen serves /healthz, /readyz, /upstreamz and /activity, on
	// its own port so the app's own paths are never shadowed
	// (PROXY_HEALTH_LISTEN, default :8082).
	HealthListen string
	// Upstream is the app container, e.g. http://127.0.0.1:8081
	// (PROXY_UPSTREAM).
	Upstream *url.URL
}

// removedEnforcement are the variables of the enforcing mode this sidecar
// no longer has. An operator older than the sidecar may still set them for
// a restricted App; FromEnv refuses to start then, so the App stays down
// instead of running open to every signed-in user. They keep the sidecar's
// old AUTHZ_ prefix on purpose: that is the name such an operator sets, so
// renaming them would let its restricted Apps start open.
var removedEnforcement = []string{"AUTHZ_GROUPS", "AUTHZ_ISSUERS", "AUTHZ_JWKS_URL", "AUTHZ_CLIENT_ID"}

// renamedSettings are this sidecar's own settings under its old name
// (apps-authz). An operator from before the rename sets them instead of the
// PROXY_ ones; FromEnv refuses to start then too, so a mismatched operator
// and image fail closed instead of running on defaults nobody asked for.
var renamedSettings = []string{"AUTHZ_LISTEN", "AUTHZ_HEALTH_LISTEN", "AUTHZ_UPSTREAM"}

// FromEnv builds a Config from getenv (os.Getenv in main), reporting every
// missing or invalid variable at once.
func FromEnv(getenv func(string) string) (Config, error) {
	cfg := Config{
		Listen:       orDefault(getenv("PROXY_LISTEN"), ":8080"),
		HealthListen: orDefault(getenv("PROXY_HEALTH_LISTEN"), ":8082"),
	}

	var errs []error
	if raw := strings.TrimSpace(getenv("PROXY_UPSTREAM")); raw == "" {
		errs = append(errs, errors.New("PROXY_UPSTREAM is required (e.g. http://127.0.0.1:8081)"))
	} else if u, err := url.Parse(raw); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("PROXY_UPSTREAM %q must be an http(s) URL with a host", raw))
	} else {
		cfg.Upstream = u
	}
	if cfg.Listen == cfg.HealthListen {
		errs = append(errs, errors.New("PROXY_LISTEN and PROXY_HEALTH_LISTEN must differ"))
	}
	for _, k := range removedEnforcement {
		if strings.TrimSpace(getenv(k)) != "" {
			errs = append(errs, fmt.Errorf("%s is set, but this sidecar no longer checks tokens or groups: "+
				"access.groups are enforced at the gateway, so upgrade the apps-operator to match this image", k))
		}
	}
	for _, k := range renamedSettings {
		if strings.TrimSpace(getenv(k)) != "" {
			errs = append(errs, fmt.Errorf("%s is set, but this sidecar (apps-proxy, formerly apps-authz) reads PROXY_%s: "+
				"upgrade the apps-operator to match this image", k, strings.TrimPrefix(k, "AUTHZ_")))
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
