import { createId, getDb, getSetting } from "../db/database";
import type { GenerationJob } from "../core/types";
import { getPurposeRoute } from "./config";
import { jaccard } from "./extract";
import { createProvider, type ProviderId } from "./provider";
import { GeneratedPostsSchema, type GeneratedPosts } from "./schemas";
import { logUsage } from "./usage";
import { shouldFlagRareCard } from "../core/scheduler";
import { classifyGenerationError } from "../core/autogeneration";

const SYSTEM = `Write grounded micro-learning posts in the subject language. Plain text, no markdown, target <=280 characters. Use only atom core/note, never outside facts. Quiz has exactly one unambiguous correct answer and a one-sentence explanation. A comparison must use a confusable concept already named in core/note.`;

export async function generateBatch(
  jobs: readonly GenerationJob[],
  providerId: ProviderId,
  model: string,
): Promise<number> {
  if (!jobs.length) return 0;
  const db = await getDb();
  const details = [];
  for (const job of jobs) {
    const atom = await db.getFirstAsync<{
      core: string;
      note: string | null;
      source_anchor: string;
      difficulty: number;
    }>(
      "SELECT core,note,source_anchor,difficulty FROM atoms WHERE atom_id=? AND enabled=1",
      job.atomId,
    );
    const subject = await db.getFirstAsync<{
      display_name: string;
      handle: string;
      content_lang: string;
    }>(
      "SELECT display_name,handle,content_lang FROM subjects WHERE subject_id=?",
      job.subjectId,
    );
    if (atom && subject)
      details.push({
        job,
        atom,
        persona: subject,
        language: subject.content_lang,
      });
  }
  if (!details.length) return 0;
  const provider = createProvider(providerId);
  let lastError = "";
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await provider.generateJson<GeneratedPosts>({
        model,
        system: SYSTEM,
        user: [
          {
            type: "text",
            text: `${attempt ? `Fix previous validation: ${lastError}. ` : ""}Generate one result per job: ${JSON.stringify(details)}`,
          },
        ],
        schema: GeneratedPostsSchema,
        maxTokens: 5_000,
      });
      await logUsage(providerId, model, "generation", result.usage);
      const indexes: number[] = result.data.posts.map(
        (item: GeneratedPosts["posts"][number]) => item.jobIndex,
      );
      const uniqueIndexes = new Set<number>(indexes);
      const complete =
        indexes.length === details.length &&
        uniqueIndexes.size === details.length &&
        details.every((_, index) => uniqueIndexes.has(index));
      if (!complete)
        throw new Error(
          `Generated posts validation failed: expected each jobIndex from 0 to ${details.length - 1} exactly once.`,
        );
      let inserted = 0;
      const insertedIds: string[] = [];
      for (const item of result.data.posts) {
        const detail = details[item.jobIndex];
        if (!detail) continue;
        const prior = await db.getAllAsync<{ text: string }>(
          "SELECT text FROM posts WHERE atom_id=?",
          detail.job.atomId,
        );
        if (prior.some((p) => jaccard(p.text, item.text) > 0.7)) continue;
        const postId = createId("post");
        await db.runAsync(
          "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,quiz_json,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          postId,
          detail.job.subjectId,
          detail.job.atomId,
          detail.job.topicKey,
          detail.job.format,
          detail.job.subjectId,
          item.text.slice(0, 280),
          item.quiz ? JSON.stringify(item.quiz) : null,
          detail.atom.difficulty,
          "unread",
          0,
          Date.now(),
        );
        inserted++;
        insertedIds.push(postId);
      }
      const recent = await db.getAllAsync<{ action: string }>(
        "SELECT i.action FROM interactions i JOIN posts p ON p.id=i.post_id WHERE i.action IN ('quiz_correct','quiz_wrong') ORDER BY i.created_at DESC LIMIT 20",
      );
      let streak = 0;
      for (const row of recent) {
        if (row.action !== "quiz_correct") break;
        streak++;
      }
      if (insertedIds.length && shouldFlagRareCard(streak))
        await db.runAsync(
          "UPDATE posts SET is_rare_card=1 WHERE id=?",
          insertedIds[Math.floor(Math.random() * insertedIds.length)],
        );
      if (inserted >= 8) {
        const subject = details[0].job.subjectId;
        const breaks = [
          "ひと呼吸。いま覚えたことを自分の言葉で言える？",
          "30秒だけ遠くを見て、次の学びへ。",
          "肩を回して小休止。戻ったらクイズを1問。",
        ];
        await db.runAsync(
          "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          createId("break"),
          subject,
          "_entertainment",
          "_entertainment",
          "entertainment",
          "entertainer",
          breaks[Math.floor(Math.random() * breaks.length)],
          0,
          "unread",
          0,
          Date.now(),
        );
      }
      return inserted;
    } catch (error) {
      lastFailure = error;
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && classifyGenerationError(error).code === "validation")
        continue;
      throw error;
    }
  }
  if (lastFailure instanceof Error) throw lastFailure;
  throw new Error(lastError || "Post generation failed.");
}

export async function refillBatch(count: number): Promise<number> {
  const db = await getDb();
  if (await getSetting("monthlyCapEnabled", false)) {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const spent = await db.getFirstAsync<{ total: number }>(
      "SELECT COALESCE(SUM(est_cost_usd),0) total FROM usage_log WHERE created_at>=?",
      start.getTime(),
    );
    if ((spent?.total ?? 0) >= (await getSetting("monthlyCapUsd", 10)))
      return 0;
  }
  // Imported lazily to keep the core dependency one-way.
  const { buildRefillJobs } = await import("../services/refill");
  const jobs = await buildRefillJobs(Math.max(1, Math.min(20, count)));
  const { providerId, model } = await getPurposeRoute("generation");
  return generateBatch(jobs, providerId, model);
}

// Kept as a compatibility entry point for subject creation and older callers.
// The orchestrator owns threshold checks, single-flight and retry state.
export async function refillIfNeeded(): Promise<number> {
  const { requestAutoGeneration } = await import("../services/autogeneration");
  const result = await requestAutoGeneration("legacy");
  return result.inserted;
}
