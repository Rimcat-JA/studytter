import { CONFIG, LEARNING_FORMATS, type Format } from "./config";
import type {
  BanditArmState,
  GenerationJob,
  SchedulerAtom,
  SchedulerSubject,
} from "./types";
import { sampleBeta } from "./bandit";

type LearningFormat = Exclude<Format, "entertainment">;

export function weightedFormat(
  subject: SchedulerSubject,
  atom: SchedulerAtom,
  rng: () => number = Math.random,
): LearningFormat {
  const allowed = LEARNING_FORMATS.filter(
    (format) => format !== "comparison" || Boolean(atom.note?.trim()),
  );
  const total = allowed.reduce(
    (sum, format) => sum + Math.max(0, subject.formatWeights[format]),
    0,
  );
  if (total <= 0) return "explainer";
  let cursor = rng() * total;
  for (const format of allowed) {
    cursor -= Math.max(0, subject.formatWeights[format]);
    if (cursor <= 0) return format;
  }
  return allowed[allowed.length - 1];
}

export function assembleJobs(options: {
  atoms: readonly SchedulerAtom[];
  subjects: readonly SchedulerSubject[];
  arms: ReadonlyMap<string, BanditArmState>;
  count: number;
  rng?: () => number;
}): GenerationJob[] {
  const rng = options.rng ?? Math.random;
  const subjectMap = new Map(options.subjects.map((s) => [s.subjectId, s]));
  const count = Math.max(
    0,
    Math.min(options.count, options.atoms.length || options.count),
  );
  const dueCount = Math.round(count * CONFIG.refillMix.due);
  const explorationCount = Math.round(count * CONFIG.refillMix.exploration);
  const sampledCount = Math.max(0, count - dueCount - explorationCount);
  const chosen = new Set<string>();
  const jobs: GenerationJob[] = [];
  const add = (atom: SchedulerAtom, reason: GenerationJob["reason"]) => {
    const subject = subjectMap.get(atom.subjectId);
    if (!subject || chosen.has(atom.atomId)) return;
    chosen.add(atom.atomId);
    const format = weightedFormat(subject, atom, rng);
    jobs.push({
      atomId: atom.atomId,
      subjectId: atom.subjectId,
      topicKey: `${atom.subjectId}:${atom.topicLabel}`,
      format,
      reason,
    });
  };
  [...options.atoms]
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, dueCount)
    .forEach((atom) => add(atom, "due"));
  [...options.atoms]
    .filter((a) => !chosen.has(a.atomId))
    .sort((a, b) => a.seenCount - b.seenCount)
    .slice(0, explorationCount)
    .forEach((atom) => add(atom, "exploration"));
  const sampled = options.atoms
    .filter((atom) => !chosen.has(atom.atomId))
    .map((atom) => {
      const subject = subjectMap.get(atom.subjectId);
      const format = subject ? weightedFormat(subject, atom, rng) : "explainer";
      const state = options.arms.get(
        `${atom.subjectId}:${atom.topicLabel}:${format}`,
      ) ?? { alpha: 1, beta: 1 };
      return { atom, value: sampleBeta(state.alpha, state.beta, rng) };
    })
    .sort((a, b) => b.value - a.value);
  sampled.slice(0, sampledCount).forEach(({ atom }) => add(atom, "sampled"));
  // If atoms were exhausted by overlapping buckets, fill from remaining candidates.
  options.atoms
    .filter((a) => !chosen.has(a.atomId))
    .slice(0, count - jobs.length)
    .forEach((atom) => add(atom, "sampled"));
  return jobs;
}

export function shouldFlagRareCard(
  correctStreak: number,
  rng: () => number = Math.random,
): boolean {
  if (correctStreak < CONFIG.rareCardMinCorrectStreak) return false;
  return (
    rng() <
    Math.min(
      CONFIG.rareCardBaseChance * correctStreak,
      CONFIG.rareCardMaxChance,
    )
  );
}
