import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getDb } from "../db/database";
import { importLearningPackage } from "./learning-package";
import { LearningPackageSchema, parseLearningPackage, type LearningPackage } from "./learning-package-schema";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-sqlite", async () => {
  const { openTestDatabase } = await import("../test/sqlite");
  const { db } = openTestDatabase(false);
  return { openDatabaseAsync: async () => db };
});

const sample: LearningPackage = {
  kind: "studytter.learning-package",
  schemaVersion: 1,
  packageId: "81a3992a-24a1-4249-9c5e-46f0454ee74c",
  createdAt: 1000,
  subject: {
    id: "math", displayName: "数学", contentLang: "ja", domainStyle: "problem_solving",
    formatWeights: { quiz: 1, explainer: 1, funfact: 0, misconception: 0, comparison: 0, mnemonic: 0 },
  },
  materials: [{ id: "m1", filename: "数学.pdf", mimeType: "application/pdf", pageCount: 2 }],
  atoms: [{ id: "a1", materialId: "m1", topicLabel: "足し算", kind: "rule", difficulty: 0, core: "1と1を足すと2", note: "基礎", sourceAnchor: "数学.pdf p.1", sourceExcerpt: "1 + 1 = 2" }],
  posts: [{ id: "p1", atomId: "a1", format: "quiz", text: "計算しよう", quiz: { question: "1 + 1?", choices: ["1", "2"], answerIndex: 1, answerText: "2", explanation: "足し算" } }],
};

beforeEach(async () => {
  const db = await getDb();
  await db.execAsync(`
    DROP TRIGGER IF EXISTS fail_package;
    DELETE FROM subjects; DELETE FROM materials; DELETE FROM atoms; DELETE FROM posts;
    DELETE FROM settings; DELETE FROM atom_memory; DELETE FROM interactions;
  `);
  await db.runAsync(
    "INSERT INTO subjects(subject_id,display_name,handle,avatar_seed,content_lang,domain_style,format_weights_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
    "existing", "既存の科目", "@existing", "existing", "ja", "mixed", JSON.stringify(sample.subject.formatWeights), 1,
  );
  await db.execAsync(`
    INSERT INTO settings(key,value_json) VALUES('keep','"yes"');
    INSERT INTO atom_memory(atom_id,review_count) VALUES('old-atom',7);
    INSERT INTO interactions(id,post_id,action,created_at) VALUES('old-ix','old-post','like',1);
  `);
});

describe("portable learning package", () => {
  it("accepts and imports the package exported by the Python companion", async () => {
    const text = readFileSync(new URL("../../companion/sample-package.json", import.meta.url), "utf8");
    const exported = parseLearningPackage(text);
    const result = await importLearningPackage(exported);
    expect(result.alreadyImported).toBe(false);
    expect(await (await getDb()).getFirstAsync("SELECT COUNT(*) count FROM posts")).toEqual({ count: exported.posts.length });
  });
  it("rejects unexpected endpoints, orphan references and invalid quizzes", () => {
    expect(LearningPackageSchema.safeParse({ ...sample, baseUrl: "https://example.com" }).success).toBe(false);
    expect(LearningPackageSchema.safeParse({ ...sample, atoms: [{ ...sample.atoms[0], materialId: "missing" }] }).success).toBe(false);
    expect(LearningPackageSchema.safeParse({ ...sample, posts: [{ ...sample.posts[0], atomId: "missing" }] }).success).toBe(false);
    expect(LearningPackageSchema.safeParse({ ...sample, posts: [{ ...sample.posts[0], quiz: { ...sample.posts[0].quiz, answerIndex: 5 } }] }).success).toBe(false);
    expect(LearningPackageSchema.safeParse({ ...sample, posts: [sample.posts[0], sample.posts[0]] }).success).toBe(false);
    expect(() => parseLearningPackage("not json")).toThrow();
  });

  it("adds a namespaced subject and source excerpts without changing learner data", async () => {
    const result = await importLearningPackage(sample);
    const db = await getDb();
    expect(result).toEqual({ subjectId: `pc_${sample.packageId}`, alreadyImported: false });
    expect(await db.getFirstAsync("SELECT COUNT(*) count FROM subjects")).toEqual({ count: 2 });
    expect(await db.getFirstAsync("SELECT note FROM atoms")).toEqual({ note: "基礎\n\n出典の抜粋:\n1 + 1 = 2" });
    expect(await db.getFirstAsync("SELECT file_uri,status FROM materials")).toEqual({ file_uri: `studytter-package://${sample.packageId}/m1`, status: "done" });
    expect(await db.getFirstAsync("SELECT status,atom_id FROM posts")).toEqual({ status: "unread", atom_id: `${result.subjectId}_atom_a1` });
    expect(await db.getFirstAsync("SELECT value_json FROM settings WHERE key='keep'")).toEqual({ value_json: '"yes"' });
    expect(await db.getFirstAsync("SELECT review_count FROM atom_memory")).toEqual({ review_count: 7 });
    expect(await db.getFirstAsync("SELECT COUNT(*) count FROM interactions")).toEqual({ count: 1 });
  });

  it("imports concurrent copies exactly once and preserves the first imported contents", async () => {
    const results = await Promise.all([importLearningPackage(sample), importLearningPackage(sample)]);
    expect(results.map((result) => result.alreadyImported)).toEqual([false, true]);
    await importLearningPackage({ ...sample, subject: { ...sample.subject, displayName: "Changed" } });
    const db = await getDb();
    expect(await db.getFirstAsync("SELECT COUNT(*) count FROM posts")).toEqual({ count: 1 });
    expect(await db.getFirstAsync("SELECT display_name FROM subjects WHERE subject_id=?", results[0].subjectId)).toEqual({ display_name: "数学" });
  });

  it("rolls back all added rows if any insert fails and permits a later retry", async () => {
    const db = await getDb();
    await db.execAsync("CREATE TRIGGER fail_package BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT,'Disk failure'); END;");
    await expect(importLearningPackage(sample)).rejects.toThrow("Disk failure");
    expect(await db.getFirstAsync("SELECT COUNT(*) count FROM subjects")).toEqual({ count: 1 });
    for (const table of ["materials", "atoms", "posts"])
      expect(await db.getFirstAsync(`SELECT COUNT(*) count FROM ${table}`)).toEqual({ count: 0 });
    expect(await db.getFirstAsync("SELECT review_count FROM atom_memory")).toEqual({ review_count: 7 });
    await db.execAsync("DROP TRIGGER fail_package;");
    expect((await importLearningPackage(sample)).alreadyImported).toBe(false);
  });
});
