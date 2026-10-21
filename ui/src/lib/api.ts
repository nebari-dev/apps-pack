import { apiFetch } from "./auth";
import type {
  App,
  AppCreate,
  AppEvent,
  AppMetrics,
  AppPatch,
  Capabilities,
  ClusterMetrics,
} from "./types";

const BASE = "/api/v1";

async function getJSON<T>(path: string): Promise<T> {
  const resp = await apiFetch(BASE + path);
  return (await resp.json()) as T;
}

export const api = {
  capabilities: () => getJSON<Capabilities>("/capabilities"),
  clusterMetrics: () => getJSON<ClusterMetrics>("/analytics/metrics"),

  listApps: (namespace?: string) =>
    getJSON<App[]>(`/apps${namespace ? `?namespace=${encodeURIComponent(namespace)}` : ""}`),

  getApp: (namespace: string, name: string) => getJSON<App>(`/apps/${namespace}/${name}`),

  createApp: async (body: AppCreate): Promise<App> => {
    const resp = await apiFetch(`${BASE}/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await resp.json()) as App;
  },

  uploadApp: async (manifest: Omit<AppCreate, "source">, file: File): Promise<App> => {
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("file", file);
    const resp = await apiFetch(`${BASE}/apps/upload`, { method: "POST", body: form });
    return (await resp.json()) as App;
  },

  patchApp: async (namespace: string, name: string, body: AppPatch): Promise<App> => {
    const resp = await apiFetch(`${BASE}/apps/${namespace}/${name}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await resp.json()) as App;
  },

  deleteApp: async (namespace: string, name: string): Promise<void> => {
    await apiFetch(`${BASE}/apps/${namespace}/${name}`, { method: "DELETE" });
  },

  restartApp: async (namespace: string, name: string): Promise<App> => {
    const resp = await apiFetch(`${BASE}/apps/${namespace}/${name}/restart`, { method: "POST" });
    return (await resp.json()) as App;
  },

  metrics: (namespace: string, name: string) =>
    getJSON<AppMetrics>(`/apps/${namespace}/${name}/metrics`),

  stopApp: async (namespace: string, name: string): Promise<App> => {
    const resp = await apiFetch(`${BASE}/apps/${namespace}/${name}/stop`, { method: "POST" });
    return (await resp.json()) as App;
  },

  startApp: async (namespace: string, name: string): Promise<App> => {
    const resp = await apiFetch(`${BASE}/apps/${namespace}/${name}/start`, { method: "POST" });
    return (await resp.json()) as App;
  },

  logs: (namespace: string, name: string, lines = 200) =>
    getJSON<{ logs: string }>(`/apps/${namespace}/${name}/logs?lines=${lines}`),

  events: (namespace: string, name: string) =>
    getJSON<AppEvent[]>(`/apps/${namespace}/${name}/events`),
};
