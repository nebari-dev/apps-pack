package controller

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/nebari-dev/nebari-apps-pack/operator/api/v1alpha1"
)

// The apps-authz sidecar sits in front of the app container of Apps that can
// idle (it records request activity for the idle check, idle.go) and of image
// Apps (it gives the image's own port the pack's one front port, AppPort). It
// takes AppPort and proxies every request to the app container on
// appContainerPort: it checks no tokens. access.groups are enforced by the
// gateway (routing.go emits them as the NebariApp's auth.groups), so other
// Apps get no sidecar and an unchanged pod spec.
const (
	// AppInternalPort is where the app container listens behind the sidecar.
	AppInternalPort = 8081
	// authzHealthPort serves the sidecar's token-free probe endpoints.
	authzHealthPort = 8082

	authzContainer  = "authz"
	authzHealthName = "authz-health"
	appInternalName = "app-http"
	authzUID        = int64(65532)
)

// DefaultAuthzResources bound the sidecar when the operator is given none.
var DefaultAuthzResources = corev1.ResourceRequirements{
	Requests: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("10m"),
		corev1.ResourceMemory: resource.MustParse("32Mi"),
	},
	Limits: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("100m"),
		corev1.ResourceMemory: resource.MustParse("64Mi"),
	},
}

// restricted reports whether an App limits who may open it beyond "any
// signed-in user": a private App with groups. The gateway enforces them.
func restricted(app *appsv1alpha1.App) bool {
	a := app.Spec.Access
	return !a.Public && len(a.Groups) > 0
}

// hasSidecar reports whether the App's pod runs the apps-authz sidecar: Apps
// that can idle (it records activity for the idle check) and image Apps (it
// gives their own port the pack's one front port, AppPort).
func (c OperatorConfig) hasSidecar(app *appsv1alpha1.App) bool {
	return c.idleTimeout(app) > 0 || isImage(app)
}

func isImage(app *appsv1alpha1.App) bool {
	return app.Spec.Source.Type == appsv1alpha1.SourceTypeImage && app.Spec.Source.Image != nil
}

// appContainerPort is the port the app container listens on: an image App's
// own port, else AppPort, or AppInternalPort behind the sidecar.
func (c OperatorConfig) appContainerPort(app *appsv1alpha1.App) int32 {
	if isImage(app) {
		return app.Spec.Source.Image.Port
	}
	if c.hasSidecar(app) {
		return AppInternalPort
	}
	return AppPort
}

// checkAuthz reports why an App cannot run as specified, so it fails
// validation instead: an image App needs the sidecar, and every access.groups
// entry must name a group (nebari-operator denies every request when all
// entries normalize to nothing, such as "/").
func (c OperatorConfig) checkAuthz(app *appsv1alpha1.App) error {
	if isImage(app) && c.AuthzImage == "" {
		return fmt.Errorf("image sources need the authz sidecar, but the operator has no --authz-image (chart authz.image)")
	}
	for _, g := range app.Spec.Access.Groups {
		if groupPath(g) == "" {
			return fmt.Errorf("access.groups entries must name a group, such as finance or /parent/child")
		}
	}
	return nil
}

// groupPath is nebari-operator's canonical form of an access.groups entry
// (its groups.NormalizePath): the full Keycloak group path, with a leading
// "/", no trailing "/" and no empty segments, so "finance" and "/finance" are
// the same group. It returns "" for an entry that names no group.
func groupPath(g string) string {
	var segments []string
	for _, s := range strings.Split(strings.TrimSpace(g), "/") {
		if s != "" {
			segments = append(segments, s)
		}
	}
	if len(segments) == 0 {
		return ""
	}
	return "/" + strings.Join(segments, "/")
}

// addAuthzSidecar moves the app container to appContainerPort (AppInternalPort,
// or an image App's own port), points its
// probes at the sidecar's /upstreamz (which dials the app on loopback, so an
// app listening only on 127.0.0.1 still passes) and appends the sidecar,
// which takes the "http" port the Service targets. The sidecar checks no
// tokens: it proxies every request and records activity.
func (r *AppReconciler) addAuthzSidecar(app *appsv1alpha1.App, pod *corev1.PodSpec) {
	main := &pod.Containers[0]
	upstreamPort := r.Config.appContainerPort(app)
	main.Ports = []corev1.ContainerPort{{
		Name:          appInternalName,
		ContainerPort: upstreamPort,
		Protocol:      corev1.ProtocolTCP,
	}}
	// By number, not name: a probe's named port must belong to the probed
	// container, and authz-health is the sidecar's. The pod shares one
	// network namespace, so the kubelet reaches the sidecar on this port.
	upstreamz := corev1.ProbeHandler{
		HTTPGet: &corev1.HTTPGetAction{Path: "/upstreamz", Port: intstr.FromInt32(authzHealthPort)},
	}
	for _, p := range []*corev1.Probe{main.StartupProbe, main.ReadinessProbe, main.LivenessProbe} {
		if p != nil {
			p.ProbeHandler = upstreamz
		}
	}

	healthGet := func(path string) corev1.ProbeHandler {
		return corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: path, Port: intstr.FromString(authzHealthName)}}
	}
	env := []corev1.EnvVar{
		{Name: "AUTHZ_LISTEN", Value: fmt.Sprintf(":%d", AppPort)},
		{Name: "AUTHZ_HEALTH_LISTEN", Value: fmt.Sprintf(":%d", authzHealthPort)},
		{Name: "AUTHZ_UPSTREAM", Value: fmt.Sprintf("http://127.0.0.1:%d", upstreamPort)},
	}

	pod.Containers = append(pod.Containers, corev1.Container{
		Name:            authzContainer,
		Image:           r.Config.AuthzImage,
		ImagePullPolicy: r.Config.AuthzImagePullPolicy,
		Ports: []corev1.ContainerPort{
			{Name: "http", ContainerPort: AppPort, Protocol: corev1.ProtocolTCP},
			{Name: authzHealthName, ContainerPort: authzHealthPort, Protocol: corev1.ProtocolTCP},
		},
		Env:            env,
		Resources:      *r.Config.AuthzResources.DeepCopy(),
		ReadinessProbe: &corev1.Probe{ProbeHandler: healthGet("/readyz"), PeriodSeconds: 5},
		LivenessProbe:  &corev1.Probe{ProbeHandler: healthGet("/healthz"), PeriodSeconds: 10},
		SecurityContext: &corev1.SecurityContext{
			RunAsNonRoot:             ptr.To(true),
			RunAsUser:                ptr.To(authzUID),
			RunAsGroup:               ptr.To(authzUID),
			AllowPrivilegeEscalation: ptr.To(false),
			ReadOnlyRootFilesystem:   ptr.To(true),
			Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
	})
}
