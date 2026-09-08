import { FlashList, type ViewToken } from "@shopify/flash-list";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  listSubjects,
  type PostRow,
  type SubjectRow,
} from "../../src/db/database";
import {
  requestAutoGeneration,
  subscribeToGeneratedPosts,
} from "../../src/services/autogeneration";
import { loadRankedFeed } from "../../src/services/feed";
import { recordAction } from "../../src/services/interactions";
import { useAppStore } from "../../src/state/app";
import PostCard from "../../src/ui/PostCard";
import { Empty, Header, Loading, Screen } from "../../src/ui/components";
import { colors } from "../../src/ui/theme";

export default function FeedScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const selected = useAppStore((s) => s.selectedSubject);
  const setSelected = useAppStore((s) => s.setSelectedSubject);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const focusVersion = useRef(0);
  const refreshScope = useRef<number | null>(null);
  const visible = useRef(new Map<string, number>());
  const load = useCallback(async (scope: number) => {
    if (scope !== focusVersion.current) return;
    const version = ++loadVersion.current;
    try {
      const [s, p] = await Promise.all([
        listSubjects(),
        loadRankedFeed(selected ?? undefined, { savedOnly }),
      ]);
      if (version !== loadVersion.current || scope !== focusVersion.current) return;
      const enabled = s.filter((x) => x.enabled);
      setSubjects(enabled);
      if (selected && !enabled.some((x) => x.subject_id === selected)) {
        setSelected(null);
        return;
      }
      setPosts(p);
      setError(null);
    } catch (cause) {
      if (version === loadVersion.current && scope === focusVersion.current)
        setError(cause instanceof Error ? cause.message : "フィードを読み込めませんでした。");
    } finally {
      if (version === loadVersion.current && scope === focusVersion.current) setLoading(false);
    }
  }, [selected, savedOnly, setSelected]);
  useFocusEffect(
    useCallback(() => {
      const scope = ++focusVersion.current;
      setLoading(true);
      setRefreshing(false);
      refreshScope.current = null;
      void load(scope);
      const unsubscribe = subscribeToGeneratedPosts(() => { void load(scope); });
      return () => {
        focusVersion.current++;
        loadVersion.current++;
        visible.current.clear();
        unsubscribe();
      };
    }, [load]),
  );
  const refresh = async () => {
    const scope = focusVersion.current;
    if (refreshScope.current === scope) return;
    refreshScope.current = scope;
    setRefreshing(true);
    try {
      const result = savedOnly ? null : await requestAutoGeneration("pull_refresh", { subjectId: selected ?? undefined });
      if (scope !== focusVersion.current) return;
      await load(scope);
      if (scope === focusVersion.current && result?.status === "failed") setError(result.errorMessage ?? "投稿を生成できませんでした。");
    } catch (cause) {
      if (scope === focusVersion.current) setError(cause instanceof Error ? cause.message : "更新できませんでした。");
    } finally {
      if (refreshScope.current === scope) refreshScope.current = null;
      if (scope === focusVersion.current) setRefreshing(false);
    }
  };
  const viewability = useCallback(
    ({ changed }: { changed: ViewToken<PostRow>[] }) => {
      for (const token of changed) {
        const post = token.item;
        if (token.isViewable) {
          visible.current.set(post.id, Date.now());
        } else {
          const started = visible.current.get(post.id);
          if (started) {
            visible.current.delete(post.id);
            recordAction(post.id, "impression", Date.now() - started).catch(
              console.error,
            );
          }
        }
      }
    },
    [],
  );
  return (
    <Screen>
      <Header
        title="LearnStream"
        right={
          <Pressable onPress={() => router.push("/subject/new")}>
            <Text style={styles.add}>＋</Text>
          </Pressable>
        }
      />
      <View style={styles.chipsWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          <Chip
            label={t("forYou")}
            active={!selected && !savedOnly}
            onPress={() => { setSavedOnly(false); setSelected(null); }}
          />
          <Chip label="保存済み" active={savedOnly} onPress={() => { setSavedOnly(true); setSelected(null); }} />
          {subjects.map((s) => (
            <Chip
              key={s.subject_id}
              label={s.display_name}
              active={!savedOnly && selected === s.subject_id}
              onPress={() => { setSavedOnly(false); setSelected(s.subject_id); }}
              onLongPress={() => router.push("/(tabs)/settings/subjects")}
            />
          ))}
        </ScrollView>
      </View>
      {error && <Pressable style={styles.error} onPress={() => void load(focusVersion.current)}><Text style={styles.link}>{error}（タップして再読込）</Text></Pressable>}
      {loading ? (
        <Loading />
      ) : posts.length === 0 ? (
        <Empty
          title={savedOnly ? "保存済みの投稿はありません" : t("emptyFeed")}
          action={
            savedOnly ? undefined : <View style={{ gap: 16 }}><Pressable onPress={() => void refresh()} disabled={refreshing}>
              <Text style={styles.link}>{refreshing ? "更新中…" : "投稿を補充・再読込"}</Text>
            </Pressable><Pressable onPress={() => router.push("/subject/new")}><Text style={styles.link}>{t("createSubject")}</Text></Pressable></View>
          }
        />
      ) : (
        <FlashList
          data={posts}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <PostCard post={item} onBookmarkChange={() => { if (savedOnly) void load(focusVersion.current); }} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.blue}
            />
          }
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          onViewableItemsChanged={viewability}
          onEndReachedThreshold={0.25}
          onEndReached={() => {
            const scope = focusVersion.current;
            if (!savedOnly) void requestAutoGeneration("feed_end", { subjectId: selected ?? undefined }).catch((cause) => {
              if (scope === focusVersion.current) setError(String(cause));
            });
          }}
        />
      )}
    </Screen>
  );
}
function Chip({
  label,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.chip, active && styles.activeChip]}
    >
      <Text style={[styles.chipText, active && styles.activeChipText]}>
        {label}
      </Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  error: { padding: 12 },
  chipsWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  chips: { gap: 8, padding: 10 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  activeChip: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { color: colors.muted, fontWeight: "700" },
  activeChipText: { color: colors.bg },
  add: { color: colors.blue, fontSize: 30, fontWeight: "300" },
  link: { color: colors.blue, fontWeight: "800", fontSize: 16 },
});
