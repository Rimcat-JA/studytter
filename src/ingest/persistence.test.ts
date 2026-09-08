import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDatabase } from "../test/sqlite";

let fixture: ReturnType<typeof openTestDatabase>;
const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: async () => fixture.db }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" }, File: class {}, Directory: class { exists = false; },
}));
vi.mock("../llm/config", () => ({ getPurposeRoute: async () => ({ providerId: "openai", model: "test" }) }));
vi.mock("../llm/extract", () => ({ extractMaterialChunk: mocks.extract, jaccard: () => 0, mergeExtractionChunks: () => ({}) }));

const result = () => ({
  schemaVersion: 2, topics: [{ label: "Math", order: 0 }],
  atoms: ["first", "second"].map((core) => ({ topicLabel: "Math", kind: "fact", difficulty: 0, core, sourceAnchor: "p.1" })),
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("extraction chunk persistence", () => {
  let database: typeof import("../db/database");
  let ingest: typeof import("./index");
  beforeEach(async () => {
    vi.resetModules();
    fixture = openTestDatabase();
    mocks.extract.mockReset().mockResolvedValue(result());
    database = await import("../db/database");
    ingest = await import("./index");
    await fixture.db.runAsync("INSERT INTO subjects VALUES('s','Subject','@s','s','ja','mixed','{}',1,1)");
    await fixture.db.runAsync("INSERT INTO materials(material_id,subject_id,filename,file_uri,mime_type,status,added_at) VALUES('m','s','image.png','local://image','image/png','pending',1)");
  });
  afterEach(() => fixture.close());

  it("rolls back the chunk's atoms and memory together on a mid-insert error", async () => {
    await fixture.db.execAsync("CREATE TRIGGER fail_second BEFORE INSERT ON atoms WHEN NEW.core='second' BEGIN SELECT RAISE(ABORT,'injected extraction failure'); END;");
    await expect(ingest.extractSubject("s")).rejects.toThrow("injected extraction failure");
    expect(await fixture.db.getAllAsync("SELECT * FROM atoms")).toEqual([]);
    expect(await fixture.db.getAllAsync("SELECT * FROM atom_memory")).toEqual([]);
    expect(await fixture.db.getFirstAsync("SELECT status FROM materials")).toEqual({ status: "failed" });
  });

  it("does not recreate orphaned atoms when the material is removed during extraction", async () => {
    const started = latch(); const resume = latch();
    mocks.extract.mockImplementation(async () => { started.release(); await resume.promise; return result(); });
    const extraction = ingest.extractSubject("s");
    const rejected = expect(extraction).rejects.toThrow(/教材または科目/);
    await started.promise;
    await fixture.db.runAsync("DELETE FROM materials");
    resume.release();
    await rejected;
    expect(await fixture.db.getAllAsync("SELECT * FROM atoms")).toEqual([]);
  });

  it("does not add an old chunk to matching subject IDs after restore", async () => {
    const started = latch(); const resume = latch();
    mocks.extract.mockImplementation(async () => { started.release(); await resume.promise; return result(); });
    const extraction = ingest.extractSubject("s");
    const rejected = expect(extraction).rejects.toBeInstanceOf(database.DatabaseReplacedError);
    await started.promise;
    await database.withDatabaseRestore(async (db) => { await db.runAsync("UPDATE materials SET status='done'"); });
    resume.release();
    await rejected;
    expect(await fixture.db.getAllAsync("SELECT * FROM atoms")).toEqual([]);
    expect(await fixture.db.getFirstAsync("SELECT status FROM materials")).toEqual({ status: "done" });
  });
});
