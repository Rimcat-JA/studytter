import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { getDb, type PostRow } from "../../src/db/database";
import { getProgress } from "../../src/gamification";
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
  useFocusEffect(
    useCallback(() => {
      (async () => {
        setData(await getProgress());
        setSaved(
          await (
            await getDb()
          ).getAllAsync<PostRow>(
            `SELECT p.*,s.display_name,s.handle,s.avatar_seed,COALESCE(a.source_anchor,'LearnStream') source_anchor FROM posts p JOIN subjects s ON s.subject_id=p.subject_id LEFT JOIN atoms a ON a.atom_id=p.atom_id WHERE EXISTS(SELECT 1 FROM interactions i WHERE i.post_id=p.id AND i.action='save') ORDER BY p.created_at DESC`,
          ),
        );
      })();
    }, []),
  );
  if (!data)
    return (
      <Screen>
        <Loading />
      </Screen>
    );
  return (
    <Screen>
      <Header title={t("progress")} />
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
          saved.map((post) => <PostCard key={post.id} post={post} />)
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
