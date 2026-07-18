import { FlashList, type ViewToken } from "@shopify/flash-list";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const visible = useRef(new Map<string, number>());
  const load = useCallback(async () => {
    const [s, p] = await Promise.all([
      listSubjects(),
      loadRankedFeed(selected ?? undefined),
    ]);
    setSubjects(s.filter((x) => x.enabled));
    setPosts(p);
    setLoading(false);
  }, [selected]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  useEffect(() => {
    const unsubscribe = subscribeToGeneratedPosts(() => {
        void load();
    });
    return () => {
      unsubscribe();
    };
  }, [load]);
  const refresh = async () => {
    setRefreshing(true);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
    await requestAutoGeneration("pull_refresh");
    await load();
    setRefreshing(false);
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
            active={!selected}
            onPress={() => setSelected(null)}
          />
          {subjects.map((s) => (
            <Chip
              key={s.subject_id}
              label={s.display_name}
              active={selected === s.subject_id}
              onPress={() => setSelected(s.subject_id)}
              onLongPress={() => router.push("/(tabs)/settings/subjects")}
            />
          ))}
        </ScrollView>
      </View>
      {loading ? (
        <Loading />
      ) : posts.length === 0 ? (
        <Empty
          title={t("emptyFeed")}
          action={
            <Pressable onPress={() => router.push("/subject/new")}>
              <Text style={styles.link}>{t("createSubject")}</Text>
            </Pressable>
          }
        />
      ) : (
        <FlashList
          data={posts}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <PostCard post={item} />}
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
            void requestAutoGeneration("feed_end");
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
