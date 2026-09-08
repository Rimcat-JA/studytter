import { sampleBeta } from "../core/bandit";
import { difficultyFit } from "../core/irt";
import { interleave, rankPosts } from "../core/ranker";
import { urgency } from "../core/srs";
import type { Format } from "../core/config";
import { getDb, type PostRow } from "../db/database";
import { selectFeedCandidates, type FeedOptions } from "../db/feed-candidates";

export async function loadRankedFeed(subjectId?: string, options: FeedOptions = {}): Promise<PostRow[]> {
  const db = await getDb();
  const posts = await selectFeedCandidates(db, subjectId, options);
  const interactions = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM interactions",
  );
  const now = Date.now();
  const rankable = posts.map((post) => ({
    ...post,
    subjectId: post.subject_id,
    atomId: post.atom_id,
    topicKey: post.topic_key,
    format: post.format as Format,
    difficultyB: post.difficulty_b,
    createdAt: post.created_at,
    engagement: sampleBeta(post.alpha, post.beta),
    urgency: urgency({ stabilityDays: post.stability_days, lastReviewedAt: post.last_reviewed_at }, now),
    difficultyFit: difficultyFit(post.theta, post.difficulty_b),
    display_name: post.format === "entertainment" ? "Study Break" : post.display_name,
    handle: post.format === "entertainment" ? "@learnstream_break" : post.handle,
    avatar_seed: post.format === "entertainment" ? "entertainer" : post.avatar_seed,
  }));
  // A saved break card must remain reachable even with no saved learning cards.
  if (options.savedOnly) return rankable.sort((a, b) => b.created_at - a.created_at);
  return interleave(rankPosts(rankable, [], now), interactions?.count ?? 0);
}
