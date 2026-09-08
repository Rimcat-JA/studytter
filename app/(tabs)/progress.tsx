import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { getDb, type PostRow } from "../../src/db/database";
import { getProgress } from "../../src/gamification";
import { loadRankedFeed } from "../../src/services/feed";
import PostCard from "../../src/ui/PostCard";
import {
  Card,
  Empty,
  Header,
  Loading,
  Screen,
  commonStyles,
} from "../../src/ui/components";
import { colors } from "../../src/ui/theme";

type ProgressData = Awaited<ReturnType<typeof getProgress>>;
export default function Progress() {
  const { t } = useTranslation();
  const [data, setData] = useState<ProgressData | null>(null);
  const [saved, setSaved] = useState<PostRow[]>([]);
  const [cardRevision, setCardRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [learning, setLearning] = useState<{ attempts: number; correct: number; reviews: number; review_correct: number } | null>(null);
  const loadVersion = useRef(0);
  const load = useCallback(() => {
    const version = ++loadVersion.current;
    return (async () => {
        const [progress, bookmarks, stats] = await Promise.all([
          getProgress(),
          loadRankedFeed(undefined, { savedOnly: true }),
          (await getDb()).getFirstAsync<{ attempts: number; correct: number; reviews: number; review_correct: number }>(
            "SELECT COUNT(*) attempts,COALESCE(SUM(correct),0) correct,COALESCE(SUM(CASE WHEN session_key LIKE 'after:%' THEN 1 ELSE 0 END),0) reviews,COALESCE(SUM(CASE WHEN session_key LIKE 'after:%' THEN correct ELSE 0 END),0) review_correct FROM quiz_attempts",
          ),
        ]);
        if (version !== loadVersion.current) return;
        setData(progress);
        setSaved(bookmarks);
        setCardRevision((revision) => revision + 1);
        setLearning(stats);
        setError(null);
      })().catch((cause) => { if (version === loadVersion.current) setError(cause instanceof Error ? cause.message : "読み込みに失敗しました。"); });
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { loadVersion.current++; };
    }, [load]),
  );
  const retry = <Pressable onPress={() => void load()}><Text style={styles.retry}>再読み込み</Text></Pressable>;
  if (!data)
    return (
      <Screen>
        <Header title={t("progress")} />
        {error ? <Empty title="読み込みに失敗しました" body={error} action={retry} /> : <Loading />}
      </Screen>
    );
  return (
    <Screen>
      <Header title={t("progress")} />
      {error && <View style={styles.error}><Text style={commonStyles.muted}>{error}</Text>{retry}</View>}
      <ScrollView>
        <View style={styles.hero}>
          <Card>
            <View style={styles.metricRow}>
              <Metric
                icon="🔥"
                value={String(data.streak.current_streak)}
                label={t("streak")}
              />
              <Metric icon="✦" value={String(data.xp)} label={t("xp")} />
              <Metric icon="◈" value={String(data.level)} label={t("level")} />
            </View>
            <Text style={styles.freeze}>
              ❄ {data.streak.freezes_owned} · 最長 {data.streak.longest_streak}
              日
            </Text>
          </Card>
        </View>
        {learning && <View style={{ paddingHorizontal: 16 }}><Card>
          <Text style={commonStyles.label}>クイズの学習記録</Text>
          <Text style={commonStyles.text}>回答 {learning.attempts}回 · 正答 {learning.correct}回</Text>
          <Text style={commonStyles.muted}>復習時の正答率 {learning.reviews ? `${Math.round(100 * learning.review_correct / learning.reviews)}%（${learning.reviews}回）` : "まだ復習記録がありません"}</Text>
        </Card></View>}
        <Text style={styles.sectionTitle}>{t("mastery")}</Text>
        {data.topics.length ? (
          data.topics.map((topic) => (
            <View key={topic.topic_key} style={styles.topic}>
              <View style={commonStyles.row}>
                <Text
                  numberOfLines={1}
                  style={[commonStyles.text, { flex: 1 }]}
                >
                  {topic.topic_key.split(":").slice(1).join(":")}
                </Text>
                <Text style={commonStyles.muted}>{topic.mastery}%</Text>
              </View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${topic.mastery}%` }]} />
              </View>
            </View>
          ))
        ) : (
          <Text style={styles.hint}>
            クイズに答えると習熟度が表示されます。
          </Text>
        )}
        <Text style={styles.sectionTitle}>{t("saved")}</Text>
        {saved.length ? (
          saved.map((post) => <PostCard key={`${post.id}:${cardRevision}`} post={post} onBookmarkChange={(id, isSaved) => { if (!isSaved) setSaved((current) => current.filter((item) => item.id !== id)); }} />)
        ) : (
          <View style={{ height: 220 }}>
            <Empty icon="▢" title="保存した投稿はまだありません" />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
function Metric({
  icon,
  value,
  label,
}: {
  icon: string;
  value: string;
  label: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.icon}>{icon}</Text>
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  error: { padding: 16, gap: 8 },
  retry: { color: colors.blue, fontWeight: "700" },
  hero: { padding: 16 },
  metricRow: { flexDirection: "row", justifyContent: "space-around" },
  metric: { alignItems: "center", gap: 3 },
  icon: { fontSize: 24 },
  value: { color: colors.text, fontSize: 25, fontWeight: "900" },
  metricLabel: { color: colors.muted, fontSize: 12 },
  freeze: { textAlign: "center", color: colors.muted, marginTop: 16 },
  sectionTitle: {
    color: colors.text,
    fontWeight: "900",
    fontSize: 20,
    padding: 16,
    paddingBottom: 8,
  },
  topic: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  track: {
    height: 9,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: colors.blue, borderRadius: 6 },
  hint: { color: colors.muted, paddingHorizontal: 16, paddingBottom: 16 },
});
