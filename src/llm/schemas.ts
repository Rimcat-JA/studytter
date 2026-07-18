import { z } from "zod";

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
      formatWeights: z.record(LearningFormatSchema, z.number().nonnegative()),
      contentLang: ContentLangSchema,
      suggestedHandle: z.string().min(1),
      suggestedDisplayName: z.string().min(1),
    })
    .optional(),
});

export type ExtractionChunk = z.infer<typeof ExtractionChunkSchema>;

const QuizSchema = z.object({
  question: z.string(),
  choices: z.array(z.string()).min(2).max(6).optional(),
  answerIndex: z.number().int().nonnegative().optional(),
  answerText: z.string(),
  explanation: z.string(),
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

export const ImportSchema = z.object({
  schemaVersion: z.literal(2),
  exportedAt: z.number(),
  subjects: z.array(z.record(z.string(), z.unknown())),
  materials: z.array(z.record(z.string(), z.unknown())),
  atoms: z.array(z.record(z.string(), z.unknown())),
  posts: z.array(z.record(z.string(), z.unknown())),
  interactions: z.array(z.record(z.string(), z.unknown())),
  banditArms: z.array(z.record(z.string(), z.unknown())),
  atomMemory: z.array(z.record(z.string(), z.unknown())),
  userTopicState: z.array(z.record(z.string(), z.unknown())),
  streakState: z.array(z.record(z.string(), z.unknown())),
  xpEvents: z.array(z.record(z.string(), z.unknown())),
  deepdives: z.array(z.record(z.string(), z.unknown())),
  settings: z.array(z.record(z.string(), z.unknown())),
  usageLog: z.array(z.record(z.string(), z.unknown())),
  originalFilesIncluded: z.literal(false),
});
