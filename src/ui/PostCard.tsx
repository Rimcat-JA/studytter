import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import type { PostRow } from "../db/database";
import { QuizSchema } from "../llm/schemas";
import { getPostInteractionState, recordAction, submitQuizAnswer } from "../services/interactions";
import type { QuizAttempt } from "../services/interactions";
import { colors } from "./theme";

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
type PostCardProps = {
  post: PostRow;
  showReplyAction?: boolean;
  onBookmarkChange?: (postId: string, saved: boolean) => void;
};

export default function PostCard(props: PostCardProps) {
  // FlashList reuses the outer cell. Keying its stateful contents prevents even
  // one frame of a different post's answer, pending action or bookmark state.
  return <PostCardContent key={props.post.id} {...props} />;
}

function PostCardContent({
  post,
  showReplyAction = true,
  onBookmarkChange,
}: PostCardProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [databaseGeneration, setDatabaseGeneration] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"load" | "action" | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const scale = useSharedValue(1);
  const glow = useSharedValue(0.25);
  const quiz = useMemo(() => {
    try {
      const parsed = QuizSchema.safeParse(JSON.parse(post.quiz_json ?? "null"));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, [post.quiz_json]);
  const answer = attempt?.answerIndex ?? null;
  const completed = attempt?.completed === true;
  const disabled = loading || pending || attempt === null || databaseGeneration === null;
  const loadState = useCallback(() => {
    return getPostInteractionState(post.id).then((state) => {
      if (!mounted.current) return;
      setError(null);
      setDatabaseGeneration(state.databaseGeneration);
      setLiked(state.liked);
      setSaved(state.saved);
      setAttempt(state.attempt);
      setRevealed(state.attempt.completed);
    }).catch(() => {
      if (mounted.current) setError("load");
    }).finally(() => {
      if (mounted.current) setLoading(false);
    });
  }, [post.id]);
  useEffect(() => {
    mounted.current = true;
    void loadState();
    return () => { mounted.current = false; };
  }, [loadState]);
  useEffect(() => {
    if (post.is_rare_card === 1) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      glow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 900 }),
          withTiming(0.25, { duration: 900 }),
        ),
        -1,
      );
    }
    return () => { cancelAnimation(glow); };
  }, [glow, post.is_rare_card]);
  const heartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current || disabled) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch {
      if (mounted.current) setError("action");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const toggleLike = () => perform(async () => {
    const next = !liked;
    await recordAction(post.id, next ? "like" : "unlike", undefined, databaseGeneration!);
    if (!mounted.current) return;
    setLiked(next);
    // Reanimated SharedValue is intentionally mutable on the UI thread.
    scale.value = withSequence(withSpring(1.45), withSpring(1));
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  });
  const submit = (selection: { answerIndex: number } | { correct: boolean }) => perform(async () => {
    if (!attempt || completed) return;
    const result = await submitQuizAnswer(post.id, attempt.sessionKey, selection, databaseGeneration!);
    if (!mounted.current) return;
    setAttempt(result);
    setRevealed(true);
    void Haptics.notificationAsync(
      result.correct
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning,
    ).catch(() => {});
  });
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
                const correct = completed && index === quiz.answerIndex;
                const wrong = answer === index && !correct;
                return (
                  <Pressable
                    key={index}
                    accessibilityRole="button"
                    disabled={disabled || completed}
                    onPress={() => submit({ answerIndex: index })}
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
                      disabled={disabled}
                      onPress={() => perform(async () => {
                        await recordAction(post.id, "reveal", undefined, databaseGeneration!);
                        if (mounted.current) setRevealed(true);
                      })}
                    >
                      <Text style={styles.revealText}>{t("reveal")}</Text>
                    </Pressable>
                  ) : (
                    <View style={styles.answer}>
                      <Text style={styles.choiceText}>{quiz.answerText}</Text>
                      <View style={styles.grade}>
                        <Pressable
                          disabled={disabled || completed}
                          accessibilityState={{ disabled: disabled || completed, selected: completed && attempt?.correct === true }}
                          onPress={() => submit({ correct: true })}
                        >
                          <Text style={styles.good}>{t("knew")}</Text>
                        </Pressable>
                        <Pressable
                          disabled={disabled || completed}
                          accessibilityState={{ disabled: disabled || completed, selected: completed && attempt?.correct === false }}
                          onPress={() => submit({ correct: false })}
                        >
                          <Text style={styles.bad}>{t("didntKnow")}</Text>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </>
              )}
              {completed && (
                <Text style={styles.source}>
                  {t("answerRecorded", { defaultValue: "回答を記録しました" })}
                  {" · "}
                  {attempt?.correct ? t("knew") : t("didntKnow")}
                </Text>
              )}
              {(completed || revealed) && (
                <Text style={styles.explanation}>{quiz.explanation}</Text>
              )}
            </View>
          )}
          {post.quiz_json && !quiz && (
            <Text style={styles.error}>{t("invalidQuiz", { defaultValue: "問題データを読み込めません。このカードは回答できません。" })}</Text>
          )}
          {loading && <Text style={styles.source}>{t("loading", { defaultValue: "読み込み中…" })}</Text>}
          {pending && <Text style={styles.source}>{t("savingAnswer", { defaultValue: "保存中…" })}</Text>}
          {error && (
            <View style={styles.feedback}>
              <Text style={styles.error}>
                {error === "load"
                  ? t("cardLoadFailed", { defaultValue: "学習状態を読み込めませんでした。" })
                  : t("cardSaveFailed", { defaultValue: "保存できませんでした。もう一度操作してください。" })}
              </Text>
              <Pressable disabled={pending || loading} onPress={() => { setLoading(true); setError(null); void loadState(); }}>
                <Text style={styles.retry}>{t("retry", { defaultValue: "再読み込み" })}</Text>
              </Pressable>
            </View>
          )}
          <Pressable accessibilityRole="button" onPress={() => router.push(`/source/${post.id}` as never)}>
            <Text style={styles.source}>
              {t("source")}: {post.source_anchor} ›
            </Text>
          </Pressable>
          <View style={styles.actions}>
            {showReplyAction && (
              <Action
                glyph="↩"
                label={t("askAi", { defaultValue: "AIに質問" })}
                accessibilityLabel={t("askAi", {
                  defaultValue: "AIに質問",
                })}
                active={false}
                disabled={disabled}
                onPress={() => perform(async () => {
                  await recordAction(post.id, "expand", undefined, databaseGeneration!);
                  if (mounted.current) router.push(`/post/${post.id}`);
                })}
              />
            )}
            <Action
              glyph={saved ? "▣" : "▢"}
              accessibilityLabel={t("save", { defaultValue: "保存" })}
              active={saved}
              disabled={disabled}
              onPress={() => perform(async () => {
                const next = !saved;
                await recordAction(post.id, next ? "save" : "unsave", undefined, databaseGeneration!);
                if (!mounted.current) return;
                setSaved(next);
                onBookmarkChange?.(post.id, next);
              })}
            />
            <Animated.View style={heartStyle}>
              <Action
                glyph={liked ? "♥" : "♡"}
                accessibilityLabel={t("like", { defaultValue: "いいね" })}
                active={liked}
                color={colors.red}
                disabled={disabled}
                onPress={toggleLike}
              />
            </Animated.View>
            <Action
              glyph="↗"
              accessibilityLabel={t("share", { defaultValue: "共有" })}
              active={false}
              disabled={disabled}
              onPress={() => perform(async () => {
                await Share.share({
                  message: `${post.text}\n${t("source")}: ${post.source_anchor}\nlearnstream://post/${post.id}`,
                });
              })}
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
  disabled = false,
  onPress,
}: {
  glyph: string;
  label?: string;
  accessibilityLabel: string;
  active: boolean;
  color?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      hitSlop={12}
      onPress={onPress}
      style={[styles.actionButton, disabled && styles.disabled]}
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
  disabled: { opacity: 0.5 },
  feedback: { gap: 6, marginTop: 8 },
  error: { color: colors.warning, marginTop: 8 },
  retry: { color: colors.blue, fontWeight: "700" },
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
