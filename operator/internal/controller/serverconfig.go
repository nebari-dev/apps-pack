package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

const (
	serverConfVolume = "server-conf"
	// serverConfDir replaces the static image's conf.d, so the image's own
	// default.conf (no security headers) is not loaded.
	serverConfDir = "/etc/nginx/conf.d"
)

// staticServerConf is the nginx server every static app runs. Launched sites
// are user content on subdomains of the domain the Apps UI is served from, so
// they get the same baseline as the UI: no framing by other origins, no MIME
// sniffing, no plugins, and no <base> pointing elsewhere. A site's own scripts
// and styles are not restricted; a CSP sandbox would break same-origin fetches
// and storage for ordinary sites.
//
// listen is the nginx listen address: the app port, or loopback on the
// internal port when the authz sidecar fronts the app (so nothing reaches
// nginx without passing the sidecar).
func staticServerConf(listen string) string {
	return fmt.Sprintf(`# Written by apps-operator; changes are overwritten.
server {
    listen %s;
    server_name _;
    server_tokens off;
    root %s;
    index index.html index.htm;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Content-Security-Policy "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        try_files $uri $uri/ =404;
    }
}
`, listen, webRoot)
}

// staticListen is where a static App's nginx listens.
func staticListen(app *appsv1alpha1.App) string {
	if restricted(app) {
		return fmt.Sprintf("127.0.0.1:%d", AppInternalPort)
	}
	return fmt.Sprintf("%d", AppPort)
}

// buildServerConfigMap holds staticServerConf for a static App's pods.
// Returns nil for pixi apps, which serve themselves.
func buildServerConfigMap(app *appsv1alpha1.App) *corev1.ConfigMap {
	if app.Spec.Runtime.PixiTask != "" {
		return nil
	}
	return &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      childName(app) + "-server",
			Namespace: app.Namespace,
			Labels:    appLabels(app),
		},
		Data: map[string]string{"default.conf": staticServerConf(staticListen(app))},
	}
}

// serverConfChecksum rolls static pods when an operator upgrade (or a
// change to the App's access) changes the server config.
func serverConfChecksum(app *appsv1alpha1.App) string {
	sum := sha256.Sum256([]byte(staticServerConf(staticListen(app))))
	return hex.EncodeToString(sum[:])
}
