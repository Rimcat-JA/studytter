import type { SQLiteDatabase } from "expo-sqlite";
import { rewardFromInteractions } from "../core/bandit";
import { CONFIG } from "../core/config";
import { updateIrt } from "../core/irt";
import { DAY_MS, reviewMemory } from "../core/srs";
import type { InteractionAction, InteractionSignal } from "../core/types";
import { captureDatabaseGeneration, createId, getDbForGeneration, withDbTransaction } from "../db/database";
import { grantXpInTransaction, recordLearningDayInTransaction } from "../gamification";
import { QuizSchema } from "../llm/schemas";

type QuizAction = "quiz_correct" | "quiz_wrong";
type Post = {
  atom_id: string;
  topic_key: string;
  format: string;
  difficulty_b: number;
  is_rare_card: number;
  quiz_json: string | null;
};
type AttemptRow = {
  id: string;
  post_id: string;
  session_key: string;
  answer_index: number | null;
  correct: number;
  created_at: number;
  next_review_at: number;
};
export type QuizAttempt = {
  sessionKey: string;
  completed: boolean;
  answerIndex: number | null;
  correct: boolean | null;
  nextReviewAt: number | null;
};

function completedAttempt(row: AttemptRow): QuizAttempt {
  return {
    sessionKey: row.session_key,
    completed: true,
    answerIndex: row.answer_index,
    correct: row.correct === 1,
    nextReviewAt: row.next_review_at,
  };
}

async function quizAttempt(db: SQLiteDatabase, postId: string, now = Date.now()): Promise<QuizAttempt> {
  const latest = await db.getFirstAsync<AttemptRow>(
    "SELECT * FROM quiz_attempts WHERE post_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", postId,
  );
  if (latest && now < latest.next_review_at) return completedAttempt(latest);
  return {
    sessionKey: latest ? `after:${latest.id}` : `initial:${postId}`,
    completed: false,
    answerIndex: null,
    correct: null,
    nextReviewAt: null,
  };
}

export async function getPostInteractionState(postId: string) {
  const databaseGeneration = captureDatabaseGeneration();
  const db = await getDbForGeneration(databaseGeneration);
  const flags = await db.getFirstAsync<{ liked: number; saved: number }>(
    `SELECT
      CASE WHEN (SELECT action FROM interactions WHERE post_id=? AND action IN ('like','unlike') ORDER BY created_at DESC,rowid DESC LIMIT 1)='like' THEN 1 ELSE 0 END liked,
      CASE WHEN (SELECT action FROM interactions WHERE post_id=? AND action IN ('save','unsave') ORDER BY created_at DESC,rowid DESC LIMIT 1)='save' THEN 1 ELSE 0 END saved`,
    postId, postId,
  );
  return {
    databaseGeneration,
    liked: flags?.liked === 1,
    saved: flags?.saved === 1,
    attempt: await quizAttempt(db, postId),
  };
}

async function getActionPost(db: SQLiteDatabase, postId: string): Promise<Post> {
  const post = await db.getFirstAsync<Post>(
    "SELECT atom_id,topic_key,format,difficulty_b,is_rare_card,quiz_json FROM posts WHERE id=?", postId,
  );
  if (!post) throw new Error("Post no longer exists");
  return post;
}

/** Non-answer actions also commit their reward and streak changes together. */
export async function recordAction(
  postId: string,
  action: Exclude<InteractionAction, QuizAction>,
  dwellMs?: number,
  databaseGeneration?: number,
): Promise<void> {
  // Keep runtime callers from bypassing answer validation and idempotency.
  if ((action as string) === "quiz_correct" || (action as string) === "quiz_wrong")
    throw new Error("Quiz answers require a review session");
  await withDbTransaction(async (db) => {
    const post = await getActionPost(db, postId);
    await applyAction(db, postId, post, action, dwellMs);
  }, databaseGeneration);
}

/** A session survives recycling/reopening; only a due review gets a new one. */
export async function submitQuizAnswer(
  postId: string,
  sessionKey: string,
  answer: { answerIndex: number } | { correct: boolean },
  databaseGeneration?: number,
): Promise<QuizAttempt> {
  return withDbTransaction(async (db) => {
    const post = await getActionPost(db, postId);
    const existing = await db.getFirstAsync<AttemptRow>(
      "SELECT * FROM quiz_attempts WHERE post_id=? AND session_key=?", postId, sessionKey,
    );
    // Retrying an old submission remains a no-op even after its next review is due.
    if (existing) return completedAttempt(existing);
    const now = Date.now();
    const current = await quizAttempt(db, postId, now);
    if (current.completed || current.sessionKey !== sessionKey)
      throw new Error("Review session changed; reload the card");
    const quiz = QuizSchema.parse(JSON.parse(post.quiz_json ?? "null"));
    let answerIndex: number | null = null;
    let correct: boolean;
    if (quiz.choices) {
      if (!("answerIndex" in answer) || !Number.isInteger(answer.answerIndex) ||
          answer.answerIndex < 0 || answer.answerIndex >= quiz.choices.length)
        throw new Error("Choose one of the available answers");
      answerIndex = answer.answerIndex;
      correct = answerIndex === quiz.answerIndex;
    } else {
      if (!("correct" in answer) || typeof answer.correct !== "boolean")
        throw new Error("Self assessment is required");
      correct = answer.correct;
    }
    // UNIQUE(post_id,session_key) is the final duplicate guard.
    const attemptId = createId("attempt");
    await db.runAsync(
      "INSERT INTO quiz_attempts(id,post_id,session_key,answer_index,correct,created_at,next_review_at) VALUES(?,?,?,?,?,?,?)",
      attemptId, postId, sessionKey, answerIndex, correct ? 1 : 0, now, now + DAY_MS,
    );
    const stabilityDays = await applyAction(
      db, postId, post, correct ? "quiz_correct" : "quiz_wrong", undefined, attemptId, now,
    );
    const nextReviewAt = Math.ceil(now + Math.max(
      60_000, -Math.log(CONFIG.urgencyRetentionTarget) * (stabilityDays ?? 1) * DAY_MS,
    ));
    await db.runAsync("UPDATE quiz_attempts SET next_review_at=? WHERE id=?", nextReviewAt, attemptId);
    return { sessionKey, completed: true, answerIndex, correct, nextReviewAt };
  }, databaseGeneration);
}

async function applyAction(
  db: SQLiteDatabase,
  postId: string,
  post: Post,
  action: InteractionAction,
  dwellMs?: number,
  attemptId?: string,
  now = Date.now(),
): Promise<number | undefined> {
  await db.runAsync(
    "INSERT INTO interactions(id,post_id,action,dwell_ms,created_at) VALUES(?,?,?,?,?)",
    createId("ix"), postId, action, dwellMs ?? null, now,
  );
  if (["like", "save", "expand", "quiz_correct", "quiz_wrong", "impression", "skip"].includes(action)) {
    const rows = await db.getAllAsync<{
      post_id: string;
      action: InteractionAction;
      dwell_ms: number | null;
    }>(
      "SELECT i.post_id,i.action,i.dwell_ms FROM interactions i JOIN posts p ON p.id=i.post_id WHERE p.topic_key=? AND p.format=?",
      post.topic_key, post.format,
    );
    const grouped = new Map<string, InteractionSignal[]>();
    for (const row of rows) {
      const signals = grouped.get(row.post_id) ?? [];
      signals.push({ action: row.action, dwellMs: row.dwell_ms });
      grouped.set(row.post_id, signals);
    }
    let sum = 0;
    for (const signals of grouped.values()) sum += rewardFromInteractions(signals);
    await db.runAsync(
      "INSERT INTO bandit_arms(topic_key,format,alpha,beta) VALUES(?,?,?,?) ON CONFLICT(topic_key,format) DO UPDATE SET alpha=excluded.alpha,beta=excluded.beta",
      post.topic_key, post.format, 1 + sum, 1 + grouped.size - sum,
    );
  }
  const isCorrect = action === "quiz_correct";
  let stabilityDays: number | undefined;
  if ((isCorrect || action === "quiz_wrong") && post.atom_id !== "_entertainment") {
    const memory = (await db.getFirstAsync<{
      stability_days: number;
      last_reviewed_at: number | null;
      review_count: number;
      lapse_count: number;
    }>("SELECT * FROM atom_memory WHERE atom_id=?", post.atom_id)) ?? {
      stability_days: 1, last_reviewed_at: null, review_count: 0, lapse_count: 0,
    };
    const nextMemory = reviewMemory({
      stabilityDays: memory.stability_days, lastReviewedAt: memory.last_reviewed_at,
      reviewCount: memory.review_count, lapseCount: memory.lapse_count,
    }, isCorrect, now);
    stabilityDays = nextMemory.stabilityDays;
    await db.runAsync(
      "INSERT INTO atom_memory(atom_id,stability_days,last_reviewed_at,review_count,lapse_count) VALUES(?,?,?,?,?) ON CONFLICT(atom_id) DO UPDATE SET stability_days=excluded.stability_days,last_reviewed_at=excluded.last_reviewed_at,review_count=excluded.review_count,lapse_count=excluded.lapse_count",
      post.atom_id, nextMemory.stabilityDays, nextMemory.lastReviewedAt, nextMemory.reviewCount, nextMemory.lapseCount,
    );
    const topic = (await db.getFirstAsync<{ theta: number; attempts: number }>(
      "SELECT theta,attempts FROM user_topic_state WHERE topic_key=?", post.topic_key,
    )) ?? { theta: 0, attempts: 0 };
    const nextIrt = updateIrt(topic, post.difficulty_b, isCorrect);
    await db.runAsync(
      "INSERT INTO user_topic_state(topic_key,theta,attempts) VALUES(?,?,?) ON CONFLICT(topic_key) DO UPDATE SET theta=excluded.theta,attempts=excluded.attempts",
      post.topic_key, nextIrt.state.theta, nextIrt.state.attempts,
    );
    await db.runAsync("UPDATE posts SET difficulty_b=? WHERE id=?", nextIrt.difficultyB, postId);
  }
  if (action === "impression")
    await db.runAsync("UPDATE posts SET status='served' WHERE id=? AND status='unread'", postId);
  else if (["like", "save", "expand", "quiz_correct", "quiz_wrong", "reveal"].includes(action))
    await db.runAsync("UPDATE posts SET status='consumed' WHERE id=?", postId);
  if (action === "like") await grantXpInTransaction(db, "like", postId);
  if (action === "quiz_correct") {
    await grantXpInTransaction(db, "quiz_correct", attemptId);
    if (post.is_rare_card) await grantXpInTransaction(db, "rare_card", attemptId);
  }
  if (action === "expand") await grantXpInTransaction(db, "expand", postId);
  if (["like", "save", "expand", "quiz_correct", "quiz_wrong", "reveal"].includes(action))
    await recordLearningDayInTransaction(db);
  return stabilityDays;
}
