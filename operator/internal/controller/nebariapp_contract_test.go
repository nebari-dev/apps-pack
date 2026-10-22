package controller

// The NebariApp CR is consumed as a versioned contract with the
// nebari-operator (pinned: NebariOperatorContract). These tests pin the exact shape
// this pack emits so contract drift shows up as a test failure, not a broken
// cluster. Field reference:
// https://github.com/nebari-dev/software-pack-template/blob/main/docs/nebariapp-crd-reference.md

import (
	"os"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

func TestContractVersionIsTheRepoPin(t *testing.T) {
	pin, err := os.ReadFile("../../../.nebari-operator-version")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(pin)); got != NebariOperatorContract {
		t.Fatalf(".nebari-operator-version is %s but the NebariApp contract is %s: "+
			"update the contract tests and NebariOperatorContract together with the pin", got, NebariOperatorContract)
	}
}

func testReconciler() *AppReconciler {
	return &AppReconciler{
		Config: OperatorConfig{AppsDomain: "apps.nebari.example.ai", Gateway: "public"},
	}
}

func TestNebariAppContractPrivateApp(t *testing.T) {
	app := inlineApp("team-analytics")
	app.Name = "sales-dashboard"
	app.Spec.DisplayName = "Sales Dashboard"
	app.Spec.Description = "Q2 sales explorer"
	app.Spec.Access = appsv1alpha1.AppAccess{
		Public:    false,
		Groups:    []string{"analytics"},
		Subdomain: "sales-dashboard",
	}
	app.Spec.LandingPage = &appsv1alpha1.AppLandingPage{Enabled: ptr.To(true)}

	na := testReconciler().buildNebariApp(app)

	if got := na.GetAPIVersion(); got != "reconcilers.nebari.dev/v1" {
		t.Errorf("apiVersion = %q", got)
	}
	if got := na.GetKind(); got != "NebariApp" {
		t.Errorf("kind = %q", got)
	}
	if got := na.GetName(); got != "app-sales-dashboard" {
		t.Errorf("name = %q", got)
	}

	spec := na.Object["spec"].(map[string]any)

	if got := spec["hostname"]; got != "sales-dashboard.apps.nebari.example.ai" {
		t.Errorf("hostname = %v", got)
	}
	if got := spec["gateway"]; got != "public" {
		t.Errorf("gateway = %v", got)
	}

	svc := spec["service"].(map[string]any)
	if svc["name"] != "app-sales-dashboard" || svc["port"] != int64(AppPort) {
		t.Errorf("service = %+v", svc)
	}

	tlsEnabled, _, _ := unstructured.NestedBool(na.Object, "spec", "routing", "tls", "enabled")
	if !tlsEnabled {
		t.Error("routing.tls.enabled should default to true")
	}

	routes, _, _ := unstructured.NestedSlice(na.Object, "spec", "routing", "routes")
	if len(routes) != 1 {
		t.Fatalf("routes = %+v", routes)
	}
	route := routes[0].(map[string]any)
	if route["pathPrefix"] != "/" || route["pathType"] != "PathPrefix" {
		t.Errorf("route = %+v", route)
	}

	auth := spec["auth"].(map[string]any)
	if auth["enabled"] != true {
		t.Error("auth.enabled should be true for a private app")
	}
	if auth["provider"] != "keycloak" || auth["provisionClient"] != true {
		t.Errorf("auth = %+v", auth)
	}
	groups := auth["groups"].([]any)
	if len(groups) != 1 || groups[0] != "analytics" {
		t.Errorf("auth.groups = %+v", groups)
	}
	// The gateway enforces the groups (nebari-operator v0.2.0+): a signed-in
	// non-member gets 403 there. No sidecar reads the token, so it is not
	// forwarded to the (untrusted) app.
	if auth["enforceAtGateway"] != true {
		t.Errorf("auth.enforceAtGateway = %v, want true", auth["enforceAtGateway"])
	}
	if _, has := auth["forwardAccessToken"]; has {
		t.Errorf("auth.forwardAccessToken = %v, want unset", auth["forwardAccessToken"])
	}
	scopes := auth["scopes"].([]any)
	want := []string{"openid", "profile", "email", "groups"}
	if len(scopes) != len(want) {
		t.Fatalf("auth.scopes = %+v", scopes)
	}
	for i, s := range want {
		if scopes[i] != s {
			t.Errorf("auth.scopes[%d] = %v, want %s", i, scopes[i], s)
		}
	}

	landing := spec["landingPage"].(map[string]any)
	if landing["enabled"] != true || landing["displayName"] != "Sales Dashboard" || landing["category"] != "Apps" {
		t.Errorf("landingPage = %+v", landing)
	}
	if landing["description"] != "Q2 sales explorer" {
		t.Errorf("landingPage.description = %v", landing["description"])
	}
}

// A group-restricted App hands its entries to the gateway as written:
// nebari-operator normalizes them to full group paths ("analysts" is
// "/analysts") and matches them exactly, so a subgroup path passes through
// unchanged. It never emits auth.users or forwards the token.
func TestNebariAppContractGroupsEnforcedAtGateway(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Access = appsv1alpha1.AppAccess{Groups: []string{"analysts", "/ops/oncall"}, Subdomain: "docs-site"}

	auth, _, _ := unstructured.NestedMap(testReconciler().buildNebariApp(app).Object, "spec", "auth")
	if auth["enabled"] != true || auth["provider"] != "keycloak" || auth["enforceAtGateway"] != true {
		t.Errorf("auth = %+v, want keycloak sign-in enforced at the gateway", auth)
	}
	groups, _, _ := unstructured.NestedStringSlice(auth, "groups")
	if len(groups) != 2 || groups[0] != "analysts" || groups[1] != "/ops/oncall" {
		t.Errorf("auth.groups = %v, want [analysts /ops/oncall]", groups)
	}
	for _, k := range []string{"users", "forwardAccessToken"} {
		if _, has := auth[k]; has {
			t.Errorf("auth.%s should not be emitted", k)
		}
	}
}

// A private App open to any signed-in user does not forward the token.
func TestNebariAppContractPrivateWithoutLists(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Access.Public = false

	auth, _, _ := unstructured.NestedMap(testReconciler().buildNebariApp(app).Object, "spec", "auth")
	for _, k := range []string{"forwardAccessToken", "enforceAtGateway", "groups"} {
		if _, has := auth[k]; has {
			t.Errorf("auth.%s should not be emitted", k)
		}
	}
}

func TestNebariAppContractTLSDisabled(t *testing.T) {
	app := inlineApp("team-a")
	r := testReconciler()
	r.Config.TLSDisabled = true

	na := r.buildNebariApp(app)
	tlsEnabled, _, _ := unstructured.NestedBool(na.Object, "spec", "routing", "tls", "enabled")
	if tlsEnabled {
		t.Error("routing.tls.enabled should be false when TLS is disabled")
	}
	if r.Config.Scheme() != "http" {
		t.Errorf("scheme = %q, want http", r.Config.Scheme())
	}
}

func TestNebariAppContractPublicApp(t *testing.T) {
	app := inlineApp("team-a")
	app.Spec.Access = appsv1alpha1.AppAccess{Public: true, Subdomain: "docs-site"}

	na := testReconciler().buildNebariApp(app)
	auth, _, _ := unstructured.NestedMap(na.Object, "spec", "auth")

	if auth["enabled"] != false {
		t.Error("auth.enabled should be false for a public app")
	}
	if _, has := auth["provisionClient"]; has {
		t.Error("public apps should not provision an OIDC client")
	}
	if _, has := auth["groups"]; has {
		t.Error("public apps should not carry auth groups")
	}
}

func TestNebariAppContractLandingPageOffByDefault(t *testing.T) {
	app := inlineApp("team-a")
	na := testReconciler().buildNebariApp(app)

	landing, _, _ := unstructured.NestedMap(na.Object, "spec", "landingPage")
	if landing["enabled"] != false {
		t.Errorf("landingPage.enabled = %v, want false by default", landing["enabled"])
	}
	for _, k := range []string{"displayName", "description", "icon", "category"} {
		if _, has := landing[k]; has {
			t.Errorf("disabled landing page should not carry %s", k)
		}
	}
}

func TestNebariAppContractLandingPageClusterDefault(t *testing.T) {
	r := testReconciler()
	r.Config.LandingPage = true

	app := inlineApp("team-a")
	na := r.buildNebariApp(app)
	enabled, _, _ := unstructured.NestedBool(na.Object, "spec", "landingPage", "enabled")
	if !enabled {
		t.Error("landingPage.enabled should follow the cluster default (true)")
	}
	name, _, _ := unstructured.NestedString(na.Object, "spec", "landingPage", "displayName")
	if name != app.Spec.DisplayName {
		t.Errorf("landingPage.displayName = %q, want %q", name, app.Spec.DisplayName)
	}

	// A per-app opt-out wins over the cluster default.
	app.Spec.LandingPage = &appsv1alpha1.AppLandingPage{Enabled: ptr.To(false)}
	na = r.buildNebariApp(app)
	enabled, _, _ = unstructured.NestedBool(na.Object, "spec", "landingPage", "enabled")
	if enabled {
		t.Error("spec.landingPage.enabled=false should override the cluster default")
	}
}

// An idle (or waking) App's NebariApp routes to the activator Service in the
// operator's namespace through spec.service.namespace; everything else is
// unchanged.
func TestNebariAppContractIdleRoutesToActivator(t *testing.T) {
	app := inlineApp("team-analytics")
	r := testReconciler()
	r.Config.ActivatorService = "nebari-apps-activator"
	r.Config.ActivatorNamespace = "nebari-apps"
	na := r.buildNebariApp(app)
	before, _, _ := unstructured.NestedMap(na.Object, "spec", "auth")
	r.Config.routeToActivator(na)

	svc, _, _ := unstructured.NestedMap(na.Object, "spec", "service")
	want := map[string]any{"name": "nebari-apps-activator", "namespace": "nebari-apps", "port": int64(ActivatorServicePort)}
	if len(svc) != len(want) {
		t.Fatalf("service = %+v, want %+v", svc, want)
	}
	for k, v := range want {
		if svc[k] != v {
			t.Errorf("service.%s = %v, want %v", k, svc[k], v)
		}
	}
	after, _, _ := unstructured.NestedMap(na.Object, "spec", "auth")
	if len(after) != len(before) || after["enabled"] != before["enabled"] {
		t.Errorf("auth changed: %+v -> %+v", before, after)
	}
}

// A restricted App keeps its gateway group rule while it idles, so the
// activator's wake page is only shown to members.
func TestNebariAppContractIdleRestrictedKeepsGroups(t *testing.T) {
	app := inlineApp("team-analytics")
	app.Spec.Access.Public = false
	app.Spec.Access.Groups = []string{"analysts"}
	r := testReconciler()
	r.Config.ActivatorService = "nebari-apps-activator"
	r.Config.ActivatorNamespace = "nebari-apps"
	na := r.buildNebariApp(app)
	r.Config.routeToActivator(na)

	groups, _, _ := unstructured.NestedStringSlice(na.Object, "spec", "auth", "groups")
	enforce, _, _ := unstructured.NestedBool(na.Object, "spec", "auth", "enforceAtGateway")
	if len(groups) != 1 || groups[0] != "analysts" || !enforce {
		t.Errorf("auth.groups = %v enforceAtGateway = %v, want [analysts] true", groups, enforce)
	}
}
