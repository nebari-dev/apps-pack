import type { App } from "@/lib/types";

/**
 * Who can open the app: "Public", any signed-in user, or the groups and users
 * the authz sidecar lets in.
 */
export function accessLine(a: App): string {
  if (a.access?.public) return "Public - no authentication";
  const groups = a.access?.groups ?? [];
  const users = a.access?.users ?? [];
  if (!groups.length && !users.length) return "Keycloak SSO at the gateway · any signed-in user";
  const parts = [
    groups.length ? `groups: ${groups.join(", ")}` : "",
    users.length ? `users: ${users.join(", ")}` : "",
  ].filter(Boolean);
  return `Keycloak SSO at the gateway · restricted to ${parts.join(" · ")}`;
}
