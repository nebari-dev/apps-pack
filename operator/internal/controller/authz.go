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

// The gateway's SecurityPolicy only signs users in (nebari-operator #153), so
// an App that lists access.groups or access.users gets the apps-authz
// sidecar: it takes AppPort, checks the access token the gateway forwards
// (NebariApp auth.forwardAccessToken) and proxies allowed requests to the
// app container on AppInternalPort. Unrestricted Apps get no sidecar and an
// unchanged pod spec.
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
// signed-in user": a private App with groups or users.
func restricted(app *appsv1alpha1.App) bool {
	a := app.Spec.Access
	return !a.Public && (len(a.Groups) > 0 || len(a.Users) > 0)
}

// appContainerPort is the port the app container listens on.
func appContainerPort(app *appsv1alpha1.App) int32 {
	if restricted(app) {
		return AppInternalPort
	}
	return AppPort
}

// oidcClientID is the Keycloak client nebari-operator provisions for the
// App's NebariApp, which the gateway logs users in with (the token's azp).
// It mirrors nebari-operator's naming.ClientID, "<namespace>-<NebariApp
// name>"; if that naming changes, every restricted App denies everyone
// (TestAuthzClientIDMatchesNebariOperator pins it).
func oidcClientID(app *appsv1alpha1.App) string {
	return app.Namespace + "-" + childName(app)
}

func realmURL(base, realm string) string {
	if base == "" {
		return ""
	}
	return strings.TrimSuffix(base, "/") + "/realms/" + realm
}

// authzIssuers are the iss values the sidecar accepts. Keycloak writes the
// URL its token endpoint was called at, which can be the public or the
// in-cluster URL depending on its hostname settings.
func (c OperatorConfig) authzIssuers() []string {
	var out []string
	for _, base := range []string{c.KeycloakURL, c.KeycloakInternalURL} {
		if u := realmURL(base, c.realm()); u != "" && !contains(out, u) {
			out = append(out, u)
		}
	}
	return out
}

// authzJWKSURL fetches the realm's keys in-cluster when possible.
func (c OperatorConfig) authzJWKSURL() string {
	base := c.KeycloakInternalURL
	if base == "" {
		base = c.KeycloakURL
	}
	return realmURL(base, c.realm()) + "/protocol/openid-connect/certs"
}

func (c OperatorConfig) realm() string {
	if c.KeycloakRealm == "" {
		return "nebari"
	}
	return c.KeycloakRealm
}

// checkAuthz reports why a restricted App cannot be enforced, so it fails
// validation instead of running open.
func (c OperatorConfig) checkAuthz(app *appsv1alpha1.App) error {
	if !restricted(app) {
		return nil
	}
	if c.AuthzImage == "" {
		return fmt.Errorf("access.groups/access.users need the authz sidecar, but the operator has no --authz-image (chart authz.image)")
	}
	if len(c.authzIssuers()) == 0 {
		return fmt.Errorf("access.groups/access.users need the realm's URL, but the operator has no --keycloak-url or --keycloak-internal-url (chart keycloak.url, keycloak.internalUrl)")
	}
	for _, list := range [][]string{app.Spec.Access.Groups, app.Spec.Access.Users} {
		for _, v := range list {
			if strings.TrimSpace(v) == "" || strings.Contains(v, ",") {
				return fmt.Errorf("access.groups and access.users entries must be non-empty and must not contain ','")
			}
		}
	}
	return nil
}

// addAuthzSidecar moves the app container to AppInternalPort, points its
// probes at the sidecar's /upstreamz (which dials the app on loopback, so an
// app listening only on 127.0.0.1 still passes) and appends the sidecar,
// which takes the "http" port the Service targets.
func (r *AppReconciler) addAuthzSidecar(app *appsv1alpha1.App, pod *corev1.PodSpec) {
	main := &pod.Containers[0]
	main.Ports = []corev1.ContainerPort{{
		Name:          appInternalName,
		ContainerPort: AppInternalPort,
		Protocol:      corev1.ProtocolTCP,
	}}
	upstreamz := corev1.ProbeHandler{
		HTTPGet: &corev1.HTTPGetAction{Path: "/upstreamz", Port: intstr.FromString(authzHealthName)},
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
		{Name: "AUTHZ_UPSTREAM", Value: fmt.Sprintf("http://127.0.0.1:%d", AppInternalPort)},
		{Name: "AUTHZ_ISSUERS", Value: strings.Join(r.Config.authzIssuers(), ",")},
		{Name: "AUTHZ_JWKS_URL", Value: r.Config.authzJWKSURL()},
		{Name: "AUTHZ_CLIENT_ID", Value: oidcClientID(app)},
	}
	if g := app.Spec.Access.Groups; len(g) > 0 {
		env = append(env, corev1.EnvVar{Name: "AUTHZ_GROUPS", Value: strings.Join(g, ",")})
	}
	if u := app.Spec.Access.Users; len(u) > 0 {
		env = append(env, corev1.EnvVar{Name: "AUTHZ_USERS", Value: strings.Join(u, ",")})
	}

	pod.Containers = append(pod.Containers, corev1.Container{
		Name:            authzContainer,
		Image:           r.Config.AuthzImage,
		ImagePullPolicy: r.Config.AuthzImagePullPolicy,
		Ports: []corev1.ContainerPort{
			{Name: "http", ContainerPort: AppPort, Protocol: corev1.ProtocolTCP},
			{Name: authzHealthName, ContainerPort: authzHealthPort, Protocol: corev1.ProtocolTCP},
		},
		Env:       env,
		Resources: *r.Config.AuthzResources.DeepCopy(),
		// Ready once the realm's signing keys are fetched, so a wrong
		// Keycloak URL never takes traffic.
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

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
