/*
 * Polling cadence. Nothing polls by default; each query that shows live state
 * asks for a fast interval while the operator is still working on an app and
 * a slow one once every app it shows has settled. React Query pauses polling
 * in background tabs and refetches on focus, so the slow interval only has to
 * catch changes made elsewhere (kubectl, GitOps, another tab).
 *
 * An app counts as moving while any of these holds:
 *  - its phase is not one the operator has stopped working on;
 *  - the operator has not yet reconciled its latest spec
 *    (status.observedGeneration < generation), e.g. right after Start or Stop;
 *  - its ready replicas differ from the desired count (a restart's surge pod,
 *    a scale-up), unless it is Failed;
 *  - it was acted on from this tab in the last ACTION_WINDOW_MS. The action's
 *    refetch usually lands before the operator reacts, so without this the
 *    old, settled state would put the query back on the slow interval and the
 *    change would show up to a slow poll later. A restart never changes the
 *    App's spec, so this is the only signal that catches it before the rollout
 *    shows in the phase.
 *
 * None of these polls fast forever on a stuck app beyond what the phase alone
 * already did: the operator writes observedGeneration on every reconcile,
 * failed or not; a Running app has at least its desired replicas ready, so a
 * mismatch there is a rollout in progress; a crash-looping app is Deploying
 * (already fast) and a Failed one is exempt from the replica check; the window
 * expires.
 */
import type { App } from "./types";

/** Phases the operator has stopped working on. Failed is included: it can
 * recover on its own, but not on a timescale that needs fast polling. Idle
 * apps wake on a visit, which turns them Deploying on the next slow poll. */
const SETTLED = new Set(["Running", "Stopped", "Failed", "Idle"]);

/** How long an app polls fast after an action on it, whatever its state. */
export const ACTION_WINDOW_MS = 60_000;

/** What the cadence reads from an app; older APIs leave the generations out. */
export type PolledApp = Pick<App, "namespace" | "name"> & {
  generation?: number;
  status: Pick<App["status"], "phase" | "replicas" | "observedGeneration">;
};

/** "namespace/name" -> when its post-action fast window ends (ms since epoch). */
const actedOn = new Map<string, number>();

const keyOf = (app: Pick<App, "namespace" | "name">) => `${app.namespace}/${app.name}`;

/** Polls `apps` fast for the next ACTION_WINDOW_MS. Call before invalidating their queries. */
export function markActed(apps: Pick<App, "namespace" | "name">[], now = Date.now()) {
  for (const app of apps) actedOn.set(keyOf(app), now + ACTION_WINDOW_MS);
}

/** Forgets every window (tests). */
export function resetActed() {
  actedOn.clear();
}

function inActionWindow(app: Pick<App, "namespace" | "name">, now: number) {
  const until = actedOn.get(keyOf(app));
  if (until === undefined) return false;
  if (until > now) return true;
  actedOn.delete(keyOf(app));
  return false;
}

/** Whether the operator is done with `app` as far as the app's own state shows. */
export function isSettled(app: PolledApp): boolean {
  const { phase, replicas, observedGeneration } = app.status;
  if (!SETTLED.has(phase)) return false;
  if ((app.generation ?? 0) > (observedGeneration ?? 0)) return false;
  if (phase !== "Failed" && replicas && replicas.ready !== replicas.desired) return false;
  return true;
}

/** `fast` while any of `apps` is moving or was just acted on, `slow` once all have settled. */
export function pollFor<T extends number | false>(
  apps: (PolledApp | undefined)[],
  fast: number,
  slow: T,
  now = Date.now(),
): number | T {
  const still = (a: PolledApp | undefined) =>
    a !== undefined && isSettled(a) && !inActionWindow(a, now);
  return apps.every(still) ? slow : fast;
}

/** Interval for a query holding a list of apps (the apps page). */
export const listInterval = (apps: PolledApp[] | undefined, now = Date.now()) =>
  pollFor(apps ?? [], 5_000, 30_000, now);
