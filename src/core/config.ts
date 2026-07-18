export const CONFIG = {
  pdfChunkPages: 20,
  pdfMaxPages: 150,
  imagesPerChunk: 8,
  generationBatchMin: 10,
  generationBatchMax: 20,
  extractionMaxAtoms: 60,
  atomDedupeThreshold: 0.8,
  postDedupeThreshold: 0.7,
  dwellRewardMs: 4_000,
  skipMs: 1_000,
  srsCorrectMultiplier: 2.2,
  srsWrongMultiplier: 0.5,
  minStabilityDays: 0.5,
  urgencyRetentionTarget: 0.9,
  irtInitialK: 0.3,
  irtKDecayAttempts: 20,
  irtDifficultyK: 0.1,
  irtTargetSuccess: 0.78,
  scoreWeights: {
    engagement: 0.35,
    urgency: 0.3,
    difficultyFit: 0.2,
    freshness: 0.05,
    redundancy: 0.1,
  },
  unreadRefillThreshold: 30,
  refillMix: { due: 0.25, sampled: 0.6, exploration: 0.15 },
  recentAtomWindow: 10,
  maxConsecutiveSubject: 2,
  minQuizRatioAfterInteractions: 0.2,
  quizRatioInteractionThreshold: 50,
  entertainmentIntervalMin: 8,
  entertainmentIntervalMax: 12,
  rareCardBaseChance: 0.05,
  rareCardMaxChance: 0.35,
  rareCardMinCorrectStreak: 3,
  dailyInteractionsForStreak: 5,
  maxStreakFreezes: 2,
  notificationQuietStartHour: 22,
  notificationQuietEndHour: 8,
  maxNotificationsPerDay: 2,
} as const;

export type Format =
  | "explainer"
  | "quiz"
  | "funfact"
  | "misconception"
  | "comparison"
  | "mnemonic"
  | "entertainment";

export const LEARNING_FORMATS: readonly Exclude<Format, "entertainment">[] = [
  "explainer",
  "quiz",
  "funfact",
  "misconception",
  "comparison",
  "mnemonic",
];
