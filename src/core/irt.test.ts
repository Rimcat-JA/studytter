import { describe, expect, it } from "vitest";
import { difficultyFit, probabilityCorrect, updateIrt } from "./irt";
describe("irt", () => {
  it("uses logistic probability", () => {
    expect(probabilityCorrect(0, 0)).toBe(0.5);
    expect(probabilityCorrect(2, -2)).toBeGreaterThan(0.98);
  });
  it("raises ability after success", () => {
    const r = updateIrt({ theta: 0, attempts: 0 }, 0, true);
    expect(r.state.theta).toBeCloseTo(0.15);
    expect(r.difficultyB).toBeCloseTo(-0.05);
    expect(r.state.attempts).toBe(1);
  });
  it("lowers ability after failure and decays learning rate", () => {
    const r = updateIrt({ theta: 1, attempts: 20 }, 0, false);
    expect(r.state.theta).toBeLessThan(1);
    expect(r.difficultyB).toBeGreaterThan(0);
  });
  it("scores difficulty fit around target", () => {
    const b = -Math.log(0.78 / 0.22);
    expect(difficultyFit(0, b)).toBeCloseTo(1);
    expect(difficultyFit(-100, 100)).toBe(0);
  });
});
