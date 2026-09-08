import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SQLiteDatabase } from "expo-sqlite";

/** Execute production SQL against SQLite, not a query-string mock. */
export function openTestDatabase(initialize = true) {
  const sqlite = new DatabaseSync(":memory:");
  const parameters = (args: unknown[]): SQLInputValue[] =>
    (args.length === 1 && Array.isArray(args[0]) ? args[0] : args) as SQLInputValue[];
  const db = {
    async execAsync(sql: string) { sqlite.exec(sql); },
    async runAsync(sql: string, ...args: unknown[]) {
      const result = sqlite.prepare(sql).run(...parameters(args));
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, ...args: unknown[]): Promise<T | null> {
      return (sqlite.prepare(sql).get(...parameters(args)) as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]> {
      return sqlite.prepare(sql).all(...parameters(args)) as T[];
    },
  } as unknown as SQLiteDatabase;
  if (initialize) {
    const source = readFileSync(new URL("../db/database.ts", import.meta.url), "utf8");
    const initialSql = source.match(/const INITIAL_SQL = `([\s\S]*?)`;/)?.[1];
    if (!initialSql) throw new Error("Production schema could not be loaded");
    sqlite.exec(initialSql);
  }
  return { db, sqlite, close: () => sqlite.close() };
}
