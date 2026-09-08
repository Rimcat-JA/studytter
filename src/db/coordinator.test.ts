import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseCoordinator, DatabaseReplacedError } from "./coordinator";
import { openTestDatabase } from "../test/sqlite";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("database transaction isolation", () => {
  let fixture: ReturnType<typeof openTestDatabase>;
  let coordinator: DatabaseCoordinator;
  beforeEach(() => {
    fixture = openTestDatabase();
    coordinator = new DatabaseCoordinator(async () => fixture.db);
  });
  afterEach(() => fixture.close());

  it("does not absorb unrelated writes into a transaction that rolls back", async () => {
    const db = await coordinator.getDb();
    const started = latch();
    const resume = latch();
    const transaction = coordinator.transaction(async (tx) => {
      await tx.runAsync("INSERT INTO settings VALUES('transaction','1')");
      started.release();
      await resume.promise;
      throw new Error("injected failure");
    });
    const rejected = expect(transaction).rejects.toThrow("injected failure");
    await started.promise;
    const outsideWrite = db.runAsync("INSERT INTO settings VALUES('outside','2')");
    const outsideRead = db.getAllAsync("SELECT * FROM settings ORDER BY key");
    resume.release();
    await rejected;
    await outsideWrite;
    expect(await outsideRead).toEqual([{ key: "outside", value_json: "2" }]);
  });

  it("invalidates old network-worker handles and waits for the running transaction before restore", async () => {
    const old = await coordinator.getDb();
    const generation = coordinator.captureGeneration();
    const started = latch();
    const resume = latch();
    const transaction = coordinator.transaction(async (tx) => {
      await tx.runAsync("INSERT INTO settings VALUES('before','1')");
      started.release();
      await resume.promise;
    });
    await started.promise;
    const queued = old.runAsync("INSERT INTO settings VALUES('stale','1')");
    const queuedRejected = expect(queued).rejects.toBeInstanceOf(DatabaseReplacedError);
    const restore = coordinator.restore(async (tx) => {
      await tx.runAsync("DELETE FROM settings");
      await tx.runAsync("INSERT INTO settings VALUES('restored','2')");
    });
    await expect(coordinator.getDb()).rejects.toBeInstanceOf(DatabaseReplacedError);
    resume.release();
    await transaction;
    await queuedRejected;
    await restore;
    await expect(old.runAsync("INSERT INTO settings VALUES('late-network','3')")).rejects.toBeInstanceOf(DatabaseReplacedError);
    expect(() => coordinator.assertGeneration(generation)).toThrow(DatabaseReplacedError);
    const current = await coordinator.getDb();
    expect(await current.getAllAsync("SELECT * FROM settings")).toEqual([{ key: "restored", value_json: "2" }]);
  });

  it("rolls back a failed restore and permits new operations afterward", async () => {
    const old = await coordinator.getDb();
    await old.runAsync("INSERT INTO settings VALUES('original','true')");
    await expect(coordinator.restore(async (tx) => {
      await tx.runAsync("DELETE FROM settings");
      await tx.runAsync("INSERT INTO table_that_does_not_exist VALUES(1)");
    })).rejects.toThrow();
    const db = await coordinator.getDb();
    expect(await db.getAllAsync("SELECT * FROM settings")).toEqual([{ key: "original", value_json: "true" }]);
    await expect(coordinator.transaction(async (tx) => {
      await tx.runAsync("UPDATE settings SET value_json='false'");
      return 7;
    })).resolves.toBe(7);
  });
});
