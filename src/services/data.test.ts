import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCoordinator, DatabaseReplacedError } from "../db/coordinator";
import { openTestDatabase } from "../test/sqlite";
import { createExportFile, restoreData } from "./data";
import { ImportSchema } from "../llm/schemas";

let coordinator: DatabaseCoordinator;
const fileState = vi.hoisted(() => ({ contents: "" }));
vi.mock("../db/database", () => ({
  withDbTransaction: (work: Parameters<DatabaseCoordinator["transaction"]>[0]) => coordinator.transaction(work),
  withDatabaseRestore: (work: Parameters<DatabaseCoordinator["restore"]>[0]) => coordinator.restore(work),
}));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  Directory: class {},
  File: class {
    uri = "memory://backup.json";
    create() {}
    write(value: string) { fileState.contents = value; }
  },
}));

function backup() {
  return {
    schemaVersion: 2, exportedAt: 100, originalFilesIncluded: false,
    subjects: [{ subject_id: "s", display_name: "Math", handle: "@math", avatar_seed: "math", content_lang: "ja", domain_style: "mixed", format_weights_json: JSON.stringify({ explainer: 1, quiz: 1, funfact: 0, misconception: 0, comparison: 0, mnemonic: 0 }), enabled: 1, created_at: 1 }],
    materials: [{ material_id: "m", subject_id: "s", filename: "math.pdf", file_uri: "file:///untrusted/local-file.pdf", mime_type: "application/pdf", page_count: 2, page_start: 1, page_end: 2, status: "done", error_message: null, added_at: 1 }],
    atoms: [{ atom_id: "a", subject_id: "s", material_id: "m", topic_label: "Addition", kind: "fact", difficulty: 0, core: "1+1=2", note: null, source_anchor: "p.1", enabled: 1, created_at: 1 }],
    posts: [{ id: "p", subject_id: "s", atom_id: "a", topic_key: "s:Addition", format: "quiz", persona_id: "s", text: "1+1?", quiz_json: JSON.stringify({ question: "1+1?", choices: ["1", "2"], answerIndex: 1, answerText: "2", explanation: "Addition" }), difficulty_b: 3.1, status: "consumed", is_rare_card: 0, created_at: 1 }],
    interactions: [{ id: "i", post_id: "p", action: "quiz_correct", dwell_ms: null, created_at: 3 }],
    quizAttempts: [{ id: "q", post_id: "p", session_key: "initial:p", answer_index: 1, correct: 1, created_at: 3, next_review_at: 50 }],
    banditArms: [], atomMemory: [{ atom_id: "a", stability_days: 2, last_reviewed_at: 3, review_count: 1, lapse_count: 0 }],
    userTopicState: [], streakState: [], xpEvents: [], deepdives: [{ post_id: "p", thread_json: JSON.stringify([{ role: "assistant", text: "Explanation" }]), created_at: 5 }],
    settings: [{ key: "llm.provider.openai.baseUrl", value_json: JSON.stringify("https://untrusted.example/v1") }], usageLog: [],
  };
}

describe("validated backup restore", () => {
  let fixture: ReturnType<typeof openTestDatabase>;
  beforeEach(async () => {
    fixture = openTestDatabase();
    coordinator = new DatabaseCoordinator(async () => fixture.db);
    await fixture.db.runAsync("INSERT INTO settings VALUES('llm.provider.openai.baseUrl','\"https://api.openai.com/v1\"')");
    await fixture.db.runAsync("INSERT INTO settings VALUES('onboardingComplete','true')");
  });
  afterEach(() => fixture.close());

  it("restores complete learning state while preserving local settings and invalidating workers", async () => {
    const old = await coordinator.getDb();
    await restoreData(backup());
    expect(await fixture.db.getAllAsync("SELECT * FROM quiz_attempts")).toMatchObject([{ id: "q", session_key: "initial:p" }]);
    expect(await fixture.db.getFirstAsync("SELECT * FROM atom_memory")).toMatchObject({ review_count: 1, stability_days: 2 });
    expect(await fixture.db.getFirstAsync("SELECT * FROM streak_state")).toMatchObject({ id: 1 });
    expect(await fixture.db.getFirstAsync("SELECT * FROM settings WHERE key='llm.provider.openai.baseUrl'"))
      .toMatchObject({ value_json: '"https://api.openai.com/v1"' });
    expect(await fixture.db.getFirstAsync("SELECT file_uri,status FROM materials")).toEqual({ file_uri: "", status: "failed" });
    await expect(old.runAsync("INSERT INTO interactions VALUES('old','p','like',NULL,6)")).rejects.toBeInstanceOf(DatabaseReplacedError);
  });

  it.each([
    ["unknown SQL column", (data: ReturnType<typeof backup>) => Object.assign(data.subjects[0], { injected_column: "x" })],
    ["invalid weight JSON", (data: ReturnType<typeof backup>) => { data.subjects[0].format_weights_json = '{"quiz":"bad"}'; }],
    ["unknown material owner", (data: ReturnType<typeof backup>) => { data.materials[0].subject_id = "missing"; }],
    ["mismatched atom owner", (data: ReturnType<typeof backup>) => { data.atoms[0].material_id = "missing"; }],
    ["missing post reference", (data: ReturnType<typeof backup>) => { data.interactions[0].post_id = "missing"; }],
    ["invalid deep-dive JSON", (data: ReturnType<typeof backup>) => { data.deepdives[0].thread_json = '{"messages":"bad"}'; }],
    ["out of range answer", (data: ReturnType<typeof backup>) => { data.quizAttempts[0].answer_index = 3; }],
    ["duplicate record", (data: ReturnType<typeof backup>) => { data.subjects.push({ ...data.subjects[0] }); }],
  ])("rejects %s before any existing data is changed", async (_name, mutate) => {
    const input = backup();
    mutate(input);
    const old = await coordinator.getDb();
    await expect(restoreData(input)).rejects.toThrow();
    expect(await old.getAllAsync("SELECT key FROM settings ORDER BY key")).toHaveLength(2);
    expect(await fixture.db.getAllAsync("SELECT * FROM subjects")).toEqual([]);
  });

  it("rolls back every table, job and lease when an insert fails after deletion", async () => {
    await restoreData(backup());
    await fixture.db.runAsync("UPDATE subjects SET display_name='Original'");
    await fixture.db.runAsync("INSERT INTO extraction_jobs(job_id,subject_id,status,trigger,created_at,updated_at) VALUES('job','s','queued','startup',1,1)");
    await fixture.db.runAsync("UPDATE generation_runtime SET lease_token='old',lease_expires_at=99");
    await fixture.db.execAsync("CREATE TRIGGER fail_import BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT,'injected restore failure'); END;");
    await expect(restoreData(backup())).rejects.toThrow("injected restore failure");
    expect(await fixture.db.getFirstAsync("SELECT display_name FROM subjects")).toEqual({ display_name: "Original" });
    expect(await fixture.db.getAllAsync("SELECT * FROM posts")).toHaveLength(1);
    expect(await fixture.db.getAllAsync("SELECT * FROM quiz_attempts")).toHaveLength(1);
    expect(await fixture.db.getAllAsync("SELECT * FROM extraction_jobs")).toHaveLength(1);
    expect(await fixture.db.getFirstAsync("SELECT lease_token FROM generation_runtime")).toEqual({ lease_token: "old" });
  });

  it("exports a valid coherent backup without device settings and accepts legacy backups without attempts", async () => {
    const legacy = backup();
    Reflect.deleteProperty(legacy, "quizAttempts");
    expect(ImportSchema.parse(legacy).quizAttempts).toEqual([]);
    await restoreData(backup());
    await createExportFile();
    const exported = ImportSchema.parse(JSON.parse(fileState.contents));
    expect(exported.settings).toEqual([]);
    expect(exported.quizAttempts).toHaveLength(1);
    await restoreData(exported);
    expect(await fixture.db.getAllAsync("SELECT * FROM quiz_attempts")).toHaveLength(1);
    expect(await fixture.db.getAllAsync("SELECT * FROM extraction_jobs")).toEqual([]);
  });

  it.each(["not JSON", "null", "[]"])("safely rejects malformed quiz JSON referenced by an answer: %s", (raw) => {
    const input = backup();
    input.posts[0].quiz_json = raw;
    expect(ImportSchema.safeParse(input).success).toBe(false);
  });
});
