import { afterEach, describe, expect, it } from "vitest";
import {
  ACTION_WINDOW_MS,
  isSettled,
  listInterval,
  markActed,
  type PolledApp,
  pollFor,
  resetActed,
} from "@/lib/polling";

const app = (
  phase: PolledApp["status"]["phase"],
  extra: Partial<Omit<PolledApp, "status">> & { status?: Partial<PolledApp["status"]> } = {},
): PolledApp => ({
  namespace: "apps",
  name: "demo",
  ...extra,
  status: { phase, ...extra.status },
});

afterEach(() => resetActed());

describe("isSettled", () => {
  it("treats Running, Stopped, Failed and Idle as settled", () => {
    for (const phase of ["Running", "Stopped", "Failed", "Idle"] as const)
      expect(isSettled(app(phase))).toBe(true);
    for (const phase of ["Pending", "Deploying", ""] as const)
      expect(isSettled(app(phase))).toBe(false);
  });

  it("is unsettled while the operator has not reconciled the latest spec", () => {
    expect(isSettled(app("Running", { generation: 3, status: { observedGeneration: 2 } }))).toBe(
      false,
    );
    expect(isSettled(app("Running", { generation: 3, status: { observedGeneration: 3 } }))).toBe(
      true,
    );
    // Before the operator's first reconcile there is no observedGeneration.
    expect(isSettled(app("Running", { generation: 1 }))).toBe(false);
    // An older API sends neither: fall back to the phase.
    expect(isSettled(app("Running"))).toBe(true);
  });

  it("is unsettled while ready replicas differ from desired", () => {
    expect(isSettled(app("Running", { status: { replicas: { desired: 2, ready: 3 } } }))).toBe(
      false,
    );
    expect(isSettled(app("Stopped", { status: { replicas: { desired: 0, ready: 1 } } }))).toBe(
      false,
    );
    expect(isSettled(app("Running", { status: { replicas: { desired: 2, ready: 2 } } }))).toBe(
      true,
    );
  });

  it("keeps a Failed app settled even with replicas missing, so it never polls fast forever", () => {
    expect(isSettled(app("Failed", { status: { replicas: { desired: 1, ready: 0 } } }))).toBe(true);
  });
});

describe("pollFor", () => {
  it("polls fast until every app has settled", () => {
    expect(pollFor([app("Running"), app("Deploying")], 5_000, 30_000)).toBe(5_000);
    expect(pollFor([app("Running"), app("Stopped")], 5_000, 30_000)).toBe(30_000);
    expect(pollFor([undefined], 5_000, false)).toBe(5_000);
    expect(pollFor([app("Stopped")], 5_000, false)).toBe(false);
  });

  it("polls fast for a bounded window after an action, whatever the state", () => {
    const now = 1_000_000;
    const running = app("Running");
    markActed([running], now);
    expect(pollFor([running], 5_000, 30_000, now)).toBe(5_000);
    expect(pollFor([running], 5_000, 30_000, now + ACTION_WINDOW_MS - 1)).toBe(5_000);
    expect(pollFor([running], 5_000, 30_000, now + ACTION_WINDOW_MS)).toBe(30_000);
    // Once expired it stays expired.
    expect(pollFor([running], 5_000, 30_000, now)).toBe(30_000);
  });

  it("applies the window only to the app acted on", () => {
    const now = 1_000_000;
    markActed([app("Running", { name: "other" })], now);
    expect(pollFor([app("Running")], 5_000, 30_000, now)).toBe(30_000);
  });

  it("does not keep a Failed app fast once its window has passed", () => {
    const now = 1_000_000;
    const failed = app("Failed", { status: { replicas: { desired: 1, ready: 0 } } });
    markActed([failed], now);
    expect(pollFor([failed], 5_000, 30_000, now)).toBe(5_000);
    expect(pollFor([failed], 5_000, 30_000, now + ACTION_WINDOW_MS + 1)).toBe(30_000);
  });
});

describe("listInterval", () => {
  it("backs a list off once nothing is moving", () => {
    expect(listInterval(undefined)).toBe(30_000);
    expect(listInterval([])).toBe(30_000);
    expect(listInterval([app("Running"), app("Pending", { name: "b" })])).toBe(5_000);
    expect(listInterval([app("Running")])).toBe(30_000);
  });

  it("polls fast when any listed app was just acted on", () => {
    const now = 1_000_000;
    markActed([app("Stopped", { name: "b" })], now);
    expect(listInterval([app("Running"), app("Stopped", { name: "b" })], now)).toBe(5_000);
  });
});
