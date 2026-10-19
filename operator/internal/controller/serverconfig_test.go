package controller

import (
	"context"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
)

func TestStaticAppsServeWithSecurityHeaders(t *testing.T) {
	app := inlineApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)
	ctx := context.Background()

	cm := &corev1.ConfigMap{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site-server", Namespace: "team-a"}, cm); err != nil {
		t.Fatalf("server ConfigMap not created: %v", err)
	}
	if len(cm.OwnerReferences) != 1 || cm.OwnerReferences[0].Kind != "App" {
		t.Errorf("server ConfigMap missing App ownerReference: %+v", cm.OwnerReferences)
	}
	conf := cm.Data["default.conf"]
	for _, want := range []string{
		"listen 8080;",
		"root /usr/share/nginx/html;",
		`X-Content-Type-Options "nosniff" always`,
		`X-Frame-Options "SAMEORIGIN" always`,
		"frame-ancestors 'self'",
	} {
		if !strings.Contains(conf, want) {
			t.Errorf("default.conf missing %q:\n%s", want, conf)
		}
	}

	deploy := &appsv1.Deployment{}
	if err := c.Get(ctx, types.NamespacedName{Name: "app-docs-site", Namespace: "team-a"}, deploy); err != nil {
		t.Fatalf("Deployment not created: %v", err)
	}
	pod := deploy.Spec.Template.Spec
	var mounted bool
	for _, m := range pod.Containers[0].VolumeMounts {
		if m.Name == serverConfVolume && m.MountPath == "/etc/nginx/conf.d" && m.ReadOnly {
			mounted = true
		}
	}
	if !mounted {
		t.Errorf("server config not mounted read-only at /etc/nginx/conf.d: %+v", pod.Containers[0].VolumeMounts)
	}
	var vol *corev1.Volume
	for i := range pod.Volumes {
		if pod.Volumes[i].Name == serverConfVolume {
			vol = &pod.Volumes[i]
		}
	}
	if vol == nil || vol.ConfigMap == nil || vol.ConfigMap.Name != "app-docs-site-server" {
		t.Errorf("server config volume missing or wrong: %+v", vol)
	}
	if deploy.Spec.Template.Annotations["apps.nebari.dev/server-config-checksum"] != serverConfChecksum() {
		t.Error("pod template should carry the server config checksum so config changes roll pods")
	}
}

func TestPixiAppsGetNoServerConfig(t *testing.T) {
	app := pixiApp("team-a")
	r, c := newReconciler(t, managedNamespace("team-a"), app)
	reconcile(t, r, app)

	err := c.Get(context.Background(), types.NamespacedName{Name: childName(app) + "-server", Namespace: "team-a"}, &corev1.ConfigMap{})
	if !apierrors.IsNotFound(err) {
		t.Errorf("pixi apps serve themselves; want no server ConfigMap, got err=%v", err)
	}
}
