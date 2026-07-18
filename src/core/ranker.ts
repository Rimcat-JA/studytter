import { CONFIG } from "./config";
import type { RankablePost, ScoredPost } from "./types";

const DAY_MS = 86_400_000;

export function freshness(createdAt: number, now = Date.now()): number {
  const age = Math.max(0, now - createdAt);
  if (age < DAY_MS) return 1;
  return Math.max(0, 1 - (age - DAY_MS) / (6 * DAY_MS));
}

export function redundancyPenalty(
  post: Pick<RankablePost, "atomId" | "topicKey">,
  recent: readonly Pick<RankablePost, "atomId" | "topicKey">[],
): number {
  if (
    recent
      .slice(-CONFIG.recentAtomWindow)
      .some((item) => item.atomId === post.atomId)
  )
    return 1;
  const lastThree = recent.slice(-3);
  if (
    lastThree.length === 3 &&
    lastThree.every((item) => item.topicKey === post.topicKey)
  )
    return 0.5;
  return 0;
}

export function scorePost(
  post: RankablePost,
  recent: readonly RankablePost[] = [],
  now = Date.now(),
): number {
  const w = CONFIG.scoreWeights;
  return (
    w.engagement * post.engagement +
    w.urgency * post.urgency +
    w.difficultyFit * post.difficultyFit +
    w.freshness * freshness(post.createdAt, now) -
    w.redundancy * redundancyPenalty(post, recent)
  );
}

export function rankPosts<T extends RankablePost>(
  posts: readonly T[],
  recent: readonly T[] = [],
  now = Date.now(),
): ScoredPost<T>[] {
  return posts
    .map((post) => ({ post, score: scorePost(post, recent, now) }))
    .sort((a, b) => b.score - a.score);
}

export function interleave<T extends RankablePost>(
  ranked: readonly ScoredPost<T>[],
  interactionCount: number,
  rng: () => number = Math.random,
): T[] {
  const entertainment = ranked
    .filter(({ post }) => post.format === "entertainment")
    .map(({ post }) => post);
  const pool = ranked.filter(({ post }) => post.format !== "entertainment");
  const learning: T[] = [];
  while (pool.length) {
    const recentSubjects = learning
      .slice(-CONFIG.maxConsecutiveSubject)
      .map((p) => p.subjectId);
    const blockedSubject =
      recentSubjects.length === CONFIG.maxConsecutiveSubject &&
      recentSubjects.every((s) => s === recentSubjects[0])
        ? recentSubjects[0]
        : null;
    let index = pool.findIndex(({ post }) => post.subjectId !== blockedSubject);
    if (index < 0) index = 0;
    learning.push(pool.splice(index, 1)[0].post);
  }
  if (interactionCount >= CONFIG.quizRatioInteractionThreshold) {
    const target = Math.min(
      Math.ceil(learning.length * CONFIG.minQuizRatioAfterInteractions),
      learning.filter((p) => p.format === "quiz").length,
    );
    for (let i = 0; i < target; i++) {
      if (learning[i].format === "quiz") continue;
      const later = learning.findIndex((p, j) => j > i && p.format === "quiz");
      if (later < 0) break;
      [learning[i], learning[later]] = [learning[later], learning[i]];
    }
  }
  const output: T[] = [];
  let nextBreak =
    CONFIG.entertainmentIntervalMin +
    Math.floor(
      rng() *
        (CONFIG.entertainmentIntervalMax - CONFIG.entertainmentIntervalMin + 1),
    );
  let breakIndex = 0;
  for (const post of learning) {
    output.push(post);
    if (
      output.filter((p) => p.format !== "entertainment").length === nextBreak &&
      breakIndex < entertainment.length
    ) {
      output.push(entertainment[breakIndex++]);
      nextBreak +=
        CONFIG.entertainmentIntervalMin +
        Math.floor(
          rng() *
            (CONFIG.entertainmentIntervalMax -
              CONFIG.entertainmentIntervalMin +
              1),
        );
    }
  }
  return output;
}
