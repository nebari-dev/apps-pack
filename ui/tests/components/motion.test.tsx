import { render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PhaseBadge } from "@/components/app-bits";
import { useArrived, useChanged } from "@/hooks/use-changed";
import * as motion from "@/lib/motion";

describe("useChanged", () => {
  it("is false on mount and true from the first change on", () => {
    const { result, rerender } = renderHook(({ v }) => useChanged(v), {
      initialProps: { v: "a" },
    });
    expect(result.current).toBe(false);
    rerender({ v: "a" });
    expect(result.current).toBe(false);
    rerender({ v: "b" });
    expect(result.current).toBe(true);
    // Back to the first value is still a change since mount.
    rerender({ v: "a" });
    expect(result.current).toBe(true);
  });
});

describe("useArrived", () => {
  it("is true only for content that replaced a placeholder", () => {
    const late = renderHook(({ ready }) => useArrived(ready), {
      initialProps: { ready: false },
    });
    expect(late.result.current).toBe(false);
    late.rerender({ ready: true });
    expect(late.result.current).toBe(true);

    const cached = renderHook(() => useArrived(true));
    expect(cached.result.current).toBe(false);
  });
});

describe("motion classes", () => {
  it("are all gated on prefers-reduced-motion", () => {
    for (const value of Object.values(motion)) {
      for (const cls of value.split(/\s+/)) expect(cls).toMatch(/^motion-safe:/);
    }
  });

  it("crossfade a status the App moves into, but not the first one shown", () => {
    const { rerender } = render(<PhaseBadge phase="Idle" />);
    expect(screen.getByText("Idle").className).not.toContain("animate-");
    rerender(<PhaseBadge phase="Deploying" />);
    expect(screen.getByText("Deploying").className).toContain(motion.FADE_IN);
  });
});
