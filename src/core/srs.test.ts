import { describe, expect, it } from "vitest";
import { DAY_MS, clamp01, retention, reviewMemory, urgency } from "./srs";
describe("srs", () => {
  it("computes forgetting curve", () => {
    expect(retention(2, 0, 2 * DAY_MS)).toBeCloseTo(Math.exp(-1));
    expect(retention(1, null)).toBe(0);
    expect(retention(0.1, DAY_MS, 0)).toBe(1);
  });
  it("computes clamped urgency", () => {
    expect(urgency({ stabilityDays: 1, lastReviewedAt: null })).toBe(1);
    expect(urgency({ stabilityDays: 10, lastReviewedAt: Date.now() })).toBe(0);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
  it("updates correct review", () => {
    expect(
      reviewMemory(
        {
          stabilityDays: 1,
          lastReviewedAt: null,
          reviewCount: 0,
          lapseCount: 0,
        },
        true,
        123,
      ),
    ).toEqual({
      stabilityDays: 2.2,
      lastReviewedAt: 123,
      reviewCount: 1,
      lapseCount: 0,
    });
  });
  it("updates incorrect review with floor", () => {
    expect(
      reviewMemory(
        {
          stabilityDays: 0.6,
          lastReviewedAt: 0,
          reviewCount: 2,
          lapseCount: 1,
        },
        false,
        456,
      ),
    ).toEqual({
      stabilityDays: 0.5,
      lastReviewedAt: 456,
      reviewCount: 3,
      lapseCount: 2,
    });
  });
});
