package controller

import (
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// NebariAppGVK is the nebari-operator CRD this pack emits for routing, TLS,
// SSO, and landing-page registration. Contract pinned to nebari-operator
// v0.1.0-alpha.19 (see docs and the contract test).
var NebariAppGVK = schema.GroupVersionKind{
	Group:   "reconcilers.nebari.dev",
	Version: "v1",
	Kind:    "NebariApp",
}

// Hostname computes the FQDN an App is served at.
func (c OperatorConfig) Hostname(app *appsv1alpha1.App) string {
	return fmt.Sprintf("%s.%s", app.Spec.Access.Subdomain, c.AppsDomain)
}

// buildNebariApp renders the NebariApp CR for an App. It is unstructured on
// purpose: the nebari-operator API is consumed as a versioned contract, not a
// Go dependency.
func (r *AppReconciler) buildNebariApp(app *appsv1alpha1.App) *unstructured.Unstructured {
	auth := map[string]any{
		"enabled": !app.Spec.Access.Public,
	}
	if !app.Spec.Access.Public {
		auth["provider"] = "keycloak"
		auth["provisionClient"] = true
		auth["scopes"] = []any{"openid", "profile", "email", "groups"}
		if len(app.Spec.Access.Groups) > 0 {
			groups := make([]any, 0, len(app.Spec.Access.Groups))
			for _, g := range app.Spec.Access.Groups {
				groups = append(groups, g)
			}
			auth["groups"] = groups
		}
	}

	landing := map[string]any{
		"enabled":     true,
		"displayName": app.Spec.DisplayName,
		"category":    "Apps",
	}
	if app.Spec.Description != "" {
		landing["description"] = app.Spec.Description
	}
	if app.Spec.Thumbnail != "" {
		landing["icon"] = app.Spec.Thumbnail
	}

	obj := &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": NebariAppGVK.GroupVersion().String(),
			"kind":       NebariAppGVK.Kind,
			"metadata": map[string]any{
				"name":      childName(app),
				"namespace": app.Namespace,
				"labels":    toAnyMap(appLabels(app)),
			},
			"spec": map[string]any{
				"hostname": r.Config.Hostname(app),
				"gateway":  r.Config.Gateway,
				"service": map[string]any{
					"name": childName(app),
					"port": int64(AppPort),
				},
				"routing": map[string]any{
					"routes": []any{
						map[string]any{"pathPrefix": "/", "pathType": "PathPrefix"},
					},
					"tls": map[string]any{
						"enabled": !r.Config.TLSDisabled,
					},
				},
				"auth":        auth,
				"landingPage": landing,
			},
		},
	}
	return obj
}

func toAnyMap(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
