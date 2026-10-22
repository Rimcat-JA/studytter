import { CONFIG } from "./config";
import type { AtomMemoryState } from "./types";

export const DAY_MS = 86_400_000;
export const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function retention(
  stabilityDays: number,
  lastReviewedAt: number | null,
  now = Date.now(),
): number {
  if (lastReviewedAt === null) return 0;
  const elapsedDays = Math.max(0, now - lastReviewedAt) / DAY_MS;
  return Math.exp(
    -elapsedDays / Math.max(CONFIG.minStabilityDays, stabilityDays),
  );
}

export function urgency(
  memory: Pick<AtomMemoryState, "stabilityDays" | "lastReviewedAt">,
  now = Date.now(),
): number {
  const r = retention(memory.stabilityDays, memory.lastReviewedAt, now);
  return clamp01(
    (CONFIG.urgencyRetentionTarget - r) / CONFIG.urgencyRetentionTarget,
  );
}

export function reviewMemory(
  memory: AtomMemoryState,
  correct: boolean,
  now = Date.now(),
): AtomMemoryState {
  // Massed practice (several quiz posts of one atom answered back to back)
  // must not compound stability: the gain scales with how much of the
  // current stability interval has actually elapsed (spacing effect).
  const spacing =
    memory.lastReviewedAt === null
      ? 1
      : clamp01(
          Math.max(0, now - memory.lastReviewedAt) /
            DAY_MS /
            Math.max(CONFIG.minStabilityDays, memory.stabilityDays),
        );
  return {
    stabilityDays: correct
      ? memory.stabilityDays *
        (1 + (CONFIG.srsCorrectMultiplier - 1) * spacing)
      : Math.max(
          CONFIG.minStabilityDays,
          memory.stabilityDays * CONFIG.srsWrongMultiplier,
        ),
    lastReviewedAt: now,
    reviewCount: memory.reviewCount + 1,
    lapseCount: memory.lapseCount + (correct ? 0 : 1),
  };
}
