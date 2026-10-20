package gate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

// Handler checks every request's bearer token and proxies the allowed ones
// to the upstream app with the Authorization header intact.
type Handler struct {
	verifier *Verifier
	proxy    *httputil.ReverseProxy
	log      *slog.Logger
	// forbidden is the 403 body: it names the groups when only groups are
	// configured, and stays generic when usernames (PII) are configured.
	forbidden string
}

// NewHandler proxies to cfg.Upstream through transport.
func NewHandler(cfg Config, v *Verifier, transport http.RoundTripper, log *slog.Logger) *Handler {
	upstream := cfg.Upstream
	proxy := &httputil.ReverseProxy{
		// Rewrite drops inbound X-Forwarded-* headers; the gateway's are
		// the real client's, so carry them over and append the hop.
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = r.In.Host
			for _, h := range []string{"X-Forwarded-Host", "X-Forwarded-Proto"} {
				if v := r.In.Header.Values(h); len(v) > 0 {
					r.Out.Header[h] = v
				}
			}
			xff := strings.Join(r.In.Header.Values("X-Forwarded-For"), ", ")
			if ip, _, err := net.SplitHostPort(r.In.RemoteAddr); err == nil {
				if xff != "" {
					xff += ", "
				}
				xff += ip
			}
			if xff != "" {
				r.Out.Header.Set("X-Forwarded-For", xff)
			}
		},
		Transport: transport,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, context.Canceled) {
				return
			}
			log.Warn("upstream request failed", "path", r.URL.Path, "error", err.Error())
			http.Error(w, "Bad Gateway: the app is not responding", http.StatusBadGateway)
		},
	}
	forbidden := "Forbidden: this app is restricted to specific groups or users"
	if len(cfg.Users) == 0 {
		forbidden = "Forbidden: this app is restricted to groups: " + strings.Join(cfg.Groups, ", ")
	}
	return &Handler{verifier: v, proxy: proxy, log: log, forbidden: forbidden}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	authz := r.Header.Get("Authorization")
	if authz == "" {
		// Distinct from a denial: the gateway forwarded no token at all,
		// which means forwardAccessToken is off or the request bypassed it.
		h.log.Info("denied", "status", http.StatusUnauthorized, "reason", "no Authorization header", "path", r.URL.Path)
		w.Header().Set("WWW-Authenticate", `Bearer realm="app"`)
		http.Error(w, "Unauthorized: no access token was forwarded to this app", http.StatusUnauthorized)
		return
	}
	scheme, token, ok := strings.Cut(authz, " ")
	token = strings.TrimSpace(token)
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		h.forbid(w, r, "Authorization header is not a bearer token")
		return
	}
	if err := h.verifier.Verify(r.Context(), token); err != nil {
		h.forbid(w, r, err.Error())
		return
	}
	h.proxy.ServeHTTP(w, r)
}

func (h *Handler) forbid(w http.ResponseWriter, r *http.Request, reason string) {
	h.log.Info("denied", "status", http.StatusForbidden, "reason", reason, "path", r.URL.Path)
	http.Error(w, h.forbidden, http.StatusForbidden)
}

// Health serves the token-free probe endpoints: /healthz (the process is
// up), /readyz (the realm's key set has been fetched at least once) and
// /upstreamz (the app container accepts connections; the app container's
// own probes use it, so the app can listen on loopback only).
type Health struct {
	Ready    func() bool
	Upstream string // host:port
	Dial     func(ctx context.Context, network, addr string) (net.Conn, error)
}

func (h *Health) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		_, _ = fmt.Fprintln(w, "ok")
	case "/readyz":
		if !h.Ready() {
			http.Error(w, "waiting for the realm's signing keys", http.StatusServiceUnavailable)
			return
		}
		_, _ = fmt.Fprintln(w, "ok")
	case "/upstreamz":
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		conn, err := h.Dial(ctx, "tcp", h.Upstream)
		if err != nil {
			http.Error(w, "the app is not accepting connections", http.StatusServiceUnavailable)
			return
		}
		_ = conn.Close()
		_, _ = fmt.Fprintln(w, "ok")
	default:
		http.NotFound(w, r)
	}
}
