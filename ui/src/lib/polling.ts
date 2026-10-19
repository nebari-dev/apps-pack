/*
 * Polling cadence. Nothing polls by default; each query that shows live state
 * asks for a fast interval while the operator is still working on an app and
 * a slow one once every app it shows has settled. React Query pauses polling
 * in background tabs and refetches on focus, so the slow interval only has to
 * catch changes made elsewhere (kubectl, GitOps, another tab).
 */

/** Phases the operator has stopped working on. Failed is included: it can
 * recover on its own, but not on a timescale that needs fast polling. */
const SETTLED = new Set(["Running", "Stopped", "Failed"]);

export const isSettled = (phase: string | undefined) => phase !== undefined && SETTLED.has(phase);

/** `fast` while any of `phases` is still moving, `slow` once all have settled. */
export function pollFor<T extends number | false>(
  phases: (string | undefined)[],
  fast: number,
  slow: T,
): number | T {
  return phases.every(isSettled) ? slow : fast;
}

/** Interval for a query holding a list of apps (dashboard, apps, metrics). */
export const listInterval = (apps: { status?: { phase?: string } }[] | undefined) =>
  pollFor(
    (apps ?? []).map((a) => a.status?.phase),
    5_000,
    30_000,
  );
