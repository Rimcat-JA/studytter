import { sampleBeta } from "../core/bandit";
import { difficultyFit } from "../core/irt";
import { interleave, rankPosts } from "../core/ranker";
import { urgency } from "../core/srs";
import type { Format } from "../core/config";
import { getDb, listFeed, type PostRow } from "../db/database";

export async function loadRankedFeed(subjectId?: string): Promise<PostRow[]> {
  const db = await getDb();
  const posts = await listFeed(subjectId);
  const interactions = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM interactions",
  );
  const rankable = await Promise.all(
    posts.map(async (post) => {
      const arm = (await db.getFirstAsync<{ alpha: number; beta: number }>(
        "SELECT alpha,beta FROM bandit_arms WHERE topic_key=? AND format=?",
        post.topic_key,
        post.format,
      )) ?? { alpha: 1, beta: 1 };
      const memory = (await db.getFirstAsync<{
        stability_days: number;
        last_reviewed_at: number | null;
      }>(
        "SELECT stability_days,last_reviewed_at FROM atom_memory WHERE atom_id=?",
        post.atom_id,
      )) ?? { stability_days: 1, last_reviewed_at: null };
      const topic = (await db.getFirstAsync<{ theta: number }>(
        "SELECT theta FROM user_topic_state WHERE topic_key=?",
        post.topic_key,
      )) ?? { theta: 0 };
      return {
        ...post,
        subjectId: post.subject_id,
        atomId: post.atom_id,
        topicKey: post.topic_key,
        format: post.format as Format,
        difficultyB: post.difficulty_b,
        createdAt: post.created_at,
        engagement: sampleBeta(arm.alpha, arm.beta),
        urgency: urgency({
          stabilityDays: memory.stability_days,
          lastReviewedAt: memory.last_reviewed_at,
        }),
        difficultyFit: difficultyFit(topic.theta, post.difficulty_b),
      };
    }),
  );
  return interleave(rankPosts(rankable), interactions?.count ?? 0);
}
