package controller

import (
	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// AppPort is the port every app container listens on. Auth is enforced at the
// gateway by the NebariApp SecurityPolicy, so apps serve plain HTTP here.
const AppPort = 8080

// FrameworkInfo describes how a framework is launched and which source types
// it accepts. The operator owns this table; apps-api mirrors it read-only.
type FrameworkInfo struct {
	Name appsv1alpha1.Framework

	// SourceTypes is the full contract: every source type the framework will
	// eventually accept.
	SourceTypes []appsv1alpha1.SourceType

	// ImplementedSources is the subset the operator reconciles today.
	// (ociEnv - Nebi pixi environments - lands in Phase 2.)
	ImplementedSources []appsv1alpha1.SourceType

	// Web is true when the framework serves HTTP on "/" and can use an HTTP
	// readiness probe; Python frameworks get TCP probes instead (some 404 on /).
	HTTPProbe bool
}

var staticSources = []appsv1alpha1.SourceType{
	appsv1alpha1.SourceTypeInline,
	appsv1alpha1.SourceTypeGit,
	appsv1alpha1.SourceTypePVC,
}

var pythonSources = []appsv1alpha1.SourceType{
	appsv1alpha1.SourceTypeOCIEnv,
	appsv1alpha1.SourceTypeImage,
}

var pythonImplemented = []appsv1alpha1.SourceType{
	appsv1alpha1.SourceTypeImage,
}

var allSources = []appsv1alpha1.SourceType{
	appsv1alpha1.SourceTypeOCIEnv,
	appsv1alpha1.SourceTypeImage,
	appsv1alpha1.SourceTypeGit,
	appsv1alpha1.SourceTypeInline,
	appsv1alpha1.SourceTypePVC,
}

var Frameworks = map[appsv1alpha1.Framework]FrameworkInfo{
	appsv1alpha1.FrameworkStatic: {
		Name:               appsv1alpha1.FrameworkStatic,
		SourceTypes:        staticSources,
		ImplementedSources: staticSources,
		HTTPProbe:          true,
	},
	appsv1alpha1.FrameworkStreamlit: python(appsv1alpha1.FrameworkStreamlit),
	appsv1alpha1.FrameworkPanel:     python(appsv1alpha1.FrameworkPanel),
	appsv1alpha1.FrameworkGradio:    python(appsv1alpha1.FrameworkGradio),
	appsv1alpha1.FrameworkDash:      python(appsv1alpha1.FrameworkDash),
	appsv1alpha1.FrameworkVoila:     python(appsv1alpha1.FrameworkVoila),
	appsv1alpha1.FrameworkFastAPI:   python(appsv1alpha1.FrameworkFastAPI),
	appsv1alpha1.FrameworkCustom: {
		Name:               appsv1alpha1.FrameworkCustom,
		SourceTypes:        allSources,
		ImplementedSources: pythonImplemented,
	},
}

func python(name appsv1alpha1.Framework) FrameworkInfo {
	return FrameworkInfo{
		Name:               name,
		SourceTypes:        pythonSources,
		ImplementedSources: pythonImplemented,
	}
}

// SupportsSource reports whether the framework accepts the given source type
// in the CRD contract.
func (f FrameworkInfo) SupportsSource(t appsv1alpha1.SourceType) bool {
	return containsSource(f.SourceTypes, t)
}

// ImplementsSource reports whether the operator reconciles the combination
// today.
func (f FrameworkInfo) ImplementsSource(t appsv1alpha1.SourceType) bool {
	return containsSource(f.ImplementedSources, t)
}

func containsSource(list []appsv1alpha1.SourceType, t appsv1alpha1.SourceType) bool {
	for _, s := range list {
		if s == t {
			return true
		}
	}
	return false
}

// frameworkEnv returns framework-specific env vars injected into app
// containers so frameworks that read config from the environment bind the
// right port/address.
func frameworkEnv(fw appsv1alpha1.Framework) []corev1.EnvVar {
	switch fw {
	case appsv1alpha1.FrameworkGradio:
		return []corev1.EnvVar{
			{Name: "GRADIO_SERVER_PORT", Value: "8080"},
			{Name: "GRADIO_SERVER_NAME", Value: "0.0.0.0"},
		}
	case appsv1alpha1.FrameworkStreamlit:
		return []corev1.EnvVar{
			{Name: "STREAMLIT_SERVER_PORT", Value: "8080"},
			{Name: "STREAMLIT_SERVER_ADDRESS", Value: "0.0.0.0"},
			{Name: "STREAMLIT_SERVER_HEADLESS", Value: "true"},
		}
	default:
		return []corev1.EnvVar{
			{Name: "PORT", Value: "8080"},
		}
	}
}
