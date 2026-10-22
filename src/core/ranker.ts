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
  // After enough interactions, guarantee at least one quiz in every window of
  // `quizSpacing` posts. Applying the quota during selection keeps quizzes
  // spread out and preserves both rank order and the subject-run limit.
  const quizQuota = interactionCount >= CONFIG.quizRatioInteractionThreshold;
  const quizSpacing = Math.max(
    1,
    Math.round(1 / CONFIG.minQuizRatioAfterInteractions),
  );
  let sinceQuiz = 0;
  while (pool.length) {
    const recentSubjects = learning
      .slice(-CONFIG.maxConsecutiveSubject)
      .map((p) => p.subjectId);
    const blockedSubject =
      recentSubjects.length === CONFIG.maxConsecutiveSubject &&
      recentSubjects.every((s) => s === recentSubjects[0])
        ? recentSubjects[0]
        : null;
    // The redundancy penalty depends on what was already placed, so it is
    // applied here against the feed being built rather than in rankPosts.
    const best = (accept: (post: T) => boolean) => {
      let found = -1;
      let bestScore = -Infinity;
      pool.forEach(({ post, score }, i) => {
        if (!accept(post)) return;
        const adjusted =
          (Number.isFinite(score) ? score : -Infinity) -
          CONFIG.scoreWeights.redundancy * redundancyPenalty(post, learning);
        if (found < 0 || adjusted > bestScore) {
          found = i;
          bestScore = adjusted;
        }
      });
      return found;
    };
    let index = -1;
    if (quizQuota && sinceQuiz >= quizSpacing - 1)
      index = best(
        (post) => post.format === "quiz" && post.subjectId !== blockedSubject,
      );
    if (index < 0) index = best((post) => post.subjectId !== blockedSubject);
    if (index < 0) index = 0;
    const next = pool.splice(index, 1)[0].post;
    sinceQuiz = next.format === "quiz" ? 0 : sinceQuiz + 1;
    learning.push(next);
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
