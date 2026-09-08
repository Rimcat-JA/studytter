import type { SQLiteDatabase } from "expo-sqlite";

export class DatabaseReplacedError extends Error {
  constructor() {
    super("バックアップの復元により実行中の処理を中止しました。もう一度お試しください。");
    this.name = "DatabaseReplacedError";
  }
}

/** Every query shares this queue, including reads made during a transaction.
 * Transaction callbacks must use their supplied handle, never getDb(). */
export class DatabaseCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private restoring = false;

  constructor(private readonly open: () => Promise<SQLiteDatabase>) {}

  captureGeneration(): number {
    this.assertGeneration(this.generation);
    return this.generation;
  }

  assertGeneration(generation: number): void {
    if (this.restoring || generation !== this.generation)
      throw new DatabaseReplacedError();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  async getDb(generation = this.captureGeneration()): Promise<SQLiteDatabase> {
    this.assertGeneration(generation);
    const db = await this.open();
    this.assertGeneration(generation);
    const queryMethods = new Set([
      "runAsync", "getFirstAsync", "getAllAsync", "execAsync",
    ]);
    return new Proxy(db, {
      get: (target, property) => {
        if (typeof property === "string" && queryMethods.has(property)) {
          return (...args: unknown[]) => this.enqueue(async () => {
            this.assertGeneration(generation);
            const method = Reflect.get(target, property) as (...parameters: unknown[]) => Promise<unknown>;
            return method.apply(target, args);
          });
        }
        if (property === "then") return undefined;
        const value = Reflect.get(target, property);
        if (typeof value === "function")
          throw new Error("Use withDbTransaction and its supplied database handle for transactions; direct database lifecycle/statement APIs are unsupported.");
        return value;
      },
    });
  }

  private async atomic<T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
    const db = await this.open();
    // SQLite enforces this lock across connections; the queue also keeps
    // unrelated async queries out of the transaction on native and web.
    await db.execAsync("BEGIN IMMEDIATE");
    try {
      const result = await work(db);
      await db.execAsync("COMMIT");
      return result;
    } catch (error) {
      await db.execAsync("ROLLBACK");
      throw error;
    }
  }

  transaction<T>(work: (db: SQLiteDatabase) => Promise<T>, generation = this.captureGeneration()): Promise<T> {
    return this.enqueue(async () => {
      this.assertGeneration(generation);
      return this.atomic(work);
    });
  }

  async restore<T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T> {
    if (this.restoring) throw new DatabaseReplacedError();
    // Invalidate first, before waiting for any outstanding DB operation. Old
    // network responses cannot enqueue writes into the restored data later.
    this.restoring = true;
    this.generation++;
    try {
      return await this.enqueue(() => this.atomic(work));
    } finally {
      this.restoring = false;
    }
  }
}
