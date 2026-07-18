import type { Format } from "./config";

export type InteractionAction =
  | "like"
  | "unlike"
  | "save"
  | "expand"
  | "quiz_correct"
  | "quiz_wrong"
  | "reveal"
  | "impression"
  | "skip";

export interface InteractionSignal {
  action: InteractionAction;
  dwellMs?: number | null;
}

export interface BanditArmState {
  alpha: number;
  beta: number;
}
export interface AtomMemoryState {
  stabilityDays: number;
  lastReviewedAt: number | null;
  reviewCount: number;
  lapseCount: number;
}
export interface TopicAbilityState {
  theta: number;
  attempts: number;
}

export interface RankablePost {
  id: string;
  subjectId: string;
  atomId: string;
  topicKey: string;
  format: Format;
  difficultyB: number;
  createdAt: number;
  engagement: number;
  urgency: number;
  difficultyFit: number;
}

export interface ScoredPost<T extends RankablePost = RankablePost> {
  post: T;
  score: number;
}

export interface SchedulerAtom {
  atomId: string;
  subjectId: string;
  topicLabel: string;
  core: string;
  note?: string | null;
  sourceAnchor: string;
  urgency: number;
  seenCount: number;
}

export interface SchedulerSubject {
  subjectId: string;
  formatWeights: Record<Exclude<Format, "entertainment">, number>;
}

export interface GenerationJob {
  atomId: string;
  subjectId: string;
  topicKey: string;
  format: Exclude<Format, "entertainment">;
  reason: "due" | "sampled" | "exploration";
}
