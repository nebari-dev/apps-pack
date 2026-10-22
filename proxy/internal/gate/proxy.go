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

// Handler proxies every request to the upstream app unchanged. The gateway
// has already signed the user in and checked access.groups.
type Handler struct {
	// Activity, when set, records each request that reaches the app.
	Activity *Activity
	proxy    *httputil.ReverseProxy
}

// NewHandler proxies to cfg.Upstream through transport.
func NewHandler(cfg Config, transport http.RoundTripper, log *slog.Logger) *Handler {
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
	return &Handler{proxy: proxy}
}

// ServeHTTP proxies the request, recording it as activity.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Activity != nil {
		h.Activity.begin()
		defer h.Activity.end()
	}
	h.proxy.ServeHTTP(w, r)
}

// Health serves the probe endpoints: /healthz and /readyz (the process is
// up),
// /upstreamz (the app container accepts connections; the app container's
// own probes use it, so the app can listen on loopback only) and /activity
// (when the app last served a request, for the operator's idle check).
type Health struct {
	Upstream string // host:port
	Dial     func(ctx context.Context, network, addr string) (net.Conn, error)
	Activity *Activity
}

func (h *Health) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz", "/readyz":
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
	case "/activity":
		if h.Activity == nil {
			http.NotFound(w, r)
			return
		}
		h.Activity.serve(w)
	default:
		http.NotFound(w, r)
	}
}
