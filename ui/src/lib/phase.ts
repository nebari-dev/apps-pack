/**
 * App phases from most to least in need of attention. Tables sort by this so
 * a failing app is never buried under healthy ones; any other phase (unknown
 * or empty) sorts after all of these.
 */
export const PHASE_SEVERITY = [
  "Failed",
  "Deploying",
  "Pending",
  "Running",
  "Idle",
  "Stopped",
] as const;

export type KnownPhase = (typeof PHASE_SEVERITY)[number];

const rank = (phase: string | undefined): number => {
  const i = PHASE_SEVERITY.indexOf(phase as KnownPhase);
  return i === -1 ? PHASE_SEVERITY.length : i;
};

/** Sort comparator: more severe phases first, unknown or empty phases last. */
export function comparePhase(a: string | undefined, b: string | undefined): number {
  return rank(a) - rank(b);
}

type FailureSource = {
  status: {
    conditions?: { status: string; reason?: string; message?: string }[];
    message?: string;
  };
};

/**
 * A one-line reason an App is failing: the first condition that is not True
 * (its reason, else its message), else the App's status message.
 */
export function failureReason(app: FailureSource | undefined): string {
  if (!app) return "";
  const failing = (app.status.conditions ?? []).find((c) => c.status !== "True");
  return failing?.reason || failing?.message || app.status.message || "";
}
