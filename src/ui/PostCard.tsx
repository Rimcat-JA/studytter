import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import type { PostRow } from "../db/database";
import { isLiked } from "../db/database";
import { recordAction } from "../services/interactions";
import { colors } from "./theme";

type Quiz = {
  question: string;
  choices?: string[];
  answerIndex?: number;
  answerText: string;
  explanation: string;
};
export function Avatar({
  seed,
  name,
  size = 42,
}: {
  seed: string;
  name: string;
  size?: number;
}) {
  const hue = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: `hsl(${hue},55%,42%)`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{ color: "white", fontWeight: "900", fontSize: size * 0.42 }}
      >
        {name.slice(0, 1)}
      </Text>
    </View>
  );
}
export default function PostCard({
  post,
  showReplyAction = true,
}: {
  post: PostRow;
  showReplyAction?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [answer, setAnswer] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const scale = useSharedValue(1);
  const glow = useSharedValue(0.25);
  const quiz: Quiz | null = post.quiz_json ? JSON.parse(post.quiz_json) : null;
  useEffect(() => {
    isLiked(post.id).then(setLiked);
  }, [post.id]);
  useEffect(() => {
    if (post.is_rare_card === 1) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      glow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 900 }),
          withTiming(0.25, { duration: 900 }),
        ),
        -1,
      );
    }
  }, [glow, post.is_rare_card]);
  const heartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const toggleLike = async () => {
    const next = !liked;
    setLiked(next);
    // Reanimated SharedValue is intentionally mutable on the UI thread.
    // eslint-disable-next-line react-hooks/immutability
    scale.value = withSequence(withSpring(1.45), withSpring(1));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await recordAction(post.id, next ? "like" : "unlike");
  };
  const choose = async (index: number) => {
    if (answer !== null) return;
    setAnswer(index);
    const correct = index === quiz?.answerIndex;
    await Haptics.notificationAsync(
      correct
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    );
    await recordAction(post.id, correct ? "quiz_correct" : "quiz_wrong");
  };
  return (
    <View style={[styles.card, post.is_rare_card === 1 && styles.rare]}>
      {post.is_rare_card === 1 && (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.rareGlow, glowStyle]}
        />
      )}
      {post.is_rare_card === 1 && (
        <Text style={styles.rareLabel}>✦ RARE LEARNING CARD</Text>
      )}
      <View style={styles.top}>
        <Avatar seed={post.avatar_seed} name={post.display_name} />
        <View style={{ flex: 1 }}>
          <View style={styles.identity}>
            <Text numberOfLines={1} style={styles.name}>
              {post.display_name}
            </Text>
            <Text style={styles.handle}>
              {post.handle} · {timeAgo(post.created_at, i18n.language)}
            </Text>
          </View>
          <Text style={styles.body}>{post.text}</Text>
          {quiz && (
            <View style={styles.quiz}>
              <Text style={styles.question}>{quiz.question}</Text>
              {quiz.choices?.map((choice, index) => {
                const correct = answer !== null && index === quiz.answerIndex;
                const wrong = answer === index && !correct;
                return (
                  <Pressable
                    key={index}
                    disabled={answer !== null}
                    onPress={() => choose(index)}
                    style={[
                      styles.choice,
                      correct && styles.correct,
                      wrong && styles.wrong,
                    ]}
                  >
                    <Text style={styles.choiceText}>{choice}</Text>
                  </Pressable>
                );
              })}
              {!quiz.choices && (
                <>
                  {!revealed ? (
                    <Pressable
                      style={styles.reveal}
                      onPress={async () => {
                        setRevealed(true);
                        await recordAction(post.id, "reveal");
                      }}
                    >
                      <Text style={styles.revealText}>{t("reveal")}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.answer}>
                      <Text style={styles.choiceText}>{quiz.answerText}</Text>
                      <View style={styles.grade}>
                        <Pressable
                          onPress={() => recordAction(post.id, "quiz_correct")}
                        >
                          <Text style={styles.good}>{t("knew")}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => recordAction(post.id, "quiz_wrong")}
                        >
                          <Text style={styles.bad}>{t("didntKnow")}</Text>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </>
              )}
              {(answer !== null || revealed) && (
                <Text style={styles.explanation}>{quiz.explanation}</Text>
              )}
            </View>
          )}
          <Text style={styles.source}>
            {t("source")}: {post.source_anchor}
          </Text>
          <View style={styles.actions}>
            {showReplyAction && (
              <Action
                glyph="↩"
                label={t("askAi", { defaultValue: "AIに質問" })}
                accessibilityLabel={t("askAi", {
                  defaultValue: "AIに質問",
                })}
                active={false}
                onPress={async () => {
                  await recordAction(post.id, "expand");
                  router.push(`/post/${post.id}`);
                }}
              />
            )}
            <Action
              glyph={saved ? "▣" : "▢"}
              accessibilityLabel={t("save", { defaultValue: "保存" })}
              active={saved}
              onPress={async () => {
                setSaved(!saved);
                await recordAction(post.id, "save");
              }}
            />
            <Animated.View style={heartStyle}>
              <Action
                glyph={liked ? "♥" : "♡"}
                accessibilityLabel={t("like", { defaultValue: "いいね" })}
                active={liked}
                color={colors.red}
                onPress={toggleLike}
              />
            </Animated.View>
            <Action
              glyph="↗"
              accessibilityLabel={t("share", { defaultValue: "共有" })}
              active={false}
              onPress={() =>
                Share.share({
                  message: `${post.text}\n${t("source")}: ${post.source_anchor}\nlearnstream://post/${post.id}`,
                })
              }
            />
          </View>
        </View>
      </View>
    </View>
  );
}
function Action({
  glyph,
  label,
  accessibilityLabel,
  active,
  color = colors.blue,
  onPress,
}: {
  glyph: string;
  label?: string;
  accessibilityLabel: string;
  active: boolean;
  color?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={12}
      onPress={onPress}
      style={styles.actionButton}
    >
      <Text style={{ fontSize: 22, color: active ? color : colors.muted }}>
        {glyph}
      </Text>
      {label && <Text style={styles.actionLabel}>{label}</Text>}
    </Pressable>
  );
}
function timeAgo(ts: number, language: string) {
  const minutes = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  const value =
    minutes < 60
      ? minutes
      : minutes < 1440
        ? Math.floor(minutes / 60)
        : Math.floor(minutes / 1440);
  const unit = minutes < 60 ? "minute" : minutes < 1440 ? "hour" : "day";
  if (language.startsWith("ja")) {
    const label = unit === "minute" ? "分" : unit === "hour" ? "時間" : "日";
    return `${value}${label}前`;
  }
  if (language.startsWith("zh")) {
    const label = unit === "minute" ? "分钟" : unit === "hour" ? "小时" : "天";
    return `${value}${label}前`;
  }
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}
const styles = StyleSheet.create({
  card: {
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg,
  },
  rare: {
    margin: 8,
    borderWidth: 1.5,
    borderColor: colors.gold,
    borderRadius: 18,
    backgroundColor: "#19170e",
    overflow: "hidden",
  },
  rareGlow: { borderWidth: 3, borderColor: "#fff2a8", borderRadius: 18 },
  rareLabel: {
    color: colors.gold,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1,
    marginBottom: 8,
    marginLeft: 52,
  },
  top: { flexDirection: "row", gap: 10 },
  identity: { flexDirection: "row", gap: 6, alignItems: "center" },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900",
    maxWidth: "48%",
  },
  handle: { color: colors.muted, fontSize: 13 },
  body: { color: colors.text, fontSize: 16, lineHeight: 23, marginTop: 5 },
  source: { color: colors.muted, fontSize: 12, marginTop: 10 },
  actions: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingRight: 34,
    paddingTop: 14,
  },
  actionButton: { minWidth: 34, alignItems: "center" },
  actionLabel: {
    color: colors.blue,
    fontSize: 10,
    fontWeight: "800",
    marginTop: 1,
  },
  quiz: { gap: 8, marginTop: 12 },
  question: { color: colors.text, fontWeight: "800", fontSize: 16 },
  choice: {
    padding: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  correct: { borderColor: colors.green, backgroundColor: "#0b3228" },
  wrong: { borderColor: colors.red, backgroundColor: "#3a1227" },
  choiceText: { color: colors.text },
  reveal: {
    padding: 12,
    borderRadius: 999,
    backgroundColor: colors.blue,
    alignItems: "center",
  },
  revealText: { color: "white", fontWeight: "800" },
  answer: { padding: 12, borderRadius: 12, backgroundColor: colors.surface },
  grade: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 12,
  },
  good: { color: colors.green, fontWeight: "800" },
  bad: { color: colors.warning, fontWeight: "800" },
  explanation: { color: colors.muted, lineHeight: 20, marginTop: 4 },
});
