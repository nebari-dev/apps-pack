package gate

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// leeway absorbs clock skew between Keycloak and this node for exp and nbf.
const leeway = 30 * time.Second

// signingAlgs are the asymmetric algorithms a token may be signed with;
// HMAC and "none" are never accepted. Keycloak signs with RS256 by default.
var signingAlgs = []string{
	oidc.RS256, oidc.RS384, oidc.RS512,
	oidc.PS256, oidc.PS384, oidc.PS512,
	oidc.ES256, oidc.ES384, oidc.ES512,
}

// Denial is why a token was refused. Reason is safe to log: it never
// contains the token or claim values.
type Denial struct{ Reason string }

func (d *Denial) Error() string { return d.Reason }

func deny(format string, a ...any) error { return &Denial{Reason: fmt.Sprintf(format, a...)} }

// Verifier checks a bearer access token: signature against the realm's
// JWKS, exp/nbf, iss, the client binding, then the allow lists.
type Verifier struct {
	jwt         *oidc.IDTokenVerifier
	issuers     []string
	clientID    string
	groups      map[string]bool
	groupsClaim string
	now         func() time.Time
}

// NewVerifier verifies with keys (an *oidc.RemoteKeySet in production).
func NewVerifier(cfg Config, keys oidc.KeySet) *Verifier {
	v := &Verifier{
		issuers:     cfg.Issuers,
		clientID:    cfg.ClientID,
		groups:      map[string]bool{},
		groupsClaim: cfg.GroupsClaim,
		now:         time.Now,
	}
	for _, g := range cfg.Groups {
		v.groups[normalizeGroup(g)] = true
	}
	// go-oidc checks the signature and algorithm only; the claim checks
	// below accept several issuers, use azp and allow clock skew both ways.
	v.jwt = oidc.NewVerifier("", keys, &oidc.Config{
		SkipClientIDCheck:    true,
		SkipIssuerCheck:      true,
		SkipExpiryCheck:      true,
		SupportedSigningAlgs: signingAlgs,
	})
	return v
}

// Verify returns nil when the token may pass and a *Denial otherwise. A key
// set that cannot be fetched also denies (fail closed).
func (v *Verifier) Verify(ctx context.Context, raw string) error {
	tok, err := v.jwt.Verify(ctx, raw)
	if err != nil {
		return deny("invalid token: signature, algorithm or format")
	}
	var c map[string]json.RawMessage
	if err := tok.Claims(&c); err != nil {
		return deny("invalid token: claims are not a JSON object")
	}

	now := v.now()
	var exp, nbf *float64
	if err := optional(c, "exp", &exp); err != nil || exp == nil {
		return deny("invalid token: no exp")
	}
	if now.After(unix(*exp).Add(leeway)) {
		return deny("token expired")
	}
	if err := optional(c, "nbf", &nbf); err != nil {
		return deny("invalid token: nbf")
	}
	if nbf != nil && now.Add(leeway).Before(unix(*nbf)) {
		return deny("token not valid yet (nbf)")
	}

	var typ string
	if err := optional(c, "typ", &typ); err != nil {
		return deny("invalid token: typ")
	}
	// Keycloak marks access tokens "Bearer"; an ID or refresh token for the
	// same client is not a credential for the app.
	if typ != "" && !strings.EqualFold(typ, "Bearer") {
		return deny("not an access token (typ %q)", typ)
	}

	if !slices.Contains(v.issuers, tok.Issuer) {
		return deny("issuer not accepted")
	}

	var azp string
	if err := optional(c, "azp", &azp); err != nil {
		return deny("invalid token: azp")
	}
	if azp != v.clientID && !slices.Contains(tok.Audience, v.clientID) {
		return deny("token was issued to another client")
	}

	if v.groupsAllow(c) {
		return nil
	}
	return deny("user is not in an allowed group")
}

// groupsAllow reports whether the groups claim (a string array, or a single
// string) names an allowed group. A leading "/" (Keycloak's full group
// path) is ignored on both sides.
func (v *Verifier) groupsAllow(c map[string]json.RawMessage) bool {
	raw, ok := c[v.groupsClaim]
	if !ok || len(v.groups) == 0 {
		return false
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		var one string
		if err := json.Unmarshal(raw, &one); err != nil {
			return false
		}
		list = []string{one}
	}
	for _, g := range list {
		if v.groups[normalizeGroup(g)] {
			return true
		}
	}
	return false
}

func normalizeGroup(g string) string { return strings.TrimPrefix(strings.TrimSpace(g), "/") }

// optional decodes claim name into dst when it is present.
func optional(c map[string]json.RawMessage, name string, dst any) error {
	raw, ok := c[name]
	if !ok {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func unix(sec float64) time.Time {
	return time.Unix(0, int64(sec*float64(time.Second)))
}
