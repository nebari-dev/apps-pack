package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Framework identifies how an app is launched and served.
// +kubebuilder:validation:Enum=static;streamlit;panel;gradio;dash;voila;fastapi;custom
type Framework string

const (
	FrameworkStatic    Framework = "static"
	FrameworkStreamlit Framework = "streamlit"
	FrameworkPanel     Framework = "panel"
	FrameworkGradio    Framework = "gradio"
	FrameworkDash      Framework = "dash"
	FrameworkVoila     Framework = "voila"
	FrameworkFastAPI   Framework = "fastapi"
	FrameworkCustom    Framework = "custom"
)

// SourceType identifies where an app's code (and environment) comes from.
// +kubebuilder:validation:Enum=ociEnv;image;git;inline;pvc
type SourceType string

const (
	SourceTypeOCIEnv SourceType = "ociEnv"
	SourceTypeImage  SourceType = "image"
	SourceTypeGit    SourceType = "git"
	SourceTypeInline SourceType = "inline"
	SourceTypePVC    SourceType = "pvc"
)

// GitSource references app content in a git repository.
type GitSource struct {
	// URL of the git repository (https).
	// +kubebuilder:validation:MinLength=1
	URL string `json:"url"`

	// Ref is the branch, tag, or commit to check out.
	// +kubebuilder:default=main
	// +optional
	Ref string `json:"ref,omitempty"`

	// Subdir is the path within the repository containing the content root.
	// +optional
	Subdir string `json:"subdir,omitempty"`
}

// ImageSource references a prebuilt, self-contained container image.
type ImageSource struct {
	// +kubebuilder:validation:MinLength=1
	Repository string `json:"repository"`

	// +kubebuilder:default=latest
	// +optional
	Tag string `json:"tag,omitempty"`
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

// CodeSource says where the app *code* lives (the environment is separate).
type CodeSource struct {
	// +kubebuilder:validation:Enum=git;pvc
	Type string `json:"type"`

	// +optional
	Git *GitSource `json:"git,omitempty"`

	// +optional
	PVC *PVCSource `json:"pvc,omitempty"`
}

// OCIEnvSource runs Python app code inside a Nebi-published pixi environment
// delivered as an OCI artifact.
type OCIEnvSource struct {
	// Ref is the OCI reference of the published pixi environment.
	// +kubebuilder:validation:MinLength=1
	Ref string `json:"ref"`

	// Code says where the app code lives (env != code).
	Code CodeSource `json:"code"`

	// Entrypoint is the app entrypoint relative to the code root.
	// +kubebuilder:validation:MinLength=1
	Entrypoint string `json:"entrypoint"`
}

// AppSource declares where the app's code (and environment) comes from.
type AppSource struct {
	Type SourceType `json:"type"`

	// +optional
	OCIEnv *OCIEnvSource `json:"ociEnv,omitempty"`

	// +optional
	Image *ImageSource `json:"image,omitempty"`

	// +optional
	Git *GitSource `json:"git,omitempty"`

	// +optional
	Inline *InlineSource `json:"inline,omitempty"`

	// +optional
	PVC *PVCSource `json:"pvc,omitempty"`
}

// AppRuntime configures how the app process runs.
type AppRuntime struct {
	// Command overrides the framework-derived container command.
	// Required for framework=custom.
	// +optional
	Command []string `json:"command,omitempty"`

	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// KeepAlive prevents idle scale-down when scale-to-zero is enabled.
	// +optional
	KeepAlive bool `json:"keepAlive,omitempty"`

	// +kubebuilder:default=1
	// +kubebuilder:validation:Minimum=0
	// +optional
	Replicas *int32 `json:"replicas,omitempty"`
}

// AppAccess configures who can reach the app and at which subdomain.
type AppAccess struct {
	// Public disables authentication entirely (anonymous access).
	// +optional
	Public bool `json:"public,omitempty"`

	// Groups are the Keycloak/OIDC groups allowed to use the app.
	// +optional
	Groups []string `json:"groups,omitempty"`

	// Users are additional individual users allowed to use the app.
	// +optional
	Users []string `json:"users,omitempty"`

	// Subdomain under the cluster domain: https://<subdomain>.<clusterDomain>.
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Subdomain string `json:"subdomain"`
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

	Framework Framework `json:"framework"`

	// Owner is the Keycloak sub / preferred_username that manages the app.
	// +optional
	Owner string `json:"owner,omitempty"`

	Source AppSource `json:"source"`

	// +optional
	Runtime AppRuntime `json:"runtime,omitempty"`

	Access AppAccess `json:"access"`
}

// AppPhase is a coarse summary of app state.
// +kubebuilder:validation:Enum=Pending;Building;Deploying;Running;Failed;Stopped
type AppPhase string

const (
	AppPhasePending   AppPhase = "Pending"
	AppPhaseBuilding  AppPhase = "Building"
	AppPhaseDeploying AppPhase = "Deploying"
	AppPhaseRunning   AppPhase = "Running"
	AppPhaseFailed    AppPhase = "Failed"
	AppPhaseStopped   AppPhase = "Stopped"
)

// Condition types published on App.status.conditions.
const (
	ConditionWorkloadReady    = "WorkloadReady"
	ConditionRoutingReady     = "RoutingReady"
	ConditionEnvironmentReady = "EnvironmentReady"
	ConditionValidated        = "Validated"
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
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Framework",type=string,JSONPath=`.spec.framework`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.status.url`
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
