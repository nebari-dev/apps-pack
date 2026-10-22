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

func restrictedApp(app *appsv1alpha1.App, groups []string) *appsv1alpha1.App {
	app.Spec.Access.Public = false
	app.Spec.Access.Groups = groups
	return app
}

func envOf(c corev1.Container) map[string]string {
	out := map[string]string{}
	for _, e := range c.Env {
		out[e.Name] = e.Value
	}
	return out
}

// deployed reconciles app once on a cluster where Apps idle after 30 minutes
// (so every App runs the sidecar) and returns its children.
func deployed(t *testing.T, app *appsv1alpha1.App) (*appsv1.Deployment, *corev1.Service, *corev1.ConfigMap, *AppReconciler) {
	t.Helper()
	r, c, _ := idleReconciler(t, newFakePodActivity(t), managedNamespace(app.Namespace), app)
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

// The sidecar only proxies: the environment carries no token or group
// settings, even for an App that lists access.groups (the gateway enforces
// them).
var passthroughEnv = map[string]string{
	"AUTHZ_LISTEN":        ":8080",
	"AUTHZ_HEALTH_LISTEN": ":8082",
	"AUTHZ_UPSTREAM":      "http://127.0.0.1:8081",
}

func TestAuthzSidecarStaticApp(t *testing.T) {
	app := restrictedApp(inlineApp("apps"), []string{"analysts", "admin"})
	app.Name = "web-terminal"
	d, svc, cm, r := deployed(t, app)
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
	if d.Spec.Template.Annotations["apps.nebari.dev/server-config-checksum"] != r.Config.serverConfChecksum(app) {
		t.Error("server-config checksum does not follow the sidecar config")
	}

	// The Service and NetworkPolicy keep targeting 8080 ("http"), now the sidecar.
	if svc.Spec.Ports[0].Port != AppPort || svc.Spec.Ports[0].TargetPort.StrVal != "http" {
		t.Errorf("service ports = %+v", svc.Spec.Ports)
	}
	if side.Ports[0].Name != "http" || side.Ports[0].ContainerPort != AppPort {
		t.Errorf("sidecar ports = %+v", side.Ports)
	}

	if got := envOf(side); !reflect.DeepEqual(got, passthroughEnv) {
		t.Errorf("sidecar env =\n%v\nwant\n%v", got, passthroughEnv)
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
		t.Error("app pods must not mount a ServiceAccount token")
	}
}

func TestAuthzSidecarPixiApp(t *testing.T) {
	app := restrictedApp(pixiApp("apps"), []string{"analysts"})
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
	if got := envOf(pod.Containers[1]); !reflect.DeepEqual(got, passthroughEnv) {
		t.Errorf("sidecar env = %v, want %v", got, passthroughEnv)
	}
}

// Apps that neither idle nor run an image get exactly the pod they got before
// the sidecar existed, whatever the authz settings, restricted ones included:
// the gateway enforces access.groups.
func TestAppsThatNeitherIdleNorRunAnImageHaveNoSidecar(t *testing.T) {
	publicWithLists := inlineApp("team-a")
	publicWithLists.Spec.Access.Groups = []string{"x"}
	private := inlineApp("team-a")
	private.Spec.Access.Public = false
	privatePixi := pixiApp("team-a")
	privatePixi.Spec.Access.Public = false

	for name, app := range map[string]*appsv1alpha1.App{
		"public": inlineApp("team-a"), "public with lists": publicWithLists,
		"private": private, "private pixi": privatePixi,
		"restricted":      restrictedApp(inlineApp("team-a"), []string{"analysts"}),
		"restricted pixi": restrictedApp(pixiApp("team-a"), []string{"/ops/oncall"}),
	} {
		t.Run(name, func(t *testing.T) {
			r, _ := newReconciler(t)
			withAuthz, err := r.buildDeployment(app)
			if err != nil {
				t.Fatal(err)
			}
			bare := *r
			bare.Config.AuthzImage = ""
			without, err := bare.buildDeployment(app)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(withAuthz, without) {
				t.Error("the authz settings changed the App's Deployment")
			}
			pod := withAuthz.Spec.Template.Spec
			if len(pod.Containers) != 1 || pod.Containers[0].Ports[0].Name != "http" || pod.Containers[0].Ports[0].ContainerPort != AppPort {
				t.Errorf("pod = %+v", pod.Containers)
			}
			if cm := r.Config.buildServerConfigMap(app); cm != nil && !strings.Contains(cm.Data["default.conf"], "listen 8080;") {
				t.Error("nginx should listen on 8080")
			}
			auth, _, _ := unstructured.NestedMap(r.buildNebariApp(app).Object, "spec", "auth")
			if _, has := auth["forwardAccessToken"]; has {
				t.Error("auth.forwardAccessToken set: no sidecar reads the token any more")
			}
			if _, has := auth["users"]; has {
				t.Error("auth.users should never be emitted")
			}
		})
	}
}

func TestAuthzMisconfigurationFailsValidation(t *testing.T) {
	cases := map[string]struct {
		app  *appsv1alpha1.App
		edit func(*OperatorConfig)
		want string
	}{
		"image without sidecar image": {imageApp("team-a", "nginx:1.27"), func(c *OperatorConfig) {
			c.ImageRegistries = []string{"docker.io/library"}
			c.AuthzImage = ""
		}, "--authz-image"},
		"blank group": {restrictedApp(inlineApp("team-a"), []string{" "}), func(*OperatorConfig) {}, "must name a group"},
		"root group":  {restrictedApp(inlineApp("team-a"), []string{"analysts", "/"}), func(*OperatorConfig) {}, "must name a group"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			app := tc.app
			r, c := newReconciler(t, managedNamespace("team-a"), app)
			tc.edit(&r.Config)
			reconcile(t, r, app)
			got := getApp(t, c, app.Name, app.Namespace)
			if got.Status.Phase != appsv1alpha1.AppPhaseFailed || !strings.Contains(got.Status.Message, tc.want) {
				t.Errorf("phase %s message %q, want Failed with %q", got.Status.Phase, got.Status.Message, tc.want)
			}
			if err := c.Get(context.Background(), types.NamespacedName{Name: childName(app), Namespace: "team-a"}, &appsv1.Deployment{}); err == nil {
				t.Error("a Deployment was created for an App that failed validation")
			}
		})
	}
}

// groupPath mirrors nebari-operator's groups.NormalizePath (v0.2.0), which
// decides what the gateway matches.
func TestGroupPath(t *testing.T) {
	for in, want := range map[string]string{
		"finance":      "/finance",
		"/finance":     "/finance",
		" /finance/ ":  "/finance",
		"/ops//oncall": "/ops/oncall",
		"parent/child": "/parent/child",
		"/":            "",
		"   ":          "",
		"a,b":          "/a,b",
	} {
		if got := groupPath(in); got != want {
			t.Errorf("groupPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func names(cs []corev1.Container) []string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Name)
	}
	return out
}
