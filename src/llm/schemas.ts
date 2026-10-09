import { z } from "zod";
import { createImportSchema } from "../services/backup-schema";

export const ContentLangSchema = z.enum(["ja", "en", "zh-Hans"]);
export const AtomKindSchema = z.enum([
  "definition",
  "rule",
  "theorem",
  "technique",
  "term",
  "example",
  "fact",
  "misconception",
]);
export const LearningFormatSchema = z.enum([
  "explainer",
  "quiz",
  "funfact",
  "misconception",
  "comparison",
  "mnemonic",
]);

export const ExtractionChunkSchema = z.object({
  schemaVersion: z.literal(2),
  topics: z.array(
    z.object({ label: z.string().min(1), order: z.number().int() }),
  ),
  atoms: z
    .array(
      z.object({
        topicLabel: z.string().min(1),
        kind: AtomKindSchema,
        difficulty: z.number().min(-3).max(3),
        core: z.string().min(1).max(500),
        note: z.string().optional(),
        sourceAnchor: z.string().min(1),
      }),
    )
    .max(60),
  profile: z
    .object({
      domainStyle: z.enum(["problem_solving", "memorization", "mixed"]),
      // Explicit keys instead of z.record: provider JSON-schema validators
      // reject `propertyNames` objects that have no `properties`.
      formatWeights: z.object({
        explainer: z.number().nonnegative(),
        quiz: z.number().nonnegative(),
        funfact: z.number().nonnegative(),
        misconception: z.number().nonnegative(),
        comparison: z.number().nonnegative(),
        mnemonic: z.number().nonnegative(),
      }),
      contentLang: ContentLangSchema,
      suggestedHandle: z.string().min(1),
      suggestedDisplayName: z.string().min(1),
    })
    .optional(),
});

export type ExtractionChunk = z.infer<typeof ExtractionChunkSchema>;

export const QuizSchema = z.object({
  question: z.string().trim().min(1),
  choices: z.array(z.string().trim().min(1)).min(2).max(6).optional(),
  answerIndex: z.number().int().nonnegative().optional(),
  answerText: z.string().trim().min(1),
  explanation: z.string().trim().min(1),
}).superRefine((quiz, context) => {
  if (quiz.choices) {
    if (quiz.answerIndex === undefined || quiz.answerIndex >= quiz.choices.length)
      context.addIssue({ code: "custom", path: ["answerIndex"], message: "Quiz validation: answerIndex must identify an existing choice." });
    if (new Set(quiz.choices.map((choice) => choice.toLocaleLowerCase())).size !== quiz.choices.length)
      context.addIssue({ code: "custom", path: ["choices"], message: "Quiz validation: choices must be distinct." });
  } else if (quiz.answerIndex !== undefined) {
    context.addIssue({ code: "custom", path: ["answerIndex"], message: "Quiz validation: answerIndex requires choices." });
  }
});
export const GeneratedPostsSchema = z.object({
  posts: z
    .array(
      z.object({
        jobIndex: z.number().int().nonnegative(),
        text: z.string().min(1).max(320),
        quiz: QuizSchema.optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type GeneratedPosts = z.infer<typeof GeneratedPostsSchema>;

/** Validate the whole reply before any post is written to the database. */
export function validateGeneratedPosts(data: unknown, formats: readonly string[]): GeneratedPosts {
  const parsed = GeneratedPostsSchema.parse(data);
  const indexes = new Set(parsed.posts.map((post) => post.jobIndex));
  if (parsed.posts.length !== formats.length || indexes.size !== formats.length || formats.some((_, index) => !indexes.has(index)))
    throw new Error("Generated posts validation failed: each jobIndex must occur exactly once.");
  for (const post of parsed.posts) {
    if (formats[post.jobIndex] === "quiz" && !post.quiz)
      throw new Error(`Generated posts validation failed: quiz is required for jobIndex ${post.jobIndex}.`);
    // Models without strict schemas often attach a quiz to every post; keep
    // the post and drop the quiz instead of rejecting the whole batch.
    if (formats[post.jobIndex] !== "quiz" && post.quiz) delete post.quiz;
  }
  return parsed;
}

export const ImportSchema = createImportSchema(QuizSchema);
