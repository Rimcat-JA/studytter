import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDatabase } from "../test/sqlite";
import type { GenerationJob } from "../core/types";

const mocks = vi.hoisted(() => ({ request: vi.fn(), route: vi.fn(), file: "" }));
let fixture: ReturnType<typeof openTestDatabase>;
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: async () => fixture.db }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("./provider", () => ({ createProvider: () => ({ generateJson: mocks.request }) }));
vi.mock("./config", () => ({ getPurposeRoute: mocks.route }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" }, Directory: class {},
  File: class { create() {} write(value: string) { mocks.file = value; } },
}));

const job = (atomId: string): GenerationJob => ({ atomId, subjectId: "s", topicKey: `s:${atomId}`, format: "explainer", reason: "sampled" });
const output = (count = 1) => ({ data: { posts: Array.from({ length: count }, (_, index) => ({ jobIndex: index, text: `Generated explanation ${index}` })) }, usage: { inputTokens: 10, outputTokens: 5 } });
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("generation persistence and restore races", () => {
  let database: typeof import("../db/database");
  let generate: typeof import("./generate");
  beforeEach(async () => {
    vi.resetModules();
    mocks.request.mockReset().mockResolvedValue(output());
    mocks.route.mockReset().mockResolvedValue({ providerId: "openai", model: "test" });
    fixture = openTestDatabase();
    database = await import("../db/database");
    generate = await import("./generate");
    const weights = JSON.stringify({ explainer: 1, quiz: 0, funfact: 0, misconception: 0, comparison: 0, mnemonic: 0 });
    await fixture.db.runAsync("INSERT INTO subjects VALUES('s','Subject','@s','s','ja','mixed',?,1,1)", weights);
    await fixture.db.runAsync("INSERT INTO materials(material_id,subject_id,filename,file_uri,mime_type,status,added_at) VALUES('m','s','source','asset://demo','application/json','done',1)");
    for (const id of ["a", "b"])
      await fixture.db.runAsync("INSERT INTO atoms(atom_id,subject_id,material_id,topic_label,kind,difficulty,core,note,source_anchor,enabled,created_at) VALUES(?,'s','m',?,'fact',0,?,NULL,'p.1',1,1)", id, id, `Core ${id}`);
  });
  afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

  it("rolls back the entire validated batch when its second insert fails", async () => {
    mocks.request.mockResolvedValue(output(2));
    await fixture.db.execAsync("CREATE TRIGGER fail_second BEFORE INSERT ON posts WHEN NEW.atom_id='b' BEGIN SELECT RAISE(ABORT,'injected insert failure'); END;");
    await expect(generate.generateBatch([job("a"), job("b")], "openai", "test")).rejects.toThrow("injected insert failure");
    expect(await fixture.db.getAllAsync("SELECT * FROM posts")).toEqual([]);
    expect(await fixture.db.getAllAsync("SELECT * FROM usage_log")).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(await database.getSetting("autoGenerationState", null)).toBeNull();
  });

  it("commits the daily count with posts and does not count duplicate output twice", async () => {
    await expect(generate.generateBatch([job("a")], "openai", "test")).resolves.toBe(1);
    expect(await database.getSetting("autoGenerationState", {})).toMatchObject({ generatedToday: 1 });
    await expect(generate.generateBatch([job("a")], "openai", "test")).resolves.toBe(0);
    expect(await database.getSetting("autoGenerationState", {})).toMatchObject({ generatedToday: 1 });
  });

  it.each(["UPDATE subjects SET enabled=0", "UPDATE atoms SET enabled=0", "DELETE FROM atoms"])("rechecks current source availability after the network request: %s", async (sql) => {
    const started = latch(); const resume = latch();
    mocks.request.mockImplementation(async () => { started.release(); await resume.promise; return output(); });
    const request = generate.generateBatch([job("a")], "openai", "test");
    await started.promise;
    await fixture.db.execAsync(sql);
    resume.release();
    await expect(request).resolves.toBe(0);
    expect(await fixture.db.getAllAsync("SELECT * FROM posts")).toEqual([]);
  });

  it("rejects an old network response after restore before usage or posts are written", async () => {
    const started = latch(); const resume = latch();
    mocks.request.mockImplementation(async () => { started.release(); await resume.promise; return output(); });
    const request = generate.generateBatch([job("a")], "openai", "test");
    const rejected = expect(request).rejects.toBeInstanceOf(database.DatabaseReplacedError);
    await started.promise;
    await database.withDatabaseRestore(async (db) => { await db.runAsync("DELETE FROM posts"); });
    resume.release();
    await rejected;
    expect(await fixture.db.getAllAsync("SELECT * FROM posts")).toEqual([]);
    expect(await fixture.db.getAllAsync("SELECT * FROM usage_log")).toEqual([]);
  });

  it("keeps the original generation token when refill routing resumes after restore", async () => {
    const started = latch(); const resume = latch();
    mocks.route.mockImplementation(async () => { started.release(); await resume.promise; return { providerId: "openai", model: "test" }; });
    const request = generate.refillBatch(1, "s");
    const rejected = expect(request).rejects.toBeInstanceOf(database.DatabaseReplacedError);
    await started.promise;
    await database.withDatabaseRestore(async (db) => { await db.runAsync("UPDATE atoms SET core='Restored source'"); });
    resume.release();
    await rejected;
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not reacquire a fresh database for usage after a restore between price reads and insertion", async () => {
    const started = latch(); const resume = latch();
    const original = database.getSetting;
    vi.spyOn(database, "getSetting").mockImplementation(async (key, fallback, generation) => {
      const value = await original(key, fallback, generation);
      started.release(); await resume.promise;
      return value;
    });
    const { logUsage } = await import("./usage");
    const request = logUsage("openai", "test", "generation", { inputTokens: 2, outputTokens: 2 });
    const rejected = expect(request).rejects.toBeInstanceOf(database.DatabaseReplacedError);
    await started.promise;
    await database.withDatabaseRestore(async () => {});
    resume.release();
    await rejected;
    expect(await fixture.db.getAllAsync("SELECT * FROM usage_log")).toEqual([]);
  });

  it("resets restored runtime state and prevents an old orchestrator from overwriting it", async () => {
    const started = latch(); const resume = latch();
    const { createExportFile, restoreData } = await import("../services/data");
    const { requestAutoGeneration } = await import("../services/autogeneration");
    await database.setSetting("autoGenerationSettings", { batchSize: 1 });
    await database.setSetting("autoGenerationState", { phase: "idle", generatedToday: 9, generatedDay: new Date().toLocaleDateString("sv-SE") });
    await createExportFile();
    const backup = JSON.parse(mocks.file);
    mocks.request.mockImplementation(async () => { started.release(); await resume.promise; return output(); });
    const request = requestAutoGeneration("manual", { force: true, subjectId: "s" });
    await started.promise;
    expect(await database.getSetting("autoGenerationState", {})).toMatchObject({ phase: "running" });
    await restoreData(backup);
    resume.release();
    await expect(request).resolves.toMatchObject({ status: "skipped", inserted: 0 });
    expect(await database.getSetting("autoGenerationState", {})).toMatchObject({ phase: "idle", generatedToday: 9, refillPending: false });
    expect(await fixture.db.getFirstAsync("SELECT lease_token FROM generation_runtime")).toEqual({ lease_token: null });
    expect(await fixture.db.getAllAsync("SELECT * FROM posts")).toEqual([]);
    expect(await fixture.db.getAllAsync("SELECT * FROM usage_log")).toEqual([]);
  });
});
