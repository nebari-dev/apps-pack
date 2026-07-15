/*
 * Keycloak authentication, following the Nebari react baseline (chat-pack).
 *
 * Auth config comes from the API at runtime (GET /api/v1/config), so a single
 * image works with auth on or off. When enabled, keycloak-js runs the SPA
 * PKCE flow against the public client the NebariApp provisioned
 * (auth.spaClient), and every API request carries the bearer token.
 */
import Keycloak from 'keycloak-js';
import type { UiConfig } from './types';

const nativeFetch = window.fetch.bind(window);

let keycloak: Keycloak | null = null;
let config: UiConfig = {
  authEnabled: false,
  keycloak: { url: '', realm: '', clientId: '' },
  appsDomain: '',
  appsScheme: 'https',
};

export class FetchError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, statusText: string, detail: string) {
    super(detail || `${status} ${statusText}`);
    this.name = 'FetchError';
    this.status = status;
    this.detail = detail;
  }
}

/** Load runtime config and, if auth is enabled, initialize Keycloak. */
export async function initAuth(): Promise<UiConfig> {
  try {
    const resp = await nativeFetch('/api/v1/config');
    if (resp.ok) {
      config = (await resp.json()) as UiConfig;
    }
  } catch {
    // API unreachable during boot - render anyway; queries will surface errors.
  }

  if (config.authEnabled && config.keycloak.url && config.keycloak.clientId) {
    keycloak = new Keycloak({
      url: config.keycloak.url,
      realm: config.keycloak.realm,
      clientId: config.keycloak.clientId,
    });
    await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false,
    });
  }
  return config;
}

export function getConfig(): UiConfig {
  return config;
}

export function getUser(): { name: string; email: string } | null {
  if (!keycloak?.authenticated) return null;
  return {
    name:
      (keycloak.tokenParsed?.preferred_username as string) ??
      (keycloak.tokenParsed?.name as string) ??
      '',
    email: (keycloak.tokenParsed?.email as string) ?? '',
  };
}

export async function logout(): Promise<void> {
  if (keycloak) {
    await keycloak.logout({ redirectUri: window.location.origin });
  }
}

/** fetch wrapper that attaches (and refreshes) the bearer token. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (keycloak) {
    await keycloak.updateToken(30).catch(() => keycloak?.login());
    headers.Authorization = `Bearer ${keycloak.token ?? ''}`;
  }
  const resp = await nativeFetch(url, { ...init, headers });
  if (!resp.ok) {
    let detail = '';
    try {
      const body = await resp.clone().json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      detail = await resp.text().catch(() => '');
    }
    throw new FetchError(resp.status, resp.statusText, detail);
  }
  return resp;
}
