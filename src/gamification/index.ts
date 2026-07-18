import { CONFIG } from "../core/config";
import { getDb, createId, getSetting, setSetting } from "../db/database";

const dateKey = (timestamp = Date.now()) =>
  new Date(timestamp).toLocaleDateString("en-CA");

export const XP_REWARDS = {
  quiz_correct: 10,
  like: 2,
  expand: 5,
  rare_card: 25,
  daily_open: 5,
} as const;

export async function grantXp(
  reason: keyof typeof XP_REWARDS,
  sourceId?: string,
): Promise<void> {
  const db = await getDb();
  const storedReason = sourceId ? `${reason}:${sourceId}` : reason;
  if (
    sourceId &&
    (await db.getFirstAsync(
      "SELECT id FROM xp_events WHERE reason=?",
      storedReason,
    ))
  )
    return;
  await db.runAsync(
    "INSERT INTO xp_events(id,amount,reason,created_at) VALUES(?,?,?,?)",
    createId("xp"),
    XP_REWARDS[reason],
    storedReason,
    Date.now(),
  );
}

export async function recordLearningDay(): Promise<void> {
  const db = await getDb();
  const today = dateKey();
  const count = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(DISTINCT post_id) count FROM interactions WHERE action IN ('like','save','expand','quiz_correct','quiz_wrong','reveal') AND created_at>=?",
    new Date(`${today}T00:00:00`).getTime(),
  );
  if ((count?.count ?? 0) < CONFIG.dailyInteractionsForStreak) return;
  const state = await db.getFirstAsync<{
    current_streak: number;
    longest_streak: number;
    last_active_date: string | null;
    freezes_owned: number;
  }>("SELECT * FROM streak_state WHERE id=1");
  if (!state || state.last_active_date === today) return;
  const last = state.last_active_date
    ? new Date(`${state.last_active_date}T00:00:00`).getTime()
    : 0;
  const gap = last
    ? Math.round((new Date(`${today}T00:00:00`).getTime() - last) / 86_400_000)
    : Infinity;
  let freezes = state.freezes_owned;
  let streak: number;
  if (gap === 1) streak = state.current_streak + 1;
  else if (gap === 2 && freezes > 0) {
    freezes--;
    streak = state.current_streak + 1;
  } else streak = 1;
  if (streak > 0 && streak % 7 === 0)
    freezes = Math.min(CONFIG.maxStreakFreezes, freezes + 1);
  await db.runAsync(
    "UPDATE streak_state SET current_streak=?,longest_streak=?,last_active_date=?,freezes_owned=? WHERE id=1",
    streak,
    Math.max(streak, state.longest_streak),
    today,
    freezes,
  );
}

export async function grantDailyOpen(): Promise<void> {
  const today = dateKey();
  if ((await getSetting("lastDailyOpenXpDate", "")) === today) return;
  await grantXp("daily_open");
  await setSetting("lastDailyOpenXpDate", today);
}

export async function getProgress() {
  const db = await getDb();
  const xp = await db.getFirstAsync<{ total: number }>(
    "SELECT COALESCE(SUM(amount),0) total FROM xp_events",
  );
  const streak = await db.getFirstAsync<{
    current_streak: number;
    longest_streak: number;
    freezes_owned: number;
  }>(
    "SELECT current_streak,longest_streak,freezes_owned FROM streak_state WHERE id=1",
  );
  const topics = await db.getAllAsync<{ topic_key: string; theta: number }>(
    "SELECT topic_key,theta FROM user_topic_state ORDER BY topic_key",
  );
  const total = xp?.total ?? 0;
  return {
    xp: total,
    level: Math.floor(Math.sqrt(total / 100)),
    streak: streak ?? {
      current_streak: 0,
      longest_streak: 0,
      freezes_owned: 0,
    },
    topics: topics.map((t) => ({
      ...t,
      mastery: Math.round(100 / (1 + Math.exp(-t.theta))),
    })),
  };
}
