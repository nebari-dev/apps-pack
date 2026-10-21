package controller

import (
	"context"
	"reflect"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

const testAuthzImage = "ghcr.io/nebari-dev/apps-pack/apps-authz:test"

func restrictedApp(app *appsv1alpha1.App, groups, users []string) *appsv1alpha1.App {
	app.Spec.Access.Public = false
	app.Spec.Access.Groups = groups
	app.Spec.Access.Users = users
	return app
}

func envOf(c corev1.Container) map[string]string {
	out := map[string]string{}
	for _, e := range c.Env {
		out[e.Name] = e.Value
	}
	return out
}

func deployed(t *testing.T, app *appsv1alpha1.App) (*appsv1.Deployment, *corev1.Service, *corev1.ConfigMap, *AppReconciler) {
	t.Helper()
	r, c := newReconciler(t, managedNamespace(app.Namespace), app)
	reconcile(t, r, app)
	if got := getApp(t, c, app.Name, app.Namespace); got.Status.Phase == appsv1alpha1.AppPhaseFailed {
		t.Fatalf("app failed: %s", got.Status.Message)
	}
	ctx := context.Background()
	key := types.NamespacedName{Name: childName(app), Namespace: app.Namespace}
	d, svc := &appsv1.Deployment{}, &corev1.Service{}
	if err := c.Get(ctx, key, d); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, key, svc); err != nil {
		t.Fatal(err)
	}
	cm := &corev1.ConfigMap{}
	if err := c.Get(ctx, types.NamespacedName{Name: key.Name + "-server", Namespace: app.Namespace}, cm); err != nil {
		cm = nil
	}
	return d, svc, cm, r
}

func TestAuthzSidecarStaticApp(t *testing.T) {
	app := restrictedApp(inlineApp("apps"), []string{"analysts", "admin"}, nil)
	app.Name = "web-terminal"
	d, svc, cm, _ := deployed(t, app)
	pod := d.Spec.Template.Spec

	if len(pod.Containers) != 2 || pod.Containers[0].Name != "app" || pod.Containers[1].Name != "authz" {
		t.Fatalf("containers = %+v, want app then authz", names(pod.Containers))
	}
	main, side := pod.Containers[0], pod.Containers[1]
	if d.Spec.Template.Annotations["kubectl.kubernetes.io/default-container"] != "app" {
		t.Error("kubectl should default to the app container")
	}

	if len(main.Ports) != 1 || main.Ports[0].ContainerPort != AppInternalPort || main.Ports[0].Name == "http" {
		t.Errorf("app ports = %+v, want only %d under another name", main.Ports, AppInternalPort)
	}
	for _, p := range []*corev1.Probe{main.ReadinessProbe, main.LivenessProbe} {
		if p == nil || p.HTTPGet == nil || p.HTTPGet.Path != "/upstreamz" || p.HTTPGet.Port.IntVal != authzHealthPort {
			t.Errorf("app probe = %+v, want the sidecar's /upstreamz", p)
		}
	}
	if conf := cm.Data["default.conf"]; !strings.Contains(conf, "listen 127.0.0.1:8081;") {
		t.Errorf("nginx should listen on loopback only:\n%s", conf)
	}
	if d.Spec.Template.Annotations["apps.nebari.dev/server-config-checksum"] != (OperatorConfig{}).serverConfChecksum(app) {
		t.Error("server-config checksum does not follow the restricted config")
	}

	// The Service and NetworkPolicy keep targeting 8080 ("http"), now the sidecar.
	if svc.Spec.Ports[0].Port != AppPort || svc.Spec.Ports[0].TargetPort.StrVal != "http" {
		t.Errorf("service ports = %+v", svc.Spec.Ports)
	}
	if side.Ports[0].Name != "http" || side.Ports[0].ContainerPort != AppPort {
		t.Errorf("sidecar ports = %+v", side.Ports)
	}

	want := map[string]string{
		"AUTHZ_LISTEN":        ":8080",
		"AUTHZ_HEALTH_LISTEN": ":8082",
		"AUTHZ_UPSTREAM":      "http://127.0.0.1:8081",
		"AUTHZ_ISSUERS": "https://keycloak.nebari.local/realms/nebari," +
			"http://keycloak-keycloakx-http.keycloak.svc.cluster.local:8080/realms/nebari",
		"AUTHZ_JWKS_URL":  "http://keycloak-keycloakx-http.keycloak.svc.cluster.local:8080/realms/nebari/protocol/openid-connect/certs",
		"AUTHZ_CLIENT_ID": "apps-app-web-terminal",
		"AUTHZ_GROUPS":    "analysts,admin",
	}
	if got := envOf(side); !reflect.DeepEqual(got, want) {
		t.Errorf("sidecar env =\n%v\nwant\n%v", got, want)
	}
	if side.Image != testAuthzImage {
		t.Errorf("sidecar image = %q", side.Image)
	}
	if !reflect.DeepEqual(side.Resources, DefaultAuthzResources) {
		t.Errorf("sidecar resources = %+v", side.Resources)
	}
	sc := side.SecurityContext
	if sc == nil || !*sc.RunAsNonRoot || *sc.AllowPrivilegeEscalation || !*sc.ReadOnlyRootFilesystem ||
		len(sc.Capabilities.Drop) != 1 || sc.Capabilities.Drop[0] != "ALL" {
		t.Errorf("sidecar security context = %+v", sc)
	}
	if side.ReadinessProbe.HTTPGet.Path != "/readyz" || side.LivenessProbe.HTTPGet.Path != "/healthz" {
		t.Errorf("sidecar probes = %+v %+v", side.ReadinessProbe, side.LivenessProbe)
	}
	if *pod.AutomountServiceAccountToken {
		t.Error("restricted pods must not mount a ServiceAccount token")
	}
}

func TestAuthzSidecarPixiApp(t *testing.T) {
	app := restrictedApp(pixiApp("apps"), nil, []string{"alice"})
	d, _, _, _ := deployed(t, app)
	pod := d.Spec.Template.Spec
	if len(pod.Containers) != 2 {
		t.Fatalf("containers = %v", names(pod.Containers))
	}
	main := pod.Containers[0]
	if envOf(main)["PORT"] != "8081" {
		t.Errorf("PORT = %q, want 8081", envOf(main)["PORT"])
	}
	for _, p := range []*corev1.Probe{main.StartupProbe, main.ReadinessProbe, main.LivenessProbe} {
		if p == nil || p.HTTPGet == nil || p.HTTPGet.Path != "/upstreamz" || p.HTTPGet.Port.IntVal != authzHealthPort || p.TCPSocket != nil {
			t.Errorf("app probe = %+v, want the sidecar's /upstreamz", p)
		}
	}
	if main.StartupProbe.FailureThreshold != 60 {
		t.Error("the cold-start budget of the startup probe should be kept")
	}
	env := envOf(pod.Containers[1])
	if env["AUTHZ_USERS"] != "alice" {
		t.Errorf("AUTHZ_USERS = %q", env["AUTHZ_USERS"])
	}
	if _, has := env["AUTHZ_GROUPS"]; has {
		t.Error("AUTHZ_GROUPS should be absent when the App lists only users")
	}
}

// Apps that do not restrict access get exactly the pod they got before the
// sidecar existed, whatever the authz settings.
func TestUnrestrictedAppsHaveNoSidecar(t *testing.T) {
	publicWithLists := inlineApp("team-a")
	publicWithLists.Spec.Access.Groups = []string{"x"}
	publicWithLists.Spec.Access.Users = []string{"u"}
	private := inlineApp("team-a")
	private.Spec.Access.Public = false
	privatePixi := pixiApp("team-a")
	privatePixi.Spec.Access.Public = false

	for name, app := range map[string]*appsv1alpha1.App{
		"public": inlineApp("team-a"), "public with lists": publicWithLists,
		"private": private, "private pixi": privatePixi,
	} {
		t.Run(name, func(t *testing.T) {
			r, _ := newReconciler(t)
			withAuthz, err := r.buildDeployment(app)
			if err != nil {
				t.Fatal(err)
			}
			bare := *r
			bare.Config.AuthzImage, bare.Config.KeycloakURL, bare.Config.KeycloakInternalURL = "", "", ""
			without, err := bare.buildDeployment(app)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(withAuthz, without) {
				t.Error("the authz settings changed an unrestricted App's Deployment")
			}
			pod := withAuthz.Spec.Template.Spec
			if len(pod.Containers) != 1 || pod.Containers[0].Ports[0].Name != "http" || pod.Containers[0].Ports[0].ContainerPort != AppPort {
				t.Errorf("pod = %+v", pod.Containers)
			}
			if cm := r.Config.buildServerConfigMap(app); cm != nil && !strings.Contains(cm.Data["default.conf"], "listen 8080;") {
				t.Error("nginx should listen on 8080")
			}
			auth, _, _ := unstructured.NestedMap(r.buildNebariApp(app).Object, "spec", "auth")
			for _, k := range []string{"forwardAccessToken", "enforceAtGateway", "users"} {
				if _, has := auth[k]; has {
					t.Errorf("auth.%s set on an unrestricted App", k)
				}
			}
		})
	}
}

func TestAuthzMisconfigurationFailsValidation(t *testing.T) {
	cases := map[string]struct {
		edit   func(*OperatorConfig)
		groups []string
		want   string
	}{
		"no image":       {func(c *OperatorConfig) { c.AuthzImage = "" }, []string{"a"}, "--authz-image"},
		"no keycloak":    {func(c *OperatorConfig) { c.KeycloakURL, c.KeycloakInternalURL = "", "" }, []string{"a"}, "--keycloak-url"},
		"comma in group": {func(*OperatorConfig) {}, []string{"a,b"}, "must not contain ','"},
		"blank group":    {func(*OperatorConfig) {}, []string{" "}, "must be non-empty"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			app := restrictedApp(inlineApp("team-a"), tc.groups, nil)
			r, c := newReconciler(t, managedNamespace("team-a"), app)
			tc.edit(&r.Config)
			reconcile(t, r, app)
			got := getApp(t, c, app.Name, app.Namespace)
			if got.Status.Phase != appsv1alpha1.AppPhaseFailed || !strings.Contains(got.Status.Message, tc.want) {
				t.Errorf("phase %s message %q, want Failed with %q", got.Status.Phase, got.Status.Message, tc.want)
			}
			if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: "team-a"}, &appsv1.Deployment{}); err == nil {
				t.Error("a Deployment was created for an App whose access cannot be enforced")
			}
		})
	}
}

func TestAuthzKeycloakURLs(t *testing.T) {
	c := OperatorConfig{KeycloakURL: "https://kc.example.ai/auth/", KeycloakRealm: "r"}
	if got := c.authzIssuers(); !reflect.DeepEqual(got, []string{"https://kc.example.ai/auth/realms/r"}) {
		t.Errorf("issuers = %v", got)
	}
	if got := c.authzJWKSURL(); got != "https://kc.example.ai/auth/realms/r/protocol/openid-connect/certs" {
		t.Errorf("jwks = %q (public URL when there is no internal one)", got)
	}
	c = OperatorConfig{KeycloakURL: "http://kc", KeycloakInternalURL: "http://kc"}
	if got := c.authzIssuers(); !reflect.DeepEqual(got, []string{"http://kc/realms/nebari"}) {
		t.Errorf("issuers = %v, want one deduplicated issuer in the default realm", got)
	}
}

// The sidecar binds tokens to the client nebari-operator provisions for the
// NebariApp: naming.ClientID is "<namespace>-<NebariApp name>" (live example:
// apps-app-web-terminal). If nebari-operator changes that, restricted Apps
// deny everyone; update oidcClientID with the contract pin.
func TestAuthzClientIDMatchesNebariOperator(t *testing.T) {
	app := inlineApp("apps")
	app.Name = "web-terminal"
	na := testReconciler().buildNebariApp(app)
	if got, want := oidcClientID(app), na.GetNamespace()+"-"+na.GetName(); got != want || got != "apps-app-web-terminal" {
		t.Errorf("client ID = %q, want %q", got, want)
	}
}

func names(cs []corev1.Container) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Name)
	}
	return out
}
