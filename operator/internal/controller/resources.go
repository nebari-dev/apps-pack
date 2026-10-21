package controller

import (
	"encoding/json"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// Built-in defaults for launched pods whose App sets no runtime.resources.
// Static apps are nginx serving files; Python apps resolve a pixi
// environment on cold start, which needs real memory. Image apps are
// services like Python apps and share their defaults.
var (
	DefaultStaticResources = corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("50m"),
			corev1.ResourceMemory: resource.MustParse("64Mi"),
		},
		Limits: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("500m"),
			corev1.ResourceMemory: resource.MustParse("256Mi"),
		},
	}
	DefaultPythonResources = corev1.ResourceRequirements{
		Requests: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("250m"),
			corev1.ResourceMemory: resource.MustParse("512Mi"),
		},
		Limits: corev1.ResourceList{
			corev1.ResourceCPU:    resource.MustParse("2"),
			corev1.ResourceMemory: resource.MustParse("2Gi"),
		},
	}
)

// ParseResources reads a ResourceRequirements from its JSON form, e.g.
// {"requests":{"cpu":"100m"},"limits":{"memory":"256Mi"}}. Empty input
// returns the fallback.
func ParseResources(raw string, fallback corev1.ResourceRequirements) (corev1.ResourceRequirements, error) {
	if raw == "" {
		return fallback, nil
	}
	var rr corev1.ResourceRequirements
	if err := json.Unmarshal([]byte(raw), &rr); err != nil {
		return rr, fmt.Errorf("invalid resources %q: %w", raw, err)
	}
	return rr, nil
}

// appResources returns the App's runtime.resources with every unset cpu or
// memory request/limit filled from the defaults for its kind, so no launched
// container runs unbounded. A filled limit never drops below the App's own
// request.
func (c OperatorConfig) appResources(app *appsv1alpha1.App) corev1.ResourceRequirements {
	def := c.StaticResources
	if app.Spec.Runtime.PixiTask != "" || app.Spec.Source.Type == appsv1alpha1.SourceTypeImage {
		def = c.PythonResources
	}
	out := *app.Spec.Runtime.Resources.DeepCopy()
	if out.Requests == nil {
		out.Requests = corev1.ResourceList{}
	}
	if out.Limits == nil {
		out.Limits = corev1.ResourceList{}
	}
	for _, name := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
		req, hasReq := out.Requests[name]
		lim, hasLim := out.Limits[name]
		if !hasReq {
			if d, ok := def.Requests[name]; ok {
				req = d
				if hasLim && req.Cmp(lim) > 0 {
					req = lim
				}
				out.Requests[name] = req
			}
		}
		if !hasLim {
			if d, ok := def.Limits[name]; ok {
				if r, ok := out.Requests[name]; ok && r.Cmp(d) > 0 {
					d = r
				}
				out.Limits[name] = d
			}
		}
	}
	return out
}
