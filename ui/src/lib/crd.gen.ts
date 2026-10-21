// Generated from charts/nebari-apps/crds/apps.nebari.dev_apps.yaml
// (apps.nebari.dev/v1alpha1) by .github/scripts/gen_crd_types.py.
// Do not edit: change operator/api/, regenerate the CRD, then run the script.

export type AppAccess = {
  /** Groups are the Keycloak/OIDC groups allowed to open a private app. */
  groups?: string[];
  /** Public disables authentication entirely (anonymous access). */
  public?: boolean;
  /** Subdomain under the cluster domain: https://<subdomain>.<clusterDomain>. */
  subdomain: string;
  /** Users are Keycloak usernames (preferred_username, case-insensitive) allowed to open a private app, in addition to the members of groups. */
  users?: string[];
};

export type AppCondition = {
  /** lastTransitionTime is the last time the condition transitioned from one status to another. */
  lastTransitionTime: string;
  /** message is a human readable message indicating details about the transition. */
  message: string;
  /** observedGeneration represents the .metadata.generation that the condition was set based upon. */
  observedGeneration?: number;
  /** reason contains a programmatic identifier indicating the reason for the condition's last transition. */
  reason: string;
  /** status of the condition, one of True, False, Unknown. */
  status: "True" | "False" | "Unknown";
  /** type of condition in CamelCase or in foo.example.com/CamelCase. */
  type: string;
};

export type AppLandingPage = {
  /** Enabled shows the app on the landing page. */
  enabled?: boolean;
};

export type AppReplicas = {
  desired: number;
  ready: number;
};

export type AppRuntime = {
  env?: EnvVar[];
  /** IdleTimeoutMinutes scales the app to zero after this many minutes without a request (phase Idle); the next request to its URL wakes it. */
  idleTimeoutMinutes?: number;
  /** KeepAlive exempts the app from scale-to-zero: it keeps running however long it goes without requests, whatever idleTimeoutMinutes or the cluster default (the operator's --idle-timeout-minutes) say. */
  keepAlive?: boolean;
  /** PixiTask, when set, runs the app as a Python/pixi service instead of serving its source as static content: the operator installs the pixi environment from the app source and executes `pixi run <PixiTask>`. */
  pixiTask?: string;
  replicas?: number;
  /** ResourceRequirements describes the compute resource requirements. */
  resources?: ResourceRequirements;
};

export type AppSource = {
  /** GitSource references app content in a git repository. */
  git?: GitSource;
  /** InlineSource carries small static content directly in the CR. */
  inline?: InlineSource;
  /** PVCSource references content already present on a PersistentVolumeClaim. */
  pvc?: PVCSource;
  /** SourceType identifies where an app's static content comes from. */
  type: "git" | "inline" | "pvc";
};

export type AppSpec = {
  /** AppAccess configures who can reach the app and at which subdomain. */
  access: AppAccess;
  description?: string;
  displayName: string;
  /** LandingPage controls the app's tile on the Nebari landing page. */
  landingPage?: AppLandingPage;
  /** Owner is the Keycloak sub / preferred_username that manages the app. */
  owner?: string;
  /** AppRuntime configures how the app process runs. */
  runtime?: AppRuntime;
  /** AppSource declares where the app's static content comes from. */
  source: AppSource;
  /** Thumbnail as a data URI, shown in catalogs and the landing page. */
  thumbnail?: string;
};

export type AppStatus = {
  conditions?: AppCondition[];
  /** LastActivityTime is when the app last served a request, as far as the operator knows (it polls the app pod's sidecar every few minutes). */
  lastActivityTime?: string;
  /** Message is a human-readable summary of the current state. */
  message?: string;
  observedGeneration?: number;
  /** AppPhase is a coarse summary of app state. */
  phase?: "Pending" | "Deploying" | "Running" | "Failed" | "Stopped" | "Idle";
  /** AppReplicas reports desired vs ready replica counts. */
  replicas?: AppReplicas;
  /** URL where the app is reachable once routing is ready. */
  url?: string;
};

export type EnvVar = {
  /** Name of the environment variable. */
  name: string;
  /** Variable references $(VAR_NAME) are expanded using the previously defined environment variables in the container and any service environment variables. */
  value?: string;
  /** Source for the environment variable's value. */
  valueFrom?: EnvVarSource;
};

export type EnvVarSource = {
  /** Selects a key of a ConfigMap. */
  configMapKeyRef?: {
    /** The key to select from the ConfigMap's Data field. */
    key: string;
    /** Name of the referent. */
    name?: string;
    /** Specify whether the ConfigMap or its key must be defined. */
    optional?: boolean;
  };
  /** Selects a field of the pod: supports metadata.name, metadata.namespace, `metadata.labels['<KEY>']`, `metadata.annotations['<KEY>']`, spec.nodeName, spec.serviceAccountName, status.hostIP, status.podIP, status.podIPs. */
  fieldRef?: {
    /** Version of the schema the FieldPath is written in terms of, defaults to "v1". */
    apiVersion?: string;
    /** Path of the field to select in the specified API version. */
    fieldPath: string;
  };
  /** FileKeyRef selects a key of the env file. */
  fileKeyRef?: {
    /** The key within the env file. */
    key: string;
    /** Specify whether the file or its key must be defined. */
    optional?: boolean;
    /** The path within the volume from which to select the file. */
    path: string;
    /** The name of the volume mount containing the env file. */
    volumeName: string;
  };
  /** Selects a resource of the container: only resources limits and requests (limits.cpu, limits.memory, limits.ephemeral-storage, requests.cpu, requests.memory and requests.ephemeral-storage) are currently supported. */
  resourceFieldRef?: {
    /** Container name: required for volumes, optional for env vars. */
    containerName?: string;
    /** Specifies the output format of the exposed resources, defaults to "1". */
    divisor?: number | string;
    /** Required: resource to select. */
    resource: string;
  };
  /** Selects a key of a secret in the pod's namespace. */
  secretKeyRef?: {
    /** The key of the secret to select from. */
    key: string;
    /** Name of the referent. */
    name?: string;
    /** Specify whether the Secret or its key must be defined. */
    optional?: boolean;
  };
};

export type GitSource = {
  /** Ref is the branch or tag to check out (git clone --branch). */
  ref?: string;
  /** Subdir is the path within the repository containing the content root. */
  subdir?: string;
  /** URL of the git repository. */
  url: string;
};

export type InlineSource = {
  /** Files maps relative file paths to their contents. */
  files: Record<string, string>;
};

export type PVCSource = {
  claimName: string;
  /** SubPath within the volume containing the content root. */
  subPath?: string;
};

export type ResourceRequirements = {
  /** Claims lists the names of resources, defined in spec.resourceClaims, that are used by this container. */
  claims?: {
    /** Name must match the name of one entry in pod.spec.resourceClaims of the Pod where this field is used. */
    name: string;
    /** Request is the name chosen for a request in the referenced claim. */
    request?: string;
  }[];
  /** Limits describes the maximum amount of compute resources allowed. */
  limits?: Record<string, number | string>;
  /** Requests describes the minimum amount of compute resources required. */
  requests?: Record<string, number | string>;
};
