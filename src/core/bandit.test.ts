import { describe, expect, it } from "vitest";
import {
  rewardFromInteractions,
  sampleBeta,
  sampleGamma,
  updateArm,
} from "./bandit";
const rng =
  (seed = 1) =>
  () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
describe("bandit", () => {
  it("extracts the maximum reward", () => {
    expect(
      rewardFromInteractions([
        { action: "impression", dwellMs: 500 },
        { action: "quiz_wrong" },
        { action: "save" },
      ]),
    ).toBe(0.8);
    expect(
      rewardFromInteractions([{ action: "impression", dwellMs: 4000 }]),
    ).toBe(0.4);
    expect(rewardFromInteractions([{ action: "like" }])).toBe(1);
    expect(rewardFromInteractions([{ action: "expand" }])).toBe(0.8);
    expect(rewardFromInteractions([{ action: "quiz_correct" }])).toBe(1);
    expect(rewardFromInteractions([{ action: "skip" }])).toBe(0);
  });
  it("updates and clamps beta posterior", () => {
    expect(updateArm({ alpha: 1, beta: 1 }, 0.8)).toEqual({
      alpha: 1.8,
      beta: 1.2,
    });
    expect(updateArm({ alpha: 1, beta: 1 }, 2)).toEqual({ alpha: 2, beta: 1 });
    expect(updateArm({ alpha: 1, beta: 1 }, -1)).toEqual({ alpha: 1, beta: 2 });
  });
  it("rejects invalid gamma shapes", () =>
    expect(() => sampleGamma(0, rng())).toThrow(RangeError));
  it("samples gamma for shapes below and above one", () => {
    expect(sampleGamma(0.5, rng(2))).toBeGreaterThan(0);
    expect(sampleGamma(3, rng(3))).toBeGreaterThan(0);
  });
  it("beta sampler approaches known mean", () => {
    const random = rng(44);
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += sampleBeta(2, 5, random);
    expect(sum / 20000).toBeCloseTo(2 / 7, 1);
  });
});
