import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureDatabaseGeneration, createId, getDb, getPost, type PostRow } from "../../src/db/database";
import { getPurposeRoute } from "../../src/llm/config";
import { streamDeepDive } from "../../src/llm/deepdive";
import {
  beginDeepDiveResponse,
  emptyDeepDiveThread,
  lastRetryableAssistant,
  promptHistoryBefore,
  restartDeepDiveResponse,
  safeErrorMessage,
  updateDeepDiveMessage,
  type DeepDiveMessage,
  type DeepDiveThread,
} from "../../src/services/deepdive-thread";
import {
  loadDeepDiveThread,
  saveDeepDiveThread,
} from "../../src/services/deepdives";
import PostCard, { Avatar } from "../../src/ui/PostCard";
import { Field, Header, Loading, Screen } from "../../src/ui/components";
import { colors } from "../../src/ui/theme";

type Cancellation = {
  generation: number;
  cancelled: boolean;
  controller: AbortController;
};

export default function PostDetail() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [post, setPost] = useState<PostRow | null>(null);
  const [core, setCore] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [thread, setThread] = useState<DeepDiveThread>(emptyDeepDiveThread);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const threadRef = useRef(thread);
  const cancellationRef = useRef<Cancellation | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const scrollRef = useRef<ScrollView>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const showThread = useCallback((next: DeepDiveThread) => {
    threadRef.current = next;
    if (mountedRef.current) setThread(next);
  }, []);

  const persistThread = useCallback(
    async (postId: string, next: DeepDiveThread, generation: number) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => saveDeepDiveThread(postId, next, generation));
      await saveQueueRef.current;
    },
    [],
  );

  const run = useCallback(
    async (
      currentPost: PostRow,
      existingThread: DeepDiveThread,
      atomCore: string,
      atomNote: string | null,
      options: { question?: string; retryAssistantId?: string } = {},
    ) => {
      if (cancellationRef.current) return;
      const generation = captureDatabaseGeneration();

      const { providerId: provider, model } = await getPurposeRoute("deepdive");
      const assistantId = options.retryAssistantId ?? createId("ddm");
      const started = options.retryAssistantId
        ? restartDeepDiveResponse(existingThread, assistantId, {
            providerId: provider,
            modelId: model,
          })
        : beginDeepDiveResponse(existingThread, {
            assistantId,
            userId: createId("ddm"),
            question: options.question,
            providerId: provider,
            modelId: model,
          }).thread;
      const cancellation: Cancellation = {
        generation,
        cancelled: false,
        controller: new AbortController(),
      };
      cancellationRef.current = cancellation;
      activeAssistantIdRef.current = assistantId;
      setStreaming(true);
      showThread(started);

      let answer = "";
      let lastPersistedAt = 0;
      try {
        // Persist the question and streaming placeholder before making a
        // network request, so a process kill cannot erase the user's turn.
        await persistThread(currentPost.id, started, generation);
        const history = promptHistoryBefore(started, assistantId);
        for await (const chunk of streamDeepDive({
          providerId: provider,
          model,
          personaName: currentPost.display_name,
          postText: currentPost.text,
          core: atomCore,
          note: atomNote,
          sourceAnchor: currentPost.source_anchor,
          history,
          abortSignal: cancellation.controller.signal,
          shouldStop: () => cancellation.cancelled,
          databaseGeneration: generation,
        })) {
          if (cancellation.cancelled) break;
          answer += chunk;
          const next = updateDeepDiveMessage(threadRef.current, assistantId, {
            text: answer,
            status: "streaming",
            updatedAt: Date.now(),
          });
          showThread(next);
          const now = Date.now();
          if (now - lastPersistedAt >= 300) {
            await persistThread(currentPost.id, next, generation);
            lastPersistedAt = now;
          }
        }

        if (cancellation.cancelled) {
          // `stop` already persisted the interruption. If another request has
          // started, this older stream must never overwrite its state.
          if (cancellationRef.current !== cancellation) return;
          const current = threadRef.current.messages.find(
            (message) => message.id === assistantId,
          );
          if (current?.status === "streaming") {
            const interrupted = updateDeepDiveMessage(
              threadRef.current,
              assistantId,
              {
                status: "interrupted",
                errorMessage: "Generation was stopped.",
                updatedAt: Date.now(),
              },
            );
            showThread(interrupted);
            await persistThread(currentPost.id, interrupted, generation);
          }
          return;
        }
        if (!answer.trim()) throw new Error("The provider returned no text.");

        const complete = updateDeepDiveMessage(threadRef.current, assistantId, {
          text: answer,
          status: "complete",
          errorMessage: undefined,
          updatedAt: Date.now(),
        });
        showThread(complete);
        await persistThread(currentPost.id, complete, generation);
      } catch (error) {
        if (cancellation.cancelled && cancellationRef.current !== cancellation)
          return;
        const status = cancellation.cancelled ? "interrupted" : "failed";
        const failed = updateDeepDiveMessage(threadRef.current, assistantId, {
          text: answer,
          status,
          errorMessage: cancellation.cancelled
            ? "Generation was stopped."
            : safeErrorMessage(error),
          updatedAt: Date.now(),
        });
        showThread(failed);
        try {
          await persistThread(currentPost.id, failed, generation);
        } catch {
          // The visible state still keeps the user's question and partial reply.
        }
      } finally {
        if (cancellationRef.current === cancellation) {
          cancellationRef.current = null;
          activeAssistantIdRef.current = null;
          if (mountedRef.current) setStreaming(false);
        }
      }
    },
    [persistThread, showThread],
  );

  const stop = useCallback(() => {
    const cancellation = cancellationRef.current;
    const assistantId = activeAssistantIdRef.current;
    if (!cancellation || !assistantId || !id) return;
    cancellation.cancelled = true;
    cancellation.controller.abort();
    const interrupted = updateDeepDiveMessage(threadRef.current, assistantId, {
      status: "interrupted",
      errorMessage: "Generation was stopped.",
      updatedAt: Date.now(),
    });
    showThread(interrupted);
    cancellationRef.current = null;
    activeAssistantIdRef.current = null;
    setStreaming(false);
    void persistThread(id, interrupted, cancellation.generation).catch(() => undefined);
  }, [id, persistThread, showThread]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const currentPost = await getPost(id);
      if (cancelled) return;
      setPost(currentPost);
      if (!currentPost) return;
      const db = await getDb();
      const atom = await db.getFirstAsync<{
        core: string;
        note: string | null;
      }>("SELECT core,note FROM atoms WHERE atom_id=?", currentPost.atom_id);
      const atomCore = atom?.core ?? currentPost.text;
      const atomNote = atom?.note ?? null;
      const storedThread = await loadDeepDiveThread(currentPost.id);
      if (cancelled) return;
      setCore(atomCore);
      setNote(atomNote);
      showThread(storedThread);
      // The design calls for a first explanation when reply is opened. A
      // failed/interrupted response is retained and offered for explicit retry.
      if (storedThread.messages.length === 0)
        void run(currentPost, storedThread, atomCore, atomNote);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, run, showThread]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cancellationRef.current) {
        cancellationRef.current.cancelled = true;
        cancellationRef.current.controller.abort();
      }
    };
  }, []);

  if (!post)
    return (
      <Screen>
        <Loading />
      </Screen>
    );

  const retryable = lastRetryableAssistant(thread);
  return (
    <Screen>
      <Header
        title={t("thread")}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("close", { defaultValue: "閉じる" })}
            onPress={() => router.back()}
          >
            <Text style={styles.close}>×</Text>
          </Pressable>
        }
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          <PostCard post={post} showReplyAction={false} />
          {thread.messages.map((message, index) => (
            <ThreadMessage
              key={message.id}
              message={message}
              isLast={index === thread.messages.length - 1}
              post={post}
            />
          ))}
          {retryable && !streaming && (
            <View style={styles.errorPanel}>
              <Text style={styles.errorTitle}>
                {retryable.status === "interrupted"
                  ? t("generationInterrupted", {
                      defaultValue: "回答の生成を停止しました",
                    })
                  : t("explanationFailed")}
              </Text>
              {retryable.status === "failed" && retryable.errorMessage && (
                <Text style={styles.errorText}>{retryable.errorMessage}</Text>
              )}
              <View style={styles.errorActions}>
                <Pressable
                  accessibilityRole="button"
                  style={styles.retryButton}
                  onPress={() =>
                    void run(post, threadRef.current, core, note, {
                      retryAssistantId: retryable.id,
                    })
                  }
                >
                  <Text style={styles.retryText}>
                    {t("retryAnswer", { defaultValue: "回答を再試行" })}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={styles.settingsButton}
                  onPress={() => router.push("/(tabs)/settings/providers")}
                >
                  <Text style={styles.settingsText}>
                    {t("openAiSettings", { defaultValue: "AI設定を開く" })}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
        <View
          style={[
            styles.composer,
            { paddingBottom: Math.max(10, insets.bottom) },
          ]}
        >
          <Field
            style={styles.input}
            value={question}
            onChangeText={setQuestion}
            placeholder={t("askMore")}
            editable={!streaming}
            multiline
            maxLength={2_000}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={() => {
              const asked = question.trim();
              if (!asked || streaming) return;
              setQuestion("");
              void run(post, threadRef.current, core, note, {
                question: asked,
              });
            }}
          />
          {streaming ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("stopGenerating", {
                defaultValue: "生成を停止",
              })}
              onPress={stop}
              style={[styles.sendButton, styles.stopButton]}
            >
              <Text style={styles.stopGlyph}>■</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("send", { defaultValue: "送信" })}
              disabled={!question.trim()}
              onPress={() => {
                const asked = question.trim();
                if (!asked) return;
                setQuestion("");
                void run(post, threadRef.current, core, note, {
                  question: asked,
                });
              }}
              style={styles.sendButton}
            >
              <Text
                style={[styles.sendGlyph, !question.trim() && styles.disabled]}
              >
                ↑
              </Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function ThreadMessage({
  message,
  isLast,
  post,
}: {
  message: DeepDiveMessage;
  isLast: boolean;
  post: PostRow;
}) {
  const { t } = useTranslation();
  const fallback =
    message.status === "streaming"
      ? "…"
      : message.status === "failed"
        ? t("explanationFailed")
        : "";
  return (
    <View style={styles.turn}>
      <View style={styles.line} />
      {message.role === "assistant" ? (
        <Avatar seed={post.avatar_seed} name={post.display_name} size={36} />
      ) : (
        <View style={styles.you}>
          <Text style={styles.youText}>{t("you").slice(0, 1)}</Text>
        </View>
      )}
      <View style={styles.messageBody}>
        <Text style={styles.role}>
          {message.role === "assistant" ? post.display_name : t("you")}
        </Text>
        <Text style={styles.turnText}>{message.text || fallback}</Text>
        {message.role === "assistant" && isLast && (
          <Text style={styles.anchor}>
            {t("source")}: {post.source_anchor}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  close: { fontSize: 30, color: colors.text },
  scrollContent: { paddingBottom: 20 },
  turn: { flexDirection: "row", gap: 10, padding: 14, position: "relative" },
  line: {
    position: "absolute",
    left: 34,
    top: -14,
    height: 20,
    width: 2,
    backgroundColor: colors.line,
  },
  you: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  youText: { color: colors.text, fontSize: 12, fontWeight: "800" },
  messageBody: { flex: 1 },
  role: { color: colors.text, fontWeight: "900", marginBottom: 4 },
  turnText: { color: colors.text, fontSize: 16, lineHeight: 23 },
  anchor: { color: colors.blue, fontSize: 12, marginTop: 10 },
  errorPanel: {
    marginHorizontal: 14,
    marginBottom: 14,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.red,
    borderRadius: 14,
    backgroundColor: "#35131f",
  },
  errorTitle: { color: colors.text, fontSize: 15, fontWeight: "900" },
  errorText: { color: colors.muted, lineHeight: 20 },
  errorActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  retryButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.blue,
  },
  retryText: { color: colors.white, fontWeight: "900" },
  settingsButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line,
  },
  settingsText: { color: colors.text, fontWeight: "800" },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    padding: 10,
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.bg,
    alignItems: "flex-end",
  },
  input: { flex: 1, maxHeight: 120, paddingTop: 13, paddingBottom: 13 },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blue,
    marginBottom: 4,
  },
  stopButton: { backgroundColor: colors.surfaceAlt },
  sendGlyph: {
    color: colors.white,
    fontSize: 22,
    fontWeight: "900",
  },
  stopGlyph: { color: colors.text, fontSize: 14 },
  disabled: { opacity: 0.35 },
});
