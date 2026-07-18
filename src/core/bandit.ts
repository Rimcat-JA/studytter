import { CONFIG } from "./config";
import type { BanditArmState, InteractionSignal } from "./types";

export function rewardFromInteractions(
  signals: readonly InteractionSignal[],
): number {
  let reward = 0;
  for (const signal of signals) {
    if (signal.action === "quiz_correct" || signal.action === "like")
      reward = Math.max(reward, 1);
    else if (signal.action === "expand" || signal.action === "save")
      reward = Math.max(reward, 0.8);
    else if (signal.action === "quiz_wrong") reward = Math.max(reward, 0.5);
    else if (
      signal.action === "impression" &&
      (signal.dwellMs ?? 0) >= CONFIG.dwellRewardMs
    )
      reward = Math.max(reward, 0.4);
  }
  return reward;
}

export function updateArm(
  state: BanditArmState,
  reward: number,
): BanditArmState {
  const r = Math.min(1, Math.max(0, reward));
  return { alpha: state.alpha + r, beta: state.beta + 1 - r };
}

// Marsaglia–Tsang Gamma sampler. Shape < 1 is transformed recursively.
export function sampleGamma(
  shape: number,
  rng: () => number = Math.random,
): number {
  if (!(shape > 0)) throw new RangeError("shape must be positive");
  if (shape < 1)
    return (
      sampleGamma(shape + 1, rng) *
      Math.pow(Math.max(rng(), Number.EPSILON), 1 / shape)
    );
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = rng();
    if (
      u < 1 - 0.0331 * x ** 4 ||
      Math.log(Math.max(u, Number.EPSILON)) <
        0.5 * x ** 2 + d * (1 - v + Math.log(v))
    ) {
      return d * v;
    }
  }
}

export function sampleBeta(
  alpha: number,
  beta: number,
  rng: () => number = Math.random,
): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}
