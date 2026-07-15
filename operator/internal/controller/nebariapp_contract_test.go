package controller

// The NebariApp CR is consumed as a versioned contract with the
// nebari-operator (pinned: v0.1.0-alpha.19). These tests pin the exact shape
// this pack emits so contract drift shows up as a test failure, not a broken
// cluster. Field reference:
// https://github.com/nebari-dev/software-pack-template/blob/main/docs/nebariapp-crd-reference.md

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

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
