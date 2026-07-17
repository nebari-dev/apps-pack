export type SourceType = 'git' | 'inline' | 'pvc';

export interface GitSource {
  url: string;
  ref?: string;
  subdir?: string;
}

export interface AppSource {
  type: SourceType;
  git?: GitSource;
  inline?: { files: Record<string, string> };
  pvc?: { claimName: string; subPath?: string };
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface AppRuntime {
  env?: EnvVar[];
  replicas?: number;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /** When set, the app runs as a Python/pixi service via `pixi run <task>`. */
  pixiTask?: string;
}

export interface AppAccess {
  public: boolean;
  groups?: string[];
  users?: string[];
  subdomain: string;
}

export interface AppCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface AppStatus {
  phase: string;
  url: string;
  replicas?: { desired: number; ready: number } | null;
  conditions: AppCondition[];
  message: string;
}

export interface App {
  name: string;
  namespace: string;
  displayName: string;
  description: string;
  thumbnail: string;
  owner: string;
  createdAt: string;
  source?: AppSource;
  runtime?: AppRuntime;
  access?: AppAccess;
  status: AppStatus;
}

export interface AppCreate {
  name: string;
  namespace: string;
  displayName: string;
  description?: string;
  source: AppSource;
  runtime?: AppRuntime;
  access: AppAccess;
}

export interface AppPatch {
  displayName?: string;
  description?: string;
  thumbnail?: string;
  source?: AppSource;
  runtime?: AppRuntime;
  access?: AppAccess;
}

export interface PodMetric {
  name: string;
  cpu: string;
  memory: string;
}

export interface AppMetrics {
  available: boolean;
  pods: PodMetric[];
}

export interface Capabilities {
  appsDomain: string;
  sourceTypes: SourceType[];
  namespaces: string[];
}

export interface AppUsage {
  namespace: string;
  name: string;
  cpu: number; // millicores
  memory: number; // Mi
  restarts: number;
}

export interface NamespaceUsage {
  namespace: string;
  cpu: number;
  memory: number;
}

export interface ClusterMetrics {
  usageAvailable: boolean;
  apps: AppUsage[];
  byNamespace: NamespaceUsage[];
}

export interface AnalyticsSummary {
  total: number;
  byPhase: Record<string, number>;
  bySourceType: Record<string, number>;
  byNamespace: Record<string, number>;
  readyReplicas: number;
  desiredReplicas: number;
}

export interface UiConfig {
  authEnabled: boolean;
  keycloak: { url: string; realm: string; clientId: string };
  appsDomain: string;
  appsScheme?: string;
}

export interface AppEvent {
  type: string;
  reason: string;
  message: string;
  kind: string;
  object: string;
  count: number;
  lastTimestamp: string;
}
