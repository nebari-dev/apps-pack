package gate

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
)

const (
	publicIssuer   = "https://keycloak.nebari.local/realms/nebari"
	internalIssuer = "http://keycloak-keycloakx-http.keycloak.svc.cluster.local:8080/realms/nebari"
	clientID       = "apps-app-web-terminal"
)

// realm is a fake Keycloak realm: a signing key, its JWKS endpoint and a
// token minter.
type realm struct {
	key     *rsa.PrivateKey
	kid     string
	srv     *httptest.Server
	fetches atomic.Int32
	fail    atomic.Bool
}

func newRealm(t *testing.T) *realm {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	enc, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	r := &realm{key: key, kid: "YnxUY0-sig"}
	// Like Keycloak's certs endpoint: a signing key and an encryption key.
	set := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
		{Key: &key.PublicKey, KeyID: r.kid, Algorithm: "RS256", Use: "sig"},
		{Key: &enc.PublicKey, KeyID: "OySt7L-enc", Algorithm: "RSA-OAEP", Use: "enc"},
	}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		r.fetches.Add(1)
		if r.fail.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *realm) jwksURL() string { return r.srv.URL + "/realms/nebari/protocol/openid-connect/certs" }

// keycloakClaims is the shape of a real access token from the dev cluster's
// realm for a nebari-operator client (values replaced): azp is the client,
// aud lists other clients, groups are plain names, there is no nbf.
func keycloakClaims(now time.Time) map[string]any {
	return map[string]any{
		"exp":                now.Add(5 * time.Minute).Unix(),
		"iat":                now.Unix(),
		"auth_time":          now.Unix(),
		"jti":                "onrtac:00000000-0000-0000-0000-000000000000",
		"iss":                publicIssuer,
		"aud":                []string{"realm-management", "account"},
		"sub":                "00000000-0000-0000-0000-000000000001",
		"typ":                "Bearer",
		"azp":                clientID,
		"sid":                "00000000-0000-0000-0000-000000000002",
		"acr":                "1",
		"allowed-origins":    []string{"https://web-terminal.apps.nebari.local"},
		"realm_access":       map[string]any{"roles": []string{"offline_access", "default-roles-nebari"}},
		"scope":              "openid groups profile email",
		"email_verified":     true,
		"name":               "Ada Lovelace",
		"groups":             []string{"analysts", "test-group"},
		"preferred_username": "ada",
		"given_name":         "Ada",
		"family_name":        "Lovelace",
		"email":              "ada@example.com",
	}
}

func sign(t *testing.T, key any, alg jose.SignatureAlgorithm, kid string, claims map[string]any) string {
	t.Helper()
	opts := (&jose.SignerOptions{}).WithType("JWT")
	if kid != "" {
		opts = opts.WithHeader("kid", kid)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: alg, Key: key}, opts)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	jws, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	s, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (r *realm) mint(t *testing.T, claims map[string]any) string {
	return sign(t, r.key, jose.RS256, r.kid, claims)
}

func testConfig(r *realm) Config {
	return Config{
		Listen:       ":8080",
		HealthListen: ":8082",
		Upstream:     &url.URL{Scheme: "http", Host: "127.0.0.1:8081"},
		Issuers:      []string{internalIssuer, publicIssuer},
		JWKSURL:      r.jwksURL(),
		ClientID:     clientID,
		Groups:       []string{"analysts", "admin"},
		GroupsClaim:  "groups",
		UsersClaim:   "preferred_username",
	}
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func with(base map[string]any, edits map[string]any) map[string]any {
	out := maps.Clone(base)
	for k, v := range edits {
		if v == nil {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

func TestVerify(t *testing.T) {
	r := newRealm(t)
	now := time.Now()
	base := keycloakClaims(now)
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name    string
		token   func() string
		cfg     func(*Config)
		allowed bool
	}{
		{name: "member, public issuer", allowed: true,
			token: func() string { return r.mint(t, base) }},
		{name: "member, in-cluster issuer", allowed: true,
			token: func() string { return r.mint(t, with(base, map[string]any{"iss": internalIssuer})) }},
		{name: "groups claim as a single string", allowed: true,
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": "admin"})) }},
		{name: "full group path", allowed: true,
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": []string{"/analysts"}})) }},
		{name: "client in aud instead of azp", allowed: true,
			token: func() string {
				return r.mint(t, with(base, map[string]any{"azp": "other", "aud": []string{"account", clientID}}))
			}},
		{name: "nbf within leeway", allowed: true,
			token: func() string { return r.mint(t, with(base, map[string]any{"nbf": now.Add(10 * time.Second).Unix()})) }},
		{name: "expired within leeway", allowed: true,
			token: func() string { return r.mint(t, with(base, map[string]any{"exp": now.Add(-10 * time.Second).Unix()})) }},
		{name: "non-member",
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": []string{"test-group"}})) }},
		{name: "no groups claim",
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": nil})) }},
		{name: "groups claim of the wrong type",
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": 7})) }},
		{name: "wrong issuer",
			token: func() string {
				return r.mint(t, with(base, map[string]any{"iss": "https://evil.example/realms/nebari"}))
			}},
		{name: "expired",
			token: func() string { return r.mint(t, with(base, map[string]any{"exp": now.Add(-time.Minute).Unix()})) }},
		{name: "no exp",
			token: func() string { return r.mint(t, with(base, map[string]any{"exp": nil})) }},
		{name: "not valid yet",
			token: func() string { return r.mint(t, with(base, map[string]any{"nbf": now.Add(time.Minute).Unix()})) }},
		{name: "bad nbf",
			token: func() string { return r.mint(t, with(base, map[string]any{"nbf": "soon"})) }},
		{name: "wrong client",
			token: func() string { return r.mint(t, with(base, map[string]any{"azp": "apps-other-app"})) }},
		{name: "bad azp",
			token: func() string { return r.mint(t, with(base, map[string]any{"azp": 1})) }},
		{name: "ID token",
			token: func() string { return r.mint(t, with(base, map[string]any{"typ": "ID"})) }},
		{name: "bad typ",
			token: func() string { return r.mint(t, with(base, map[string]any{"typ": 1})) }},
		{name: "signed by another key",
			token: func() string { return sign(t, other, jose.RS256, r.kid, base) }},
		{name: "unknown key id",
			token: func() string { return sign(t, other, jose.RS256, "rotated", base) }},
		{name: "symmetric algorithm",
			token: func() string { return sign(t, []byte("0123456789abcdef0123456789abcdef"), jose.HS256, r.kid, base) }},
		{name: "ES256 key not in the realm",
			token: func() string { return sign(t, ecKey, jose.ES256, "ec", base) }},
		{name: "not a JWT",
			token: func() string { return "not.a.jwt" }},

		// AUTHZ_USERS: OR semantics with the groups.
		{name: "listed user with no groups claim", allowed: true,
			cfg:   func(c *Config) { c.Users = []string{"ada"} },
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": nil})) }},
		{name: "listed user outside every group", allowed: true,
			cfg:   func(c *Config) { c.Users = []string{"grace", "ada"} },
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": []string{"test-group"}})) }},
		{name: "users only, case-insensitive", allowed: true,
			cfg:   func(c *Config) { c.Groups = nil; c.Users = []string{" Ada "} },
			token: func() string { return r.mint(t, with(base, map[string]any{"preferred_username": "ADA"})) }},
		{name: "users only, member of a group is not enough",
			cfg:   func(c *Config) { c.Groups = nil; c.Users = []string{"grace"} },
			token: func() string { return r.mint(t, base) }},
		{name: "unlisted user and non-member",
			cfg:   func(c *Config) { c.Users = []string{"grace"} },
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": []string{"test-group"}})) }},
		{name: "listed user, no username claim",
			cfg:   func(c *Config) { c.Groups = nil; c.Users = []string{"ada"} },
			token: func() string { return r.mint(t, with(base, map[string]any{"preferred_username": nil})) }},
		{name: "listed user, username claim of the wrong type",
			cfg:   func(c *Config) { c.Groups = nil; c.Users = []string{"ada"} },
			token: func() string { return r.mint(t, with(base, map[string]any{"preferred_username": []string{"ada"}})) }},
		{name: "custom username claim", allowed: true,
			cfg:   func(c *Config) { c.Groups = nil; c.Users = []string{"ada@example.com"}; c.UsersClaim = "email" },
			token: func() string { return r.mint(t, base) }},
		{name: "custom groups claim", allowed: true,
			cfg:   func(c *Config) { c.GroupsClaim = "teams" },
			token: func() string { return r.mint(t, with(base, map[string]any{"groups": nil, "teams": []string{"admin"}})) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig(r)
			if tc.cfg != nil {
				tc.cfg(&cfg)
			}
			v := NewVerifier(cfg, oidc.NewRemoteKeySet(context.Background(), r.jwksURL()))
			err := v.Verify(context.Background(), tc.token())
			if tc.allowed && err != nil {
				t.Fatalf("denied: %v", err)
			}
			if !tc.allowed {
				if err == nil {
					t.Fatal("allowed, want denied")
				}
				if _, ok := err.(*Denial); !ok {
					t.Fatalf("error %T is not a *Denial", err)
				}
			}
		})
	}
}

func TestVerifyKeySetDownDenies(t *testing.T) {
	r := newRealm(t)
	r.fail.Store(true)
	v := NewVerifier(testConfig(r), oidc.NewRemoteKeySet(context.Background(), r.jwksURL()))
	if err := v.Verify(context.Background(), r.mint(t, keycloakClaims(time.Now()))); err == nil {
		t.Fatal("a token was allowed while the key set could not be fetched")
	}
}

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

func newGate(t *testing.T, r *realm, upstream string, edit func(*Config)) (*httptest.Server, Config) {
	t.Helper()
	cfg := testConfig(r)
	u, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Upstream = u
	if edit != nil {
		edit(&cfg)
	}
	v := NewVerifier(cfg, oidc.NewRemoteKeySet(context.Background(), r.jwksURL()))
	srv := httptest.NewServer(NewHandler(cfg, v, http.DefaultTransport, quietLog()))
	t.Cleanup(srv.Close)
	return srv, cfg
}

func TestHandler(t *testing.T) {
	r := newRealm(t)
	app := newApp(t)
	gate, _ := newGate(t, r, app.URL, nil)
	now := time.Now()
	member := r.mint(t, keycloakClaims(now))
	outsider := r.mint(t, with(keycloakClaims(now), map[string]any{"groups": []string{"test-group"}}))

	cases := []struct {
		name   string
		auth   string
		status int
		body   string
	}{
		{"member", "Bearer " + member, http.StatusOK, "app:/a/b?c=d"},
		{"lowercase scheme", "bearer " + member, http.StatusOK, "app:/a/b?c=d"},
		{"non-member", "Bearer " + outsider, http.StatusForbidden, "Forbidden: this app is restricted to groups: analysts, admin"},
		{"missing header", "", http.StatusUnauthorized, "Unauthorized: no access token was forwarded to this app"},
		{"basic auth", "Basic YWRhOnB3", http.StatusForbidden, "Forbidden"},
		{"empty bearer", "Bearer ", http.StatusForbidden, "Forbidden"},
		{"garbage", "Bearer garbage", http.StatusForbidden, "Forbidden"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, gate.URL+"/a/b?c=d", nil)
			req.Host = "web-terminal.apps.nebari.local"
			req.Header.Set("X-Forwarded-For", "203.0.113.7")
			req.Header.Set("X-Forwarded-Proto", "https")
			req.Header.Set("X-Forwarded-Host", "web-terminal.apps.nebari.local")
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tc.status {
				t.Fatalf("status %d, want %d (%s)", resp.StatusCode, tc.status, body)
			}
			if !strings.HasPrefix(string(body), tc.body) {
				t.Fatalf("body %q, want prefix %q", body, tc.body)
			}
			if strings.Contains(string(body), "eyJ") {
				t.Fatal("the response echoes the token")
			}
			if tc.status != http.StatusOK {
				return
			}
			if got := resp.Header.Get("X-Seen-Authorization"); got != tc.auth {
				t.Errorf("upstream Authorization %q, want it passed through", got)
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

func TestHandlerForbiddenBodyHidesUsernames(t *testing.T) {
	r := newRealm(t)
	gate, _ := newGate(t, r, newApp(t).URL, func(c *Config) { c.Users = []string{"grace"} })
	tok := r.mint(t, with(keycloakClaims(time.Now()), map[string]any{"groups": []string{"test-group"}}))
	req, _ := http.NewRequest(http.MethodGet, gate.URL, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden || strings.Contains(string(body), "grace") || strings.Contains(string(body), "analysts") {
		t.Fatalf("status %d body %q: want a generic 403", resp.StatusCode, body)
	}
}

func TestHandlerNoXFF(t *testing.T) {
	r := newRealm(t)
	gate, _ := newGate(t, r, newApp(t).URL, nil)
	req, _ := http.NewRequest(http.MethodGet, gate.URL, nil)
	req.Header.Set("Authorization", "Bearer "+r.mint(t, keycloakClaims(time.Now())))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := resp.Header.Get("X-Seen-XFF"); got != "127.0.0.1" {
		t.Errorf("X-Forwarded-For %q, want the hop", got)
	}
}

func TestHandlerUpstreamDown(t *testing.T) {
	r := newRealm(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	gate, _ := newGate(t, r, "http://"+addr, nil)
	req, _ := http.NewRequest(http.MethodGet, gate.URL, nil)
	req.Header.Set("Authorization", "Bearer "+r.mint(t, keycloakClaims(time.Now())))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", resp.StatusCode)
	}
}

func TestHandlerWebSocketUpgrade(t *testing.T) {
	r := newRealm(t)
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
	gate, _ := newGate(t, r, up.URL, nil)

	conn, err := net.Dial("tcp", strings.TrimPrefix(gate.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Authorization: Bearer "+r.mint(t, keycloakClaims(time.Now()))+"\r\n\r\n")
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
	ready := false
	up, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = up.Close() }()
	d := &net.Dialer{}
	h := &Health{Ready: func() bool { return ready }, Upstream: up.Addr().String(), Dial: d.DialContext}

	get := func(path string) int {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code
	}
	if c := get("/healthz"); c != 200 {
		t.Errorf("/healthz %d", c)
	}
	if c := get("/readyz"); c != 503 {
		t.Errorf("/readyz before keys %d, want 503", c)
	}
	ready = true
	if c := get("/readyz"); c != 200 {
		t.Errorf("/readyz after keys %d", c)
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

func TestKeyWatch(t *testing.T) {
	r := newRealm(t)
	r.fail.Store(true)
	w := &KeyWatch{URL: r.jwksURL(), Client: r.srv.Client(), Every: 10 * time.Millisecond, Log: quietLog()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()

	deadline := time.Now().Add(5 * time.Second)
	for r.fetches.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if w.Ready() {
		t.Fatal("ready before a fetch succeeded")
	}
	r.fail.Store(false)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("did not become ready")
	}
	if !w.Ready() {
		t.Fatal("not ready after a successful fetch")
	}
}

func TestKeyWatchRejectsBadKeySets(t *testing.T) {
	for name, body := range map[string]string{"empty": `{"keys":[]}`, "not json": `<html>`} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) }))
			defer srv.Close()
			w := &KeyWatch{URL: srv.URL, Client: srv.Client(), Log: quietLog()}
			if err := w.fetch(context.Background()); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	w := &KeyWatch{URL: "http://127.0.0.1:1/\x00", Client: http.DefaultClient, Log: quietLog()}
	if err := w.fetch(context.Background()); err == nil {
		t.Fatal("bad URL accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w = &KeyWatch{URL: "http://127.0.0.1:1/", Client: http.DefaultClient, Every: time.Hour, Log: quietLog()}
	w.Run(ctx) // returns on a cancelled context
	if w.Ready() {
		t.Fatal("ready without keys")
	}
}

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnv(t *testing.T) {
	full := map[string]string{
		"AUTHZ_UPSTREAM":  "http://127.0.0.1:8081",
		"AUTHZ_ISSUERS":   internalIssuer + ", " + publicIssuer + ",",
		"AUTHZ_JWKS_URL":  "http://keycloak/realms/nebari/protocol/openid-connect/certs",
		"AUTHZ_CLIENT_ID": clientID,
		"AUTHZ_GROUPS":    "analysts, admin",
	}
	cfg, err := FromEnv(env(full))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" || cfg.HealthListen != ":8082" || cfg.GroupsClaim != "groups" || cfg.UsersClaim != "preferred_username" {
		t.Errorf("defaults: %+v", cfg)
	}
	if len(cfg.Issuers) != 2 || cfg.Issuers[1] != publicIssuer || len(cfg.Groups) != 2 || cfg.Groups[1] != "admin" {
		t.Errorf("lists: %+v", cfg)
	}

	usersOnly := maps.Clone(full)
	delete(usersOnly, "AUTHZ_GROUPS")
	usersOnly["AUTHZ_USERS"] = "ada,grace"
	usersOnly["AUTHZ_USERS_CLAIM"] = "email"
	if cfg, err := FromEnv(env(usersOnly)); err != nil || len(cfg.Users) != 2 || cfg.UsersClaim != "email" {
		t.Errorf("users only: %+v %v", cfg, err)
	}

	cases := map[string]struct {
		edit map[string]string
		want string
	}{
		"nothing to allow":  {map[string]string{"AUTHZ_GROUPS": " , "}, "AUTHZ_GROUPS or AUTHZ_USERS is required"},
		"no upstream":       {map[string]string{"AUTHZ_UPSTREAM": ""}, "AUTHZ_UPSTREAM is required"},
		"bad upstream":      {map[string]string{"AUTHZ_UPSTREAM": "127.0.0.1:8081"}, "AUTHZ_UPSTREAM"},
		"no issuers":        {map[string]string{"AUTHZ_ISSUERS": ""}, "AUTHZ_ISSUERS is required"},
		"no jwks":           {map[string]string{"AUTHZ_JWKS_URL": ""}, "AUTHZ_JWKS_URL is required"},
		"bad jwks":          {map[string]string{"AUTHZ_JWKS_URL": "keycloak/certs"}, "AUTHZ_JWKS_URL"},
		"no client":         {map[string]string{"AUTHZ_CLIENT_ID": ""}, "AUTHZ_CLIENT_ID is required"},
		"same listen ports": {map[string]string{"AUTHZ_HEALTH_LISTEN": ":8080"}, "must differ"},
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
	if _, err := FromEnv(env(nil)); err == nil || strings.Count(err.Error(), "\n") < 4 {
		t.Errorf("an empty environment should report every missing variable: %v", err)
	}
}

func TestRun(t *testing.T) {
	r := newRealm(t)
	app := newApp(t)
	cfg := testConfig(r)
	u, _ := url.Parse(app.URL)
	cfg.Upstream = u
	cfg.Listen = freeAddr(t)
	cfg.HealthListen = freeAddr(t)

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
	req, _ := http.NewRequest(http.MethodGet, "http://"+cfg.Listen+"/x", nil)
	req.Header.Set("Authorization", "Bearer "+r.mint(t, keycloakClaims(time.Now())))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("proxied status %d", resp.StatusCode)
	}
	cancel()
	if err := <-errc; err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRunPortInUse(t *testing.T) {
	r := newRealm(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	cfg := testConfig(r)
	cfg.Listen = freeAddr(t)
	cfg.HealthListen = busy.Addr().String()
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

func TestFromEnvPassthrough(t *testing.T) {
	cfg, err := FromEnv(env(map[string]string{
		"AUTHZ_UPSTREAM":    "http://127.0.0.1:8081",
		"AUTHZ_PASSTHROUGH": "true",
	}))
	if err != nil || !cfg.Passthrough {
		t.Fatalf("passthrough needs only an upstream: %+v %v", cfg, err)
	}
	for _, v := range []string{"AUTHZ_GROUPS", "AUTHZ_USERS"} {
		_, err := FromEnv(env(map[string]string{
			"AUTHZ_UPSTREAM":    "http://127.0.0.1:8081",
			"AUTHZ_PASSTHROUGH": "true",
			v:                   "analysts",
		}))
		if err == nil || !strings.Contains(err.Error(), "cannot be combined") {
			t.Errorf("passthrough with %s: %v", v, err)
		}
	}
	if _, err := FromEnv(env(map[string]string{"AUTHZ_PASSTHROUGH": "true"})); err == nil {
		t.Error("passthrough without an upstream should fail")
	}
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

func TestHandlerRecordsOnlyAllowedRequests(t *testing.T) {
	r := newRealm(t)
	app := newApp(t)
	cfg := testConfig(r)
	cfg.Upstream, _ = url.Parse(app.URL)
	now := time.Unix(1_000, 0)
	act := NewActivity(func() time.Time { return now })
	h := NewHandler(cfg, NewVerifier(cfg, oidc.NewRemoteKeySet(context.Background(), r.jwksURL())), http.DefaultTransport, quietLog())
	h.Activity = act
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	now = time.Unix(2_000, 0)
	resp, err := http.Get(srv.URL + "/denied")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got := act.LastRequest().Unix(); got != 1_000 {
		t.Errorf("a refused request counted as activity: %d", got)
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/ok", nil)
	req.Header.Set("Authorization", "Bearer "+r.mint(t, keycloakClaims(time.Now())))
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || act.LastRequest().Unix() != 2_000 {
		t.Errorf("allowed request: status %d, last %d", resp.StatusCode, act.LastRequest().Unix())
	}
}

func TestRunPassthrough(t *testing.T) {
	app := newApp(t)
	u, _ := url.Parse(app.URL)
	cfg := Config{Upstream: u, Passthrough: true, Listen: freeAddr(t), HealthListen: freeAddr(t)}

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
		t.Fatalf("passthrough without a token: status %d", resp.StatusCode)
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
