// Package gate is the apps-authz sidecar: a reverse proxy in front of an app
// container that lets a request through only when it carries a valid
// Keycloak access token whose groups claim names one of the allowed groups.
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
	// HealthListen serves /healthz, /readyz and /upstreamz without a token,
	// on its own port so the app's own paths are never shadowed
	// (AUTHZ_HEALTH_LISTEN, default :8082).
	HealthListen string
	// Upstream is the app container, e.g. http://127.0.0.1:8081
	// (AUTHZ_UPSTREAM).
	Upstream *url.URL
	// Issuers are the accepted iss values (AUTHZ_ISSUERS, comma-separated):
	// Keycloak writes the URL its token endpoint was called at, so both the
	// public and the in-cluster realm URL can appear.
	Issuers []string
	// JWKSURL is the realm's certs endpoint, normally on the in-cluster
	// Keycloak URL (AUTHZ_JWKS_URL).
	JWKSURL string
	// ClientID is the OIDC client the gateway logs users in with
	// (AUTHZ_CLIENT_ID). Keycloak puts it in azp; aud holds other clients
	// (account, realm-management) unless an audience mapper adds it.
	ClientID string
	// Groups lets in members of any of these groups (AUTHZ_GROUPS,
	// comma-separated).
	Groups []string
	// GroupsClaim is the top-level claim holding the user's groups
	// (AUTHZ_GROUPS_CLAIM, default "groups").
	GroupsClaim string
	// Passthrough proxies every request without checking a token
	// (AUTHZ_PASSTHROUGH=true). The operator sets it on Apps that restrict
	// nobody but may be scaled to zero when idle, where the sidecar only
	// records activity. It cannot be combined with groups.
	Passthrough bool
}

// FromEnv builds a Config from getenv (os.Getenv in main), reporting every
// missing or invalid variable at once.
func FromEnv(getenv func(string) string) (Config, error) {
	cfg := Config{
		Listen:       orDefault(getenv("AUTHZ_LISTEN"), ":8080"),
		HealthListen: orDefault(getenv("AUTHZ_HEALTH_LISTEN"), ":8082"),
		Issuers:      splitList(getenv("AUTHZ_ISSUERS")),
		JWKSURL:      strings.TrimSpace(getenv("AUTHZ_JWKS_URL")),
		ClientID:     strings.TrimSpace(getenv("AUTHZ_CLIENT_ID")),
		Groups:       splitList(getenv("AUTHZ_GROUPS")),
		GroupsClaim:  orDefault(getenv("AUTHZ_GROUPS_CLAIM"), "groups"),
		Passthrough:  strings.TrimSpace(getenv("AUTHZ_PASSTHROUGH")) == "true",
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
	if cfg.Passthrough {
		// Refuse rather than silently open an App that meant to restrict.
		if len(cfg.Groups) > 0 {
			errs = append(errs, errors.New("AUTHZ_PASSTHROUGH cannot be combined with AUTHZ_GROUPS"))
		}
		return cfg, errors.Join(errs...)
	}
	if len(cfg.Issuers) == 0 {
		errs = append(errs, errors.New("AUTHZ_ISSUERS is required (comma-separated realm URLs)"))
	}
	if cfg.JWKSURL == "" {
		errs = append(errs, errors.New("AUTHZ_JWKS_URL is required"))
	} else if u, err := url.Parse(cfg.JWKSURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		errs = append(errs, fmt.Errorf("AUTHZ_JWKS_URL %q must be an http(s) URL", cfg.JWKSURL))
	}
	if cfg.ClientID == "" {
		errs = append(errs, errors.New("AUTHZ_CLIENT_ID is required"))
	}
	if len(cfg.Groups) == 0 {
		// The sidecar exists only to restrict; with nothing to allow it
		// would deny everyone, which is a misconfiguration, not a policy.
		errs = append(errs, errors.New("AUTHZ_GROUPS is required (comma-separated)"))
	}
	return cfg, errors.Join(errs...)
}

func orDefault(v, def string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return def
}

// splitList splits a comma-separated value, dropping blanks.
func splitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}
