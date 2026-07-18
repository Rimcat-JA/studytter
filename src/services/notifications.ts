import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { CONFIG } from "../core/config";
import { retention } from "../core/srs";
import { getDb, getSetting, setSetting } from "../db/database";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
export async function setNotificationsEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (!enabled) {
    await Notifications.cancelAllScheduledNotificationsAsync();
    await setSetting("notificationsEnabled", false);
    return false;
  }
  const permission = await Notifications.requestPermissionsAsync();
  const granted = permission.granted;
  if (granted) {
    if (Platform.OS === "android")
      await Notifications.setNotificationChannelAsync("learning", {
        name: "学習リマインダー",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    await setSetting("notificationsEnabled", true);
    await evaluateNotifications();
  }
  return granted;
}
export async function evaluateNotifications(): Promise<void> {
  if (!(await getSetting("notificationsEnabled", false))) return;
  const db = await getDb();
  const now = new Date();
  const today = now.toLocaleDateString("en-CA");
  const oldId = await getSetting<string | null>("streakNotificationId", null);
  if (oldId)
    try {
      await Notifications.cancelScheduledNotificationAsync(oldId);
    } catch {}
  const interacted = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(DISTINCT post_id) count FROM interactions WHERE action IN ('like','save','expand','quiz_correct','quiz_wrong','reveal') AND created_at>=?",
    new Date(`${today}T00:00:00`).getTime(),
  );
  if ((interacted?.count ?? 0) < CONFIG.dailyInteractionsForStreak) {
    const atRisk = new Date();
    atRisk.setHours(20, 0, 0, 0);
    if (atRisk.getTime() <= Date.now()) atRisk.setDate(atRisk.getDate() + 1);
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: "今日の学びをつなげよう",
        body: "短いクイズをひとつだけ解いて、学習のリズムを整えませんか？",
        data: { kind: "streak" },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: atRisk,
        channelId: "learning",
      },
    });
    await setSetting("streakNotificationId", identifier);
  }
  const dayState = await getSetting<{ date: string; count: number }>(
    "notificationDayState",
    { date: today, count: 0 },
  );
  const sent = dayState.date === today ? dayState.count : 0;
  if (sent >= CONFIG.maxNotificationsPerDay) return;
  const rows = await db.getAllAsync<{
    topic_label: string;
    stability_days: number;
    last_reviewed_at: number | null;
  }>(
    "SELECT a.topic_label,m.stability_days,m.last_reviewed_at FROM atom_memory m JOIN atoms a ON a.atom_id=m.atom_id WHERE a.enabled=1",
  );
  const due = rows.filter(
    (r) => retention(r.stability_days, r.last_reviewed_at) < 0.85,
  );
  if (
    due.length >= 5 &&
    now.getHours() >= CONFIG.notificationQuietEndHour &&
    now.getHours() < CONFIG.notificationQuietStartHour
  ) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "そろそろ復習のタイミング",
        body: `${due[0].topic_label}を少し思い出してみましょう。`,
        data: { kind: "srs" },
      },
      trigger: null,
    });
    await setSetting("notificationDayState", { date: today, count: sent + 1 });
  }
}
