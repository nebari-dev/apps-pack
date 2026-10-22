package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// SourceType identifies where an app comes from: content to serve or run
// (git, inline, pvc) or a prebuilt container image (image).
// +kubebuilder:validation:Enum=git;inline;pvc;image
type SourceType string

const (
	SourceTypeGit    SourceType = "git"
	SourceTypeInline SourceType = "inline"
	SourceTypePVC    SourceType = "pvc"
	SourceTypeImage  SourceType = "image"
)

// GitSource references app content in a git repository.
type GitSource struct {
	// URL of the git repository. Only public https URLs are accepted: no
	// embedded credentials and no cluster-internal or private hosts.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^https://`
	URL string `json:"url"`

	// Ref is the branch or tag to check out (git clone --branch).
	// +kubebuilder:default=main
	// +optional
	Ref string `json:"ref,omitempty"`

	// Subdir is the path within the repository containing the content root.
	// +optional
	Subdir string `json:"subdir,omitempty"`
}

// InlineSource carries small static content directly in the CR.
type InlineSource struct {
	// Files maps relative file paths to their contents.
	// +kubebuilder:validation:MinProperties=1
	Files map[string]string `json:"files"`
}

// PVCSource references content already present on a PersistentVolumeClaim.
type PVCSource struct {
	// +kubebuilder:validation:MinLength=1
	ClaimName string `json:"claimName"`

	// SubPath within the volume containing the content root.
	// +optional
	SubPath string `json:"subPath,omitempty"`
}

// ImageSource runs a prebuilt container image as the app container, with the
// same non-root, capability-free, resource-limited pod spec as other Apps and
// the apps-authz sidecar in front of it.
type ImageSource struct {
	// Reference is the image to run, with a tag or a digest:
	// ghcr.io/org/app:1.2.3 or ghcr.io/org/app@sha256:<64 hex>. Docker Hub
	// short names are expanded (nginx:1.27 is docker.io/library/nginx:1.27).
	// The registry and repository must match an entry of the operator's
	// --image-registries allowlist (chart apps.image.allowedRegistries);
	// with an empty allowlist image Apps are refused. A tag is pulled on every
	// pod start (imagePullPolicy Always), a digest once per node.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=512
	Reference string `json:"reference"`

	// Port the image's server listens on (on 0.0.0.0 or 127.0.0.1; also
	// passed as $PORT). The apps-authz sidecar always fronts image Apps on
	// 8080 and serves its probes on 8082, so the app may use neither.
	// +kubebuilder:validation:Minimum=1024
	// +kubebuilder:validation:Maximum=65535
	// +kubebuilder:validation:XValidation:rule="self != 8080 && self != 8082",message="source.image.port may not be 8080 or 8082: the apps-authz sidecar uses them"
	Port int32 `json:"port"`

	// Command replaces the image's ENTRYPOINT (exec form, no shell).
	// +kubebuilder:validation:MaxItems=64
	// +kubebuilder:validation:items:MaxLength=4096
	// +optional
	Command []string `json:"command,omitempty"`

	// Args replaces the image's CMD (exec form, no shell).
	// +kubebuilder:validation:MaxItems=64
	// +kubebuilder:validation:items:MaxLength=4096
	// +optional
	Args []string `json:"args,omitempty"`

	// RunAsUser runs the container as this non-zero uid. Set it for an
	// image whose USER is a name rather than a number, which the kubelet
	// cannot verify as non-root. Images that only work as root are refused
	// (the pod never starts and the App reports ImageRunsAsRoot).
	// +kubebuilder:validation:Minimum=1
	// +optional
	RunAsUser *int64 `json:"runAsUser,omitempty"`
}

// AppSource declares where the app comes from.
// +kubebuilder:validation:XValidation:rule="self.type != 'image' || has(self.image)",message="source.image is required for source type image"
type AppSource struct {
	Type SourceType `json:"type"`

	// +optional
	Git *GitSource `json:"git,omitempty"`

	// +optional
	Inline *InlineSource `json:"inline,omitempty"`

	// +optional
	PVC *PVCSource `json:"pvc,omitempty"`

	// +optional
	Image *ImageSource `json:"image,omitempty"`
}

// AppRuntime configures how the app process runs.
// The rule sits on runtime, not the root, so validation ratcheting lets an
// App stored before it existed still take status updates and edits that
// leave runtime alone (the operator refuses its workload instead).
// +kubebuilder:validation:XValidation:rule="!has(self.env) || self.env.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef))",message="runtime.env may not use valueFrom.secretKeyRef: list the key in runtime.secretKeys, which reads the app's own Secret (app-<name>-secrets)"
type AppRuntime struct {
	// Env holds plain environment variables. Their values are stored in the
	// App and shown to everyone who can read it: put credentials in
	// secretKeys instead. No valueFrom.secretKeyRef (use secretKeys), and a
	// configMapKeyRef may not name another App's generated ConfigMap: the
	// kubelet resolves references with its own rights, so they would
	// otherwise read other Apps' data.
	// +kubebuilder:validation:MaxItems=256
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// SecretKeys names keys of the App's Secret, app-<name>-secrets in its
	// namespace, each injected into the app container as an environment
	// variable of the same name (a secretKeyRef, resolved by the kubelet).
	// The App holds only the names: apps-api writes the values to the Secret
	// (owned by the App, so it is deleted with it), and GitOps can supply the
	// Secret itself. A secret key wins over an env entry of the same name.
	// The Deployment rolls when the apps.nebari.dev/secrets-version
	// annotation on the App changes (apps-api sets it on every write).
	// +kubebuilder:validation:MaxItems=64
	// +kubebuilder:validation:items:MaxLength=128
	// +kubebuilder:validation:items:Pattern=`^[A-Za-z_][A-Za-z0-9_]*$`
	// +listType=set
	// +optional
	SecretKeys []string `json:"secretKeys,omitempty"`

	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// KeepAlive exempts the app from scale-to-zero: it keeps running however
	// long it goes without requests, whatever idleTimeoutMinutes or the
	// cluster default (the operator's --idle-timeout-minutes) say.
	// +optional
	KeepAlive bool `json:"keepAlive,omitempty"`

	// IdleTimeoutMinutes scales the app to zero after this many minutes
	// without a request (phase Idle); the next request to its URL wakes it.
	// Unset means the cluster default (the operator's --idle-timeout-minutes,
	// chart apps.idle.timeoutMinutes; 0 there leaves apps running). Ignored
	// when keepAlive is true or replicas is 0.
	// +kubebuilder:validation:Minimum=5
	// +kubebuilder:validation:Maximum=43200
	// +optional
	IdleTimeoutMinutes *int32 `json:"idleTimeoutMinutes,omitempty"`

	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=10
	// +optional
	Replicas *int32 `json:"replicas,omitempty"`

	// PixiTask, when set, runs the app as a Python/pixi service instead of
	// serving its source as static content: the operator installs the pixi
	// environment from the app source and executes `pixi run <PixiTask>`.
	// Not allowed with source type image, which runs its own server.
	// The task must start a server on $PORT: 8080, or 8081 when the app can
	// idle (the authz sidecar takes 8080).
	// +kubebuilder:validation:MaxLength=64
	// +optional
	PixiTask string `json:"pixiTask,omitempty"`
}

// AppAccess configures who can reach the app and at which subdomain.
type AppAccess struct {
	// Public disables authentication entirely (anonymous access).
	// +optional
	Public bool `json:"public,omitempty"`

	// Groups are the Keycloak groups allowed to open a private app. Enforced
	// at the gateway (NebariApp auth.groups): a signed-in user in none of
	// them gets 403 before the request reaches the app. A user in any listed
	// group is let in. Empty allows any signed-in realm user. Entries are
	// full group paths matched exactly: "finance" is "/finance", and
	// "/finance" does not admit members of "/finance/analysts" only, so list
	// each subgroup that needs access. A bare top-level name is created in
	// Keycloak if missing; a path must already exist. The groups also set
	// landing-page tile visibility. Changes apply when the user's access
	// token refreshes (Keycloak's access token lifespan, 5 minutes by
	// default).
	// +optional
	Groups []string `json:"groups,omitempty"`

	// Managers may manage the app (edit, start, stop, restart, delete, read
	// logs and metrics) through apps-api, the UI and the MCP server, like its
	// owner. Only the owner and api.adminGroups members may change this list.
	// It does not grant opening the app: that is still public and groups.
	// +optional
	Managers *AppManagers `json:"managers,omitempty"`

	// Subdomain under the cluster domain: https://<subdomain>.<clusterDomain>.
	// Unique across all Apps (the oldest App keeps a contested subdomain) and
	// immutable after creation.
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="access.subdomain is immutable"
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Subdomain string `json:"subdomain"`
}

// AppManagers lists the users and groups who may manage an App besides its
// owner. Enforced by apps-api against the caller's verified token; the
// operator ignores it.
type AppManagers struct {
	// Users are Keycloak usernames (preferred_username, case-insensitive).
	// +optional
	Users []string `json:"users,omitempty"`

	// Groups are Keycloak groups whose members may manage the app, matched
	// as full group paths like access.groups ("finance" is "/finance", which
	// does not include "/finance/analysts").
	// +optional
	Groups []string `json:"groups,omitempty"`
}

// AppLandingPage controls whether the app is registered as a tile on the
// Nebari landing page. Apps are always reachable at their URL regardless.
type AppLandingPage struct {
	// Enabled shows the app on the landing page. Unset means "use the
	// cluster default" (the operator's --landing-page flag, off unless the
	// chart sets apps.landingPage.enabled=true).
	// +optional
	Enabled *bool `json:"enabled,omitempty"`
}

// AppSpec defines the desired state of an App.
type AppSpec struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	DisplayName string `json:"displayName"`

	// +kubebuilder:validation:MaxLength=256
	// +optional
	Description string `json:"description,omitempty"`

	// Thumbnail as a data URI, shown in catalogs and the landing page.
	// +optional
	Thumbnail string `json:"thumbnail,omitempty"`

	// Owner is the Keycloak sub / preferred_username that manages the app.
	// +optional
	Owner string `json:"owner,omitempty"`

	Source AppSource `json:"source"`

	// +optional
	Runtime AppRuntime `json:"runtime,omitempty"`

	// LandingPage controls the app's tile on the Nebari landing page.
	// +optional
	LandingPage *AppLandingPage `json:"landingPage,omitempty"`

	Access AppAccess `json:"access"`
}

// AppPhase is a coarse summary of app state. Idle means the operator scaled
// the app to zero after its idle timeout; unlike Stopped (replicas: 0 in the
// spec), the next request to its URL starts it again.
// +kubebuilder:validation:Enum=Pending;Deploying;Running;Failed;Stopped;Idle
type AppPhase string

const (
	AppPhasePending   AppPhase = "Pending"
	AppPhaseDeploying AppPhase = "Deploying"
	AppPhaseRunning   AppPhase = "Running"
	AppPhaseFailed    AppPhase = "Failed"
	AppPhaseStopped   AppPhase = "Stopped"
	AppPhaseIdle      AppPhase = "Idle"
)

// WakeAnnotation on an App asks the operator to wake it from Idle: its value
// is an RFC 3339 time that counts as a request. The activator (the page an
// idle App's URL serves) and apps-api's start route set it.
const WakeAnnotation = "apps.nebari.dev/wake-requested-at"

// SecretsVersionAnnotation on an App names the version of its Secret
// (apps-api sets the Secret's resourceVersion after each write); the operator
// copies it onto the pod template, so rotating a value rolls the Deployment.
const SecretsVersionAnnotation = "apps.nebari.dev/secrets-version"

// SecretName is the Secret whose keys an App's spec.runtime.secretKeys
// inject: derived from the App name, so an App can never reference another
// App's Secret.
func SecretName(appName string) string {
	return "app-" + appName + "-secrets"
}

// Condition reasons for image Apps: ImageNotAllowed on Validated when the
// reference is outside the operator's allowlist (the workload is scaled to
// zero); ImageRunsAsRoot and ImagePullFailed on WorkloadReady when the
// kubelet cannot start the image (phase Failed).
const (
	ReasonImageNotAllowed = "ImageNotAllowed"
	ReasonImageRunsAsRoot = "ImageRunsAsRoot"
	ReasonImagePullFailed = "ImagePullFailed"
)

// Condition types published on App.status.conditions.
const (
	ConditionWorkloadReady = "WorkloadReady"
	ConditionRoutingReady  = "RoutingReady"
	ConditionValidated     = "Validated"
)

// AppReplicas reports desired vs ready replica counts.
type AppReplicas struct {
	Desired int32 `json:"desired"`
	Ready   int32 `json:"ready"`
}

// AppStatus defines the observed state of an App.
type AppStatus struct {
	// +optional
	Phase AppPhase `json:"phase,omitempty"`

	// URL where the app is reachable once routing is ready.
	// +optional
	URL string `json:"url,omitempty"`

	// +optional
	Replicas *AppReplicas `json:"replicas,omitempty"`

	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Message is a human-readable summary of the current state.
	// +optional
	Message string `json:"message,omitempty"`

	// LastActivityTime is when the app last served a request, as far as the
	// operator knows (it polls the app pod's sidecar every few minutes).
	// Set only for apps that idle; the app goes Idle once it is older than
	// the idle timeout.
	// +optional
	LastActivityTime *metav1.Time `json:"lastActivityTime,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Source",type=string,JSONPath=`.spec.source.type`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.status.url`
// +kubebuilder:printcolumn:name="Last Active",type=date,JSONPath=`.status.lastActivityTime`,priority=1
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// App is a web application launched and managed on a Nebari cluster.
type App struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   AppSpec   `json:"spec,omitempty"`
	Status AppStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AppList contains a list of App.
type AppList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []App `json:"items"`
}
