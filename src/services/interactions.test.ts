import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, withDatabaseRestore } from "../db/database";
import { grantDailyOpen } from "../gamification";
import { getPostInteractionState, recordAction, submitQuizAnswer } from "./interactions";

const faults = vi.hoisted(() => ({ failXp: false }));

// Exercise the production SQL/schema/coordinator using an actual SQLite engine.
// Only the native Expo bridge is replaced, not the service or transaction logic.
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const native = new DatabaseSync(":memory:");
  type Bind = string | number | null;
  const bindings = (params: (Bind | Bind[])[]) =>
    Array.isArray(params[0]) ? params[0] : params as Bind[];
  return {
    openDatabaseAsync: async () => ({
      execAsync: async (sql: string) => { native.exec(sql); },
      runAsync: async (sql: string, ...params: (Bind | Bind[])[]) => {
        if (faults.failXp && sql.startsWith("INSERT INTO xp_events")) {
          faults.failXp = false;
          throw new Error("Simulated disk failure");
        }
        const result = native.prepare(sql).run(...bindings(params));
        return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
      },
      getFirstAsync: async (sql: string, ...params: (Bind | Bind[])[]) =>
        native.prepare(sql).get(...bindings(params)) ?? null,
      getAllAsync: async (sql: string, ...params: (Bind | Bind[])[]) =>
        native.prepare(sql).all(...bindings(params)),
    }),
  };
});

const now = new Date("2026-09-08T03:00:00Z").getTime();
const choiceQuiz = { question: "1 + 1?", choices: ["2", "3"], answerIndex: 0, answerText: "2", explanation: "Addition" };

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  faults.failXp = false;
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM quiz_attempts; DELETE FROM interactions; DELETE FROM atom_memory;
    DELETE FROM user_topic_state; DELETE FROM bandit_arms; DELETE FROM xp_events;
    DELETE FROM posts; DELETE FROM settings;
    UPDATE streak_state SET current_streak=0,longest_streak=0,last_active_date=NULL,freezes_owned=0;
  `);
  await db.runAsync(
    "INSERT INTO posts(id,subject_id,atom_id,topic_key,format,persona_id,text,quiz_json,difficulty_b,status,is_rare_card,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    "p1", "subject", "atom", "topic", "quiz", "teacher", "Quiz", JSON.stringify(choiceQuiz), 0, "unread", 1, now,
  );
});
afterEach(() => { vi.restoreAllMocks(); });

async function row(sql: string) { return (await getDb()).getFirstAsync(sql); }

describe("durable learning interactions", () => {
  it("rejects actions from cards loaded before a database restore, even when IDs match", async () => {
    const state = await getPostInteractionState("p1");
    await withDatabaseRestore(async () => {});
    await expect(recordAction("p1", "save", undefined, state.databaseGeneration)).rejects.toMatchObject({ name: "DatabaseReplacedError" });
    await expect(submitQuizAnswer("p1", state.attempt.sessionKey, { answerIndex: 0 }, state.databaseGeneration)).rejects.toMatchObject({ name: "DatabaseReplacedError" });
    expect(await row("SELECT COUNT(*) count FROM interactions")).toEqual({ count: 0 });
    const refreshed = await getPostInteractionState("p1");
    await submitQuizAnswer("p1", refreshed.attempt.sessionKey, { answerIndex: 0 }, refreshed.databaseGeneration);
    expect(await row("SELECT review_count FROM atom_memory")).toEqual({ review_count: 1 });
  });
  it("deduplicates concurrent submissions, including XP, SRS and IRT", async () => {
    const { attempt } = await getPostInteractionState("p1");
    const [first, second] = await Promise.all([
      submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 0 }),
      submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 1 }),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ completed: true, answerIndex: 0, correct: true });
    expect(await row("SELECT COUNT(*) count FROM quiz_attempts")).toEqual({ count: 1 });
    expect(await row("SELECT COUNT(*) count FROM interactions")).toEqual({ count: 1 });
    expect(await row("SELECT review_count,stability_days FROM atom_memory")).toEqual({ review_count: 1, stability_days: 2.2 });
    expect(await row("SELECT attempts FROM user_topic_state")).toEqual({ attempts: 1 });
    expect(await row("SELECT SUM(amount) total FROM xp_events")).toEqual({ total: 35 });
    expect((await getPostInteractionState("p1")).attempt).toEqual(first);
  });

  it("rolls back a mid-save failure and allows retry with the same session", async () => {
    const { attempt } = await getPostInteractionState("p1");
    faults.failXp = true;
    await expect(submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 0 })).rejects.toThrow("disk failure");
    for (const table of ["quiz_attempts", "interactions", "atom_memory", "user_topic_state", "xp_events", "bandit_arms"])
      expect(await row(`SELECT COUNT(*) count FROM ${table}`)).toEqual({ count: 0 });
    expect(await row("SELECT status,difficulty_b FROM posts")).toEqual({ status: "unread", difficulty_b: 0 });
    await submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 0 });
    expect(await row("SELECT review_count FROM atom_memory")).toEqual({ review_count: 1 });
  });

  it("accepts a later due review while retaining idempotency for old retries", async () => {
    const { attempt } = await getPostInteractionState("p1");
    const first = await submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 0 });
    vi.mocked(Date.now).mockReturnValue(first.nextReviewAt! + 1);
    const next = (await getPostInteractionState("p1")).attempt;
    expect(next.completed).toBe(false);
    expect(next.sessionKey).not.toBe(first.sessionKey);
    expect(await submitQuizAnswer("p1", first.sessionKey, { answerIndex: 1 })).toEqual(first);
    await submitQuizAnswer("p1", next.sessionKey, { answerIndex: 1 });
    expect(await row("SELECT review_count,lapse_count FROM atom_memory")).toEqual({ review_count: 2, lapse_count: 1 });
    expect(await row("SELECT attempts FROM user_topic_state")).toEqual({ attempts: 2 });
  });

  it("requires a valid session and validates choices before changing learning state", async () => {
    await expect(submitQuizAnswer("p1", "invented-session", { answerIndex: 0 })).rejects.toThrow("session changed");
    const { attempt } = await getPostInteractionState("p1");
    await expect(submitQuizAnswer("p1", attempt.sessionKey, { answerIndex: 9 })).rejects.toThrow("available answers");
    await expect(submitQuizAnswer("p1", attempt.sessionKey, { correct: true })).rejects.toThrow("available answers");
    expect(await row("SELECT COUNT(*) count FROM quiz_attempts")).toEqual({ count: 0 });
    expect(await row("SELECT COUNT(*) count FROM interactions")).toEqual({ count: 0 });
  });

  it("persists one self assessment and ignores repeated contradictory grades", async () => {
    await (await getDb()).runAsync("UPDATE posts SET quiz_json=?", JSON.stringify({ question: "Explain addition", answerText: "Combining quantities", explanation: "Example" }));
    const { attempt } = await getPostInteractionState("p1");
    await submitQuizAnswer("p1", attempt.sessionKey, { correct: false });
    await submitQuizAnswer("p1", attempt.sessionKey, { correct: true });
    expect((await getPostInteractionState("p1")).attempt).toMatchObject({ completed: true, correct: false, answerIndex: null });
    expect(await row("SELECT review_count,lapse_count FROM atom_memory")).toEqual({ review_count: 1, lapse_count: 1 });
    expect(await row("SELECT COUNT(*) count FROM xp_events")).toEqual({ count: 0 });
  });

  it("restores bookmark/like state and honors toggles within the same millisecond", async () => {
    await recordAction("p1", "save");
    await recordAction("p1", "like");
    expect(await getPostInteractionState("p1")).toMatchObject({ saved: true, liked: true });
    await recordAction("p1", "unsave");
    await recordAction("p1", "unlike");
    expect(await getPostInteractionState("p1")).toMatchObject({ saved: false, liked: false });
    expect(await getPostInteractionState("p2")).toMatchObject({ saved: false, liked: false, attempt: { completed: false, answerIndex: null } });
  });

  it("grants daily-open XP once across simultaneous startup calls", async () => {
    await Promise.all([grantDailyOpen(), grantDailyOpen(), grantDailyOpen()]);
    expect(await row("SELECT SUM(amount) total,COUNT(*) count FROM xp_events")).toEqual({ total: 5, count: 1 });
  });
});
