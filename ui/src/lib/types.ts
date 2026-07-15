export type Framework =
  | 'static'
  | 'streamlit'
  | 'panel'
  | 'gradio'
  | 'dash'
  | 'voila'
  | 'fastapi'
  | 'custom';

export type SourceType = 'ociEnv' | 'image' | 'git' | 'inline' | 'pvc';

export interface GitSource {
  url: string;
  ref?: string;
  subdir?: string;
}

export interface ImageSource {
  repository: string;
  tag?: string;
}

export interface AppSource {
  type: SourceType;
  git?: GitSource;
  image?: ImageSource;
  inline?: { files: Record<string, string> };
  pvc?: { claimName: string; subPath?: string };
  ociEnv?: {
    ref: string;
    entrypoint: string;
    code: { type: 'git' | 'pvc'; git?: GitSource };
  };
}

export interface EnvVar {
  name: string;
  value: string;
}

export interface AppRuntime {
  command?: string[];
  env?: EnvVar[];
  replicas?: number;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
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
  framework: Framework | string;
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
  framework: Framework;
  source: AppSource;
  runtime?: AppRuntime;
  access: AppAccess;
}

export interface FrameworkInfo {
  name: string;
  displayName: string;
  sourceTypes: SourceType[];
  implementedSources: SourceType[];
  description: string;
}

export interface Capabilities {
  nebi: boolean;
  environments: string;
  appsDomain: string;
  frameworks: string[];
  namespaces: string[];
}

export interface AnalyticsSummary {
  total: number;
  byPhase: Record<string, number>;
  byFramework: Record<string, number>;
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
