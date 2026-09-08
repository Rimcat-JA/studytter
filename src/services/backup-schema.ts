import { z } from "zod";
import { parseDeepDiveThread } from "./deepdive-thread";

const id = z.string().min(1).max(500);
const text = z.string();
const timestamp = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const flag = z.union([z.literal(0), z.literal(1)]);
const format = z.enum(["explainer", "quiz", "funfact", "misconception", "comparison", "mnemonic", "entertainment"]);
const json = (validate: (value: unknown) => boolean = () => true) => z.string().refine((raw) => {
  try { return validate(JSON.parse(raw)); } catch { return false; }
}, "Invalid JSON data");
const weights = z.record(z.enum(["explainer", "quiz", "funfact", "misconception", "comparison", "mnemonic"]), z.number().finite().nonnegative())
  .refine((value) => Object.values(value).some((weight) => weight > 0), "Format weights must contain a positive value");

/** Kept separate from the LLM schema implementation; the same quiz validator
 * is injected so generated and restored questions enforce identical rules. */
export function createImportSchema(quizSchema: z.ZodType) {
  return z.object({
    schemaVersion: z.literal(2),
    exportedAt: timestamp,
    originalFilesIncluded: z.literal(false),
    subjects: z.array(z.object({
      subject_id: id, display_name: id, handle: id, avatar_seed: id,
      content_lang: z.enum(["ja", "en", "zh-Hans"]),
      domain_style: z.enum(["problem_solving", "memorization", "mixed"]),
      format_weights_json: json((value) => weights.safeParse(value).success),
      enabled: flag, created_at: timestamp,
    }).strict()),
    materials: z.array(z.object({
      material_id: id, subject_id: id, filename: id, file_uri: text, mime_type: id,
      page_count: count.nullable(), page_start: count.nullable(), page_end: count.nullable(),
      status: z.enum(["pending", "extracting", "done", "failed", "replaced"]),
      error_message: text.nullable(), added_at: timestamp,
    }).strict().refine((row) =>
      (row.page_start === null || row.page_start >= 1) &&
      (row.page_end === null || row.page_end >= 1) &&
      (row.page_start === null || row.page_end === null || row.page_start <= row.page_end) &&
      (row.page_count === null || row.page_end === null || row.page_end <= row.page_count),
    "Invalid material page range")),
    atoms: z.array(z.object({
      atom_id: id, subject_id: id, material_id: id, topic_label: id,
      kind: z.enum(["definition", "rule", "theorem", "technique", "term", "example", "fact", "misconception"]),
      difficulty: z.number().finite().min(-3).max(3), core: text.min(1), note: text.nullable(),
      source_anchor: id, enabled: flag, created_at: timestamp,
    }).strict()),
    posts: z.array(z.object({
      id, subject_id: id, atom_id: id, topic_key: id, format, persona_id: id,
      text: text.min(1), quiz_json: json((value) => quizSchema.safeParse(value).success).nullable(),
      difficulty_b: z.number().finite(),
      status: z.enum(["unread", "served", "consumed", "discarded"]),
      is_rare_card: flag, created_at: timestamp,
    }).strict().refine((row) => (row.format === "quiz") === (row.quiz_json !== null), "Quiz content must match the post format")),
    interactions: z.array(z.object({
      id, post_id: id,
      action: z.enum(["like", "unlike", "save", "unsave", "expand", "quiz_correct", "quiz_wrong", "reveal", "impression", "skip"]),
      dwell_ms: count.nullable(), created_at: timestamp,
    }).strict()),
    quizAttempts: z.array(z.object({
      id, post_id: id, session_key: id, answer_index: count.nullable(), correct: flag,
      created_at: timestamp, next_review_at: timestamp,
    }).strict().refine((row) => row.next_review_at >= row.created_at, "Review date precedes the answer")).default([]),
    banditArms: z.array(z.object({ topic_key: id, format, alpha: z.number().finite().positive(), beta: z.number().finite().positive() }).strict()),
    atomMemory: z.array(z.object({ atom_id: id, stability_days: z.number().finite().positive(), last_reviewed_at: timestamp.nullable(), review_count: count, lapse_count: count }).strict()
      .refine((row) => row.lapse_count <= row.review_count, "Lapses exceed review count")),
    userTopicState: z.array(z.object({ topic_key: id, theta: z.number().finite(), attempts: count }).strict()),
    streakState: z.array(z.object({ id: z.literal(1), current_streak: count, longest_streak: count, last_active_date: text.regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), freezes_owned: count }).strict()).max(1),
    xpEvents: z.array(z.object({ id, amount: count, reason: id, created_at: timestamp }).strict()),
    deepdives: z.array(z.object({ post_id: id, thread_json: z.string().min(1).refine((raw) => {
      const parsed = parseDeepDiveThread(raw);
      return !parsed.invalid && new Set(parsed.thread.messages.map((message) => message.id)).size === parsed.thread.messages.length;
    }, "Invalid deep-dive thread"), created_at: timestamp }).strict()),
    settings: z.array(z.object({ key: id, value_json: json() }).strict()),
    usageLog: z.array(z.object({ id, created_at: timestamp, provider_id: id, model_id: id, purpose: z.enum(["extraction", "generation", "deepdive"]), input_tokens: count, output_tokens: count, est_cost_usd: z.number().finite().nonnegative() }).strict()),
  }).strict().superRefine((data, ctx) => {
    const error = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const unique = <T>(rows: T[], key: (row: T) => string, name: string) => {
      const seen = new Set<string>();
      rows.forEach((row, index) => {
        const value = key(row);
        if (seen.has(value)) error([name, index], "Duplicate record identifier");
        seen.add(value);
      });
    };
    unique(data.subjects, (row) => row.subject_id, "subjects");
    unique(data.materials, (row) => row.material_id, "materials");
    unique(data.atoms, (row) => row.atom_id, "atoms");
    unique(data.posts, (row) => row.id, "posts");
    unique(data.interactions, (row) => row.id, "interactions");
    unique(data.quizAttempts, (row) => row.id, "quizAttempts");
    unique(data.quizAttempts, (row) => JSON.stringify([row.post_id, row.session_key]), "quizAttempts");
    unique(data.banditArms, (row) => JSON.stringify([row.topic_key, row.format]), "banditArms");
    unique(data.atomMemory, (row) => row.atom_id, "atomMemory");
    unique(data.userTopicState, (row) => row.topic_key, "userTopicState");
    unique(data.xpEvents, (row) => row.id, "xpEvents");
    unique(data.deepdives, (row) => row.post_id, "deepdives");
    unique(data.settings, (row) => row.key, "settings");
    unique(data.usageLog, (row) => row.id, "usageLog");
    const subjects = new Set(data.subjects.map((row) => row.subject_id));
    const materials = new Map(data.materials.map((row) => [row.material_id, row]));
    const atoms = new Map(data.atoms.map((row) => [row.atom_id, row]));
    const posts = new Map(data.posts.map((row) => [row.id, row]));
    data.materials.forEach((row, index) => {
      if (!subjects.has(row.subject_id)) error(["materials", index, "subject_id"], "Missing subject");
    });
    data.atoms.forEach((row, index) => {
      if (!subjects.has(row.subject_id) || materials.get(row.material_id)?.subject_id !== row.subject_id)
        error(["atoms", index], "Missing or mismatched subject/material");
    });
    data.posts.forEach((row, index) => {
      if (!subjects.has(row.subject_id)) error(["posts", index, "subject_id"], "Missing subject");
      if (row.format === "entertainment" ? row.atom_id !== "_entertainment" : atoms.get(row.atom_id)?.subject_id !== row.subject_id)
        error(["posts", index, "atom_id"], "Missing or mismatched atom");
    });
    data.interactions.forEach((row, index) => {
      if (!posts.has(row.post_id)) error(["interactions", index, "post_id"], "Missing post");
    });
    data.deepdives.forEach((row, index) => {
      if (!posts.has(row.post_id)) error(["deepdives", index, "post_id"], "Missing post");
    });
    data.atomMemory.forEach((row, index) => {
      if (!atoms.has(row.atom_id)) error(["atomMemory", index, "atom_id"], "Missing atom");
    });
    data.quizAttempts.forEach((row, index) => {
      const post = posts.get(row.post_id);
      if (post?.format !== "quiz" || !post.quiz_json) {
        error(["quizAttempts", index, "post_id"], "Missing quiz post"); return;
      }
      let quiz: { choices?: string[]; answerIndex?: number };
      try {
        const parsed: unknown = JSON.parse(post.quiz_json);
        if (!quizSchema.safeParse(parsed).success) return;
        quiz = parsed as typeof quiz;
      } catch {
        // The post's JSON refinement already reports the invalid field. Keep
        // safeParse safe even when an attempt points at malformed quiz JSON.
        return;
      }
      if (quiz.choices ? row.answer_index === null || row.answer_index >= quiz.choices.length || row.correct !== Number(row.answer_index === quiz.answerIndex) : row.answer_index !== null)
        error(["quizAttempts", index, "answer_index"], "Answer does not match quiz");
    });
  });
}
