package gate

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// app is the upstream: it echoes what the proxy sent it.
func newApp(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Seen-Host", r.Host)
		w.Header().Set("X-Seen-Authorization", r.Header.Get("Authorization"))
		w.Header().Set("X-Seen-XFF", r.Header.Get("X-Forwarded-For"))
		w.Header().Set("X-Seen-Proto", r.Header.Get("X-Forwarded-Proto"))
		w.Header().Set("X-Seen-Fwd-Host", r.Header.Get("X-Forwarded-Host"))
		_, _ = io.WriteString(w, "app:"+r.URL.RequestURI())
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newGate(t *testing.T, upstream string) *httptest.Server {
	t.Helper()
	u, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewHandler(Config{Upstream: u}, http.DefaultTransport, quietLog()))
	t.Cleanup(srv.Close)
	return srv
}

// Every request passes, signed in or not: the gateway enforces sign-in and
// access.groups before a request reaches the pod.
func TestHandler(t *testing.T) {
	gate := newGate(t, newApp(t).URL)
	for name, auth := range map[string]string{"no token": "", "bearer": "Bearer abc.def.ghi", "basic": "Basic YWRhOnB3"} {
		t.Run(name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, gate.URL+"/a/b?c=d", nil)
			req.Host = "web-terminal.apps.nebari.local"
			req.Header.Set("X-Forwarded-For", "203.0.113.7")
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("X-Forwarded-Host", "web-terminal.apps.nebari.local")
			if auth != "" {
				req.Header.Set("Authorization", auth)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK || string(body) != "app:/a/b?c=d" {
				t.Fatalf("status %d body %q", resp.StatusCode, body)
			}
			if got := resp.Header.Get("X-Seen-Authorization"); got != auth {
				t.Errorf("upstream Authorization %q, want it passed through unchanged", got)
			}
			if got := resp.Header.Get("X-Seen-Host"); got != "web-terminal.apps.nebari.local" {
				t.Errorf("upstream Host %q", got)
			}
			if got := resp.Header.Get("X-Seen-XFF"); got != "203.0.113.7, 127.0.0.1" {
				t.Errorf("upstream X-Forwarded-For %q", got)
			}
			if resp.Header.Get("X-Seen-Proto") != "https" || resp.Header.Get("X-Seen-Fwd-Host") != "web-terminal.apps.nebari.local" {
				t.Errorf("X-Forwarded-Proto/Host not preserved: %v", resp.Header)
			}
		})
	}
}

func TestHandlerNoXFF(t *testing.T) {
	gate := newGate(t, newApp(t).URL)
	resp, err := http.Get(gate.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := resp.Header.Get("X-Seen-XFF"); got != "127.0.0.1" {
		t.Errorf("X-Forwarded-For %q, want the hop", got)
	}
}

func TestHandlerUpstreamDown(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	gate := newGate(t, "http://"+addr)
	resp, err := http.Get(gate.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", resp.StatusCode)
	}
}

func TestHandlerWebSocketUpgrade(t *testing.T) {
	// A raw upstream that accepts the upgrade and echoes one line.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Upgrade") != "websocket" {
			http.Error(w, "want upgrade", http.StatusBadRequest)
			return
		}
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = rw.Flush()
		line, _ := rw.ReadString('\n')
		_, _ = rw.WriteString("echo:" + line)
		_ = rw.Flush()
	}))
	t.Cleanup(up.Close)
	gate := newGate(t, up.URL)

	conn, err := net.Dial("tcp", strings.TrimPrefix(gate.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil || !strings.HasPrefix(string(buf[:n]), "HTTP/1.1 101") {
		t.Fatalf("handshake: %q %v", buf[:n], err)
	}
	_, _ = io.WriteString(conn, "hello\n")
	got := ""
	for !strings.Contains(got, "\n") {
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("read: %v (got %q)", err, got)
		}
		got += string(buf[:n])
	}
	if !strings.Contains(got, "echo:hello") {
		t.Fatalf("got %q", got)
	}
}

func TestHealth(t *testing.T) {
	up, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = up.Close() }()
	d := &net.Dialer{}
	h := &Health{Upstream: up.Addr().String(), Dial: d.DialContext}

	get := func(path string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code
	}
	if c := get("/healthz"); c != 200 {
		t.Errorf("/healthz %d", c)
	}
	if c := get("/readyz"); c != 200 {
		t.Errorf("/readyz %d (ready at once: there are no keys to wait for)", c)
	}
	if c := get("/upstreamz"); c != 200 {
		t.Errorf("/upstreamz with a listening app %d", c)
	}
	_ = up.Close()
	if c := get("/upstreamz"); c != 503 {
		t.Errorf("/upstreamz with no app %d, want 503", c)
	}
	if c := get("/other"); c != 404 {
		t.Errorf("/other %d", c)
	}
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnv(t *testing.T) {
	full := map[string]string{"PROXY_UPSTREAM": "http://127.0.0.1:8081"}
	cfg, err := FromEnv(env(full))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" || cfg.HealthListen != ":8082" || cfg.Upstream.String() != "http://127.0.0.1:8081" {
		t.Errorf("defaults: %+v", cfg)
	}
	// An operator from before the rename sets only the old names (and, for
	// Apps that only idle, AUTHZ_PASSTHROUGH): the sidecar must not start.
	old := map[string]string{
		"AUTHZ_LISTEN": ":8080", "AUTHZ_HEALTH_LISTEN": ":8082",
		"AUTHZ_UPSTREAM": "http://127.0.0.1:8081", "AUTHZ_PASSTHROUGH": "true",
	}
	if _, err := FromEnv(env(old)); err == nil || !strings.Contains(err.Error(), "AUTHZ_UPSTREAM is set") ||
		!strings.Contains(err.Error(), "PROXY_UPSTREAM is required") {
		t.Errorf("an operator from before the rename: %v", err)
	}

	cases := map[string]struct {
		edit map[string]string
		want string
	}{
		"no upstream":       {map[string]string{"PROXY_UPSTREAM": ""}, "PROXY_UPSTREAM is required"},
		"bad upstream":      {map[string]string{"PROXY_UPSTREAM": "127.0.0.1:8081"}, "PROXY_UPSTREAM"},
		"same listen ports": {map[string]string{"PROXY_HEALTH_LISTEN": ":8080"}, "must differ"},
		// An older operator restricting an App: refuse, never run it open.
		"groups":    {map[string]string{"AUTHZ_GROUPS": "analysts"}, "AUTHZ_GROUPS is set"},
		"issuers":   {map[string]string{"AUTHZ_ISSUERS": "https://kc/realms/nebari"}, "AUTHZ_ISSUERS is set"},
		"jwks":      {map[string]string{"AUTHZ_JWKS_URL": "https://kc/certs"}, "AUTHZ_JWKS_URL is set"},
		"client id": {map[string]string{"AUTHZ_CLIENT_ID": "apps-app-x"}, "AUTHZ_CLIENT_ID is set"},
		// The sidecar's own settings under the old name fail closed too.
		"old upstream": {map[string]string{"AUTHZ_UPSTREAM": "http://127.0.0.1:8081"}, "AUTHZ_UPSTREAM is set"},
		"old listen":   {map[string]string{"AUTHZ_LISTEN": ":8080"}, "reads PROXY_LISTEN"},
		"old health":   {map[string]string{"AUTHZ_HEALTH_LISTEN": ":8082"}, "AUTHZ_HEALTH_LISTEN is set"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			m := maps.Clone(full)
			maps.Copy(m, tc.edit)
			if _, err := FromEnv(env(m)); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %q", err, tc.want)
			}
		})
	}
	if _, err := FromEnv(env(map[string]string{"AUTHZ_GROUPS": "a", "PROXY_HEALTH_LISTEN": ":8080"})); err == nil || strings.Count(err.Error(), "\n") < 2 {
		t.Errorf("every problem should be reported at once: %v", err)
	}
}

func TestRun(t *testing.T) {
	app := newApp(t)
	u, _ := url.Parse(app.URL)
	cfg := Config{Upstream: u, Listen: freeAddr(t), HealthListen: freeAddr(t)}

	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- Run(ctx, cfg, quietLog()) }()

	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get("http://" + cfg.HealthListen + "/readyz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("never ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	resp, err := http.Get("http://" + cfg.Listen + "/x")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("proxied status %d", resp.StatusCode)
	}
	resp, err = http.Get("http://" + cfg.HealthListen + "/activity")
	if err != nil {
		t.Fatal(err)
	}
	var body activityReport
	_ = json.NewDecoder(resp.Body).Decode(&body)
	_ = resp.Body.Close()
	if body.LastRequest < time.Now().Add(-time.Minute).Unix() {
		t.Errorf("/activity %+v", body)
	}
	cancel()
	if err := <-errc; err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRunPortInUse(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	u, _ := url.Parse("http://127.0.0.1:1")
	cfg := Config{Upstream: u, Listen: freeAddr(t), HealthListen: busy.Addr().String()}
	if err := Run(context.Background(), cfg, quietLog()); err == nil {
		t.Fatal("Run started with its health port taken")
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

func TestActivity(t *testing.T) {
	now := time.Unix(1_000, 0)
	a := NewActivity(func() time.Time { return now })
	if got := a.LastRequest().Unix(); got != 1_000 {
		t.Fatalf("starts at start time: %d", got)
	}
	now = now.Add(time.Minute)
	a.begin()
	now = now.Add(time.Hour)
	if got := a.LastRequest(); !got.Equal(now) {
		t.Errorf("a request in flight is activity now: %v", got)
	}
	a.end()
	now = now.Add(time.Hour)
	if got := a.LastRequest().Unix(); got != 1_000+60+3600 {
		t.Errorf("after the request ended: %d", got)
	}

	rec := httptest.NewRecorder()
	(&Health{Activity: a}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/activity", nil))
	var body activityReport
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || rec.Code != 200 || body.LastRequest != 1_000+60+3600 {
		t.Errorf("/activity %d %s %v", rec.Code, rec.Body, err)
	}
	rec = httptest.NewRecorder()
	(&Health{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/activity", nil))
	if rec.Code != 404 {
		t.Errorf("/activity without a tracker %d", rec.Code)
	}
}

func TestHandlerRecordsActivity(t *testing.T) {
	app := newApp(t)
	u, _ := url.Parse(app.URL)
	now := time.Unix(1_000, 0)
	act := NewActivity(func() time.Time { return now })
	h := NewHandler(Config{Upstream: u}, http.DefaultTransport, quietLog())
	h.Activity = act
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	now = time.Unix(2_000, 0)
	resp, err := http.Get(srv.URL + "/ok")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || act.LastRequest().Unix() != 2_000 {
		t.Errorf("status %d, last %d", resp.StatusCode, act.LastRequest().Unix())
	}
}
