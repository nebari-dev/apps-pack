package gate

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// Run serves the proxy and the health endpoints until ctx ends, then shuts
// both down gracefully.
func Run(ctx context.Context, cfg Config, log *slog.Logger) error {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	jwksClient := &http.Client{Timeout: 10 * time.Second}
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(ctx, jwksClient), cfg.JWKSURL)
	verifier := NewVerifier(cfg, keys)

	upstream := &http.Transport{
		DialContext:         dialer.DialContext,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
		// Generous: the gateway's route timeout is the real bound, and slow
		// app endpoints are the app's business.
		ResponseHeaderTimeout: 5 * time.Minute,
		ExpectContinueTimeout: time.Second,
	}

	watch := &KeyWatch{URL: cfg.JWKSURL, Client: jwksClient, Every: 2 * time.Second, Log: log}
	go watch.Run(ctx)

	// No ReadTimeout/WriteTimeout: they would cut WebSockets and streamed
	// responses. ReadHeaderTimeout bounds slow clients; IdleTimeout reaps
	// idle keep-alives.
	servers := []*http.Server{
		{
			Addr:              cfg.Listen,
			Handler:           NewHandler(cfg, verifier, upstream, log),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		},
		{
			Addr:              cfg.HealthListen,
			Handler:           &Health{Ready: watch.Ready, Upstream: cfg.Upstream.Host, Dial: dialer.DialContext},
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       30 * time.Second,
		},
	}
	return serve(ctx, servers, log)
}

func serve(ctx context.Context, servers []*http.Server, log *slog.Logger) error {
	errc := make(chan error, len(servers))
	for _, s := range servers {
		ln, err := net.Listen("tcp", s.Addr)
		if err != nil {
			for _, other := range servers {
				_ = other.Close()
			}
			return err
		}
		log.Info("listening", "addr", ln.Addr().String())
		go func(s *http.Server, ln net.Listener) {
			if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- err
			}
		}(s, ln)
	}

	var runErr error
	select {
	case <-ctx.Done():
	case runErr = <-errc:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	return runErr
}
