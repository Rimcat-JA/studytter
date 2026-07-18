import { CONFIG } from "./config";
import { clamp01 } from "./srs";
import type { TopicAbilityState } from "./types";

export function probabilityCorrect(theta: number, difficultyB: number): number {
  return 1 / (1 + Math.exp(-(theta - difficultyB)));
}

export function updateIrt(
  state: TopicAbilityState,
  difficultyB: number,
  correct: boolean,
): { state: TopicAbilityState; difficultyB: number } {
  const p = probabilityCorrect(state.theta, difficultyB);
  const error = (correct ? 1 : 0) - p;
  const k =
    CONFIG.irtInitialK / (1 + state.attempts / CONFIG.irtKDecayAttempts);
  return {
    state: { theta: state.theta + k * error, attempts: state.attempts + 1 },
    difficultyB: difficultyB - CONFIG.irtDifficultyK * error,
  };
}

export function difficultyFit(theta: number, difficultyB: number): number {
  const p = probabilityCorrect(theta, difficultyB);
  return clamp01(
    1 - Math.abs(p - CONFIG.irtTargetSuccess) / CONFIG.irtTargetSuccess,
  );
}
