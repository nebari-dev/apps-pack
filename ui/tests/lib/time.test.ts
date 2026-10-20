import { describe, expect, it } from "vitest";
import { relativeTime } from "@/lib/time";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [-5 * MIN, "just now"],
    [MIN, "1 min ago"],
    [2 * MIN + 30_000, "2 min ago"],
    [59 * MIN, "59 min ago"],
    [HOUR, "1 h ago"],
    [3 * HOUR, "3 h ago"],
    [23 * HOUR + 59 * MIN, "23 h ago"],
    [DAY, "yesterday"],
    [47 * HOUR, "yesterday"],
    [2 * DAY, "2 days ago"],
    [6 * DAY, "6 days ago"],
    [7 * DAY, "2026-10-13"],
  ])("%d ms ago reads %s", (elapsed, expected) => {
    expect(relativeTime(ago(elapsed), NOW)).toBe(expected);
  });

  it("returns an unparseable value unchanged", () => {
    expect(relativeTime("not a date", NOW)).toBe("not a date");
  });

  it("defaults to the current time", () => {
    expect(relativeTime(new Date().toISOString())).toBe("just now");
  });
});
