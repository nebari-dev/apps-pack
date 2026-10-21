import type { App } from "@/lib/types";

/**
 * Who can open the app: "Public", any signed-in user, or the groups the
 * authz sidecar lets in.
 */
export function accessLine(a: App): string {
  if (a.access?.public) return "Public - no authentication";
  const groups = a.access?.groups ?? [];
  if (!groups.length) return "Keycloak SSO at the gateway · any signed-in user";
  return `Keycloak SSO at the gateway · restricted to groups: ${groups.join(", ")}`;
}

/** Owned or managed by the caller: what the Mine filter keeps. */
export function isMine(a: App, me: string | null): boolean {
  if (a.role) return a.role === "owner" || a.role === "manager";
  // An API without roles: owned only.
  return me !== null && a.owner === me;
}

/** Who can manage the app: its owner, the listed managers, and admins. */
export function managersLine(a: App): string {
  const users = a.access?.managers?.users ?? [];
  const groups = a.access?.managers?.groups ?? [];
  return [
    a.owner ? `${a.owner} (owner)` : "",
    users.length ? `users: ${users.join(", ")}` : "",
    groups.length ? `groups: ${groups.join(", ")}` : "",
    "admins",
  ]
    .filter(Boolean)
    .join(" · ");
}

const ROLE_NOTE: Record<string, string> = {
  owner: "You own this app.",
  manager: "You manage this app.",
  admin: "You can manage this app as an admin.",
};

/** A sentence naming the caller's role, or "" when the API does not say. */
export function roleNote(a: App): string {
  return ROLE_NOTE[a.role ?? ""] ?? "";
}
