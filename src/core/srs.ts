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
  return {
    stabilityDays: correct
      ? memory.stabilityDays * CONFIG.srsCorrectMultiplier
      : Math.max(
          CONFIG.minStabilityDays,
          memory.stabilityDays * CONFIG.srsWrongMultiplier,
        ),
    lastReviewedAt: now,
    reviewCount: memory.reviewCount + 1,
    lapseCount: memory.lapseCount + (correct ? 0 : 1),
  };
}
