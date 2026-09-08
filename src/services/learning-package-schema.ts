import { z } from "zod";
import { AtomKindSchema, ContentLangSchema, LearningFormatSchema, QuizSchema } from "../llm/schemas";

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Label = z.string().trim().min(1).max(300);
const MaterialSchema = z.object({
  id: Identifier,
  filename: Label,
  mimeType: z.string().min(1).max(100),
  pageCount: z.number().int().positive().max(100_000).optional(),
}).strict();
const AtomSchema = z.object({
  id: Identifier,
  materialId: Identifier,
  topicLabel: Label,
  kind: AtomKindSchema,
  difficulty: z.number().finite().min(-3).max(3),
  core: z.string().trim().min(1).max(500),
  note: z.string().max(2000).optional(),
  sourceAnchor: z.string().trim().min(1).max(500),
  sourceExcerpt: z.string().max(2000).optional(),
}).strict();
const PostSchema = z.object({
  id: Identifier,
  atomId: Identifier,
  format: LearningFormatSchema,
  text: z.string().trim().min(1).max(2000),
  quiz: QuizSchema.optional(),
  difficulty: z.number().finite().min(-3).max(3).optional(),
}).strict().superRefine((post, context) => {
  if (post.format === "quiz" && !post.quiz)
    context.addIssue({ code: "custom", path: ["quiz"], message: "クイズには問題と解答が必要です。" });
  if (post.format !== "quiz" && post.quiz)
    context.addIssue({ code: "custom", path: ["quiz"], message: "クイズ以外の投稿にはクイズを指定できません。" });
});

/** A portable, additive exchange format. Contains no credentials or endpoints. */
export const LearningPackageSchema = z.object({
  kind: z.literal("studytter.learning-package"),
  schemaVersion: z.literal(1),
  packageId: z.uuid(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  subject: z.object({
    id: Identifier,
    displayName: Label,
    contentLang: ContentLangSchema,
    domainStyle: z.enum(["problem_solving", "memorization", "mixed"]),
    formatWeights: z.record(LearningFormatSchema, z.number().finite().nonnegative().max(1000))
      .refine((weights) => Object.values(weights).some((weight) => weight > 0), "形式の重みが必要です。"),
  }).strict(),
  materials: z.array(MaterialSchema).min(1).max(500),
  atoms: z.array(AtomSchema).min(1).max(10_000),
  posts: z.array(PostSchema).min(1).max(20_000),
}).strict().superRefine((data, context) => {
  const ids = (rows: {id: string}[], name: string) => {
    const result = new Set<string>();
    rows.forEach((row, index) => {
      if (result.has(row.id)) context.addIssue({ code: "custom", path: [name, index, "id"], message: "IDが重複しています。" });
      result.add(row.id);
    });
    return result;
  };
  const materials = ids(data.materials, "materials");
  const atoms = ids(data.atoms, "atoms");
  ids(data.posts, "posts");
  data.atoms.forEach((atom, index) => {
    if (!materials.has(atom.materialId)) context.addIssue({ code: "custom", path: ["atoms", index, "materialId"], message: "参照する教材がありません。" });
  });
  data.posts.forEach((post, index) => {
    if (!atoms.has(post.atomId)) context.addIssue({ code: "custom", path: ["posts", index, "atomId"], message: "参照する知識がありません。" });
  });
});

export type LearningPackage = z.infer<typeof LearningPackageSchema>;
export const MAX_LEARNING_PACKAGE_BYTES = 25 * 1024 * 1024;

export function parseLearningPackage(text: string): LearningPackage {
  if (new TextEncoder().encode(text).byteLength > MAX_LEARNING_PACKAGE_BYTES)
    throw new Error("学習パッケージは25MB以下にしてください。");
  return LearningPackageSchema.parse(JSON.parse(text));
}
