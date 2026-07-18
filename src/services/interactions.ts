import { rewardFromInteractions } from "../core/bandit";
import { updateIrt } from "../core/irt";
import { reviewMemory } from "../core/srs";
import { addInteraction, getDb } from "../db/database";
import { grantXp, recordLearningDay } from "../gamification";

export async function recordAction(
  postId: string,
  action: string,
  dwellMs?: number,
): Promise<void> {
  await addInteraction(postId, action, dwellMs);
  const db = await getDb();
  const post = await db.getFirstAsync<{
    atom_id: string;
    topic_key: string;
    format: string;
    difficulty_b: number;
    is_rare_card: number;
  }>(
    "SELECT atom_id,topic_key,format,difficulty_b,is_rare_card FROM posts WHERE id=?",
    postId,
  );
  if (!post) return;
  if (
    [
      "like",
      "save",
      "expand",
      "quiz_correct",
      "quiz_wrong",
      "impression",
      "skip",
    ].includes(action)
  ) {
    const rows = await db.getAllAsync<{
      post_id: string;
      action: string;
      dwell_ms: number | null;
    }>(
      `SELECT i.post_id,i.action,i.dwell_ms FROM interactions i JOIN posts p ON p.id=i.post_id WHERE p.topic_key=? AND p.format=?`,
      post.topic_key,
      post.format,
    );
    const grouped = new Map<
      string,
      { action: never; dwellMs: number | null }[]
    >();
    for (const row of rows) {
      const signals = grouped.get(row.post_id) ?? [];
      signals.push({ action: row.action as never, dwellMs: row.dwell_ms });
      grouped.set(row.post_id, signals);
    }
    let sum = 0;
    for (const signals of grouped.values())
      sum += rewardFromInteractions(signals);
    await db.runAsync(
      "INSERT INTO bandit_arms(topic_key,format,alpha,beta) VALUES(?,?,?,?) ON CONFLICT(topic_key,format) DO UPDATE SET alpha=excluded.alpha,beta=excluded.beta",
      post.topic_key,
      post.format,
      1 + sum,
      1 + grouped.size - sum,
    );
  }
  const isCorrect = action === "quiz_correct";
  const isWrong = action === "quiz_wrong";
  if ((isCorrect || isWrong) && post.atom_id !== "_entertainment") {
    const memory = (await db.getFirstAsync<{
      stability_days: number;
      last_reviewed_at: number | null;
      review_count: number;
      lapse_count: number;
    }>("SELECT * FROM atom_memory WHERE atom_id=?", post.atom_id)) ?? {
      stability_days: 1,
      last_reviewed_at: null,
      review_count: 0,
      lapse_count: 0,
    };
    const nextMemory = reviewMemory(
      {
        stabilityDays: memory.stability_days,
        lastReviewedAt: memory.last_reviewed_at,
        reviewCount: memory.review_count,
        lapseCount: memory.lapse_count,
      },
      isCorrect,
    );
    await db.runAsync(
      "INSERT INTO atom_memory(atom_id,stability_days,last_reviewed_at,review_count,lapse_count) VALUES(?,?,?,?,?) ON CONFLICT(atom_id) DO UPDATE SET stability_days=excluded.stability_days,last_reviewed_at=excluded.last_reviewed_at,review_count=excluded.review_count,lapse_count=excluded.lapse_count",
      post.atom_id,
      nextMemory.stabilityDays,
      nextMemory.lastReviewedAt,
      nextMemory.reviewCount,
      nextMemory.lapseCount,
    );
    const topic = (await db.getFirstAsync<{ theta: number; attempts: number }>(
      "SELECT theta,attempts FROM user_topic_state WHERE topic_key=?",
      post.topic_key,
    )) ?? { theta: 0, attempts: 0 };
    const nextIrt = updateIrt(topic, post.difficulty_b, isCorrect);
    await db.runAsync(
      "INSERT INTO user_topic_state(topic_key,theta,attempts) VALUES(?,?,?) ON CONFLICT(topic_key) DO UPDATE SET theta=excluded.theta,attempts=excluded.attempts",
      post.topic_key,
      nextIrt.state.theta,
      nextIrt.state.attempts,
    );
    await db.runAsync(
      "UPDATE posts SET difficulty_b=? WHERE id=?",
      nextIrt.difficultyB,
      postId,
    );
  }
  if (action === "impression")
    await db.runAsync(
      "UPDATE posts SET status='served' WHERE id=? AND status='unread'",
      postId,
    );
  else if (
    ["like", "save", "expand", "quiz_correct", "quiz_wrong", "reveal"].includes(
      action,
    )
  )
    await db.runAsync("UPDATE posts SET status='consumed' WHERE id=?", postId);
  if (action === "like") await grantXp("like", postId);
  if (action === "quiz_correct") {
    await grantXp("quiz_correct", postId);
    if (post.is_rare_card) await grantXp("rare_card", postId);
  }
  if (action === "expand") await grantXp("expand", postId);
  if (
    ["like", "save", "expand", "quiz_correct", "quiz_wrong", "reveal"].includes(
      action,
    )
  )
    await recordLearningDay();
}
