import { z } from "zod";
import type { ProviderId } from "../llm/provider";

export const DeepDiveMessageStatusSchema = z.enum([
  "streaming",
  "complete",
  "failed",
  "interrupted",
]);

export const DeepDiveMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: DeepDiveMessageStatusSchema,
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  providerId: z.enum(["anthropic", "openai", "nanogpt", "openrouter", "gemini", "custom", "ollama"]).optional(),
  modelId: z.string().min(1).optional(),
  errorMessage: z.string().optional(),
});

export const DeepDiveThreadSchema = z.object({
  schemaVersion: z.literal(2),
  messages: z.array(DeepDiveMessageSchema),
});

const LegacyTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

const LegacyThreadSchema = z.array(LegacyTurnSchema);

export type DeepDiveMessage = z.infer<typeof DeepDiveMessageSchema>;
export type DeepDiveMessageStatus = z.infer<typeof DeepDiveMessageStatusSchema>;
export type DeepDiveThread = z.infer<typeof DeepDiveThreadSchema>;
export type DeepDivePromptTurn = Pick<DeepDiveMessage, "role" | "text">;

export type ParsedDeepDiveThread = {
  thread: DeepDiveThread;
  /** True when the normalized value should be written back to SQLite. */
  shouldPersist: boolean;
  /** True only when stored data existed but could not be safely decoded. */
  invalid: boolean;
};

export function emptyDeepDiveThread(): DeepDiveThread {
  return { schemaVersion: 2, messages: [] };
}

/**
 * Decode both the original raw turn array and the v2 envelope. A stale
 * `streaming` message means the process was interrupted, so it is made
 * explicitly retryable during load.
 */
export function parseDeepDiveThread(
  raw: string | null | undefined,
  now = Date.now(),
): ParsedDeepDiveThread {
  if (!raw) {
    return {
      thread: emptyDeepDiveThread(),
      shouldPersist: false,
      invalid: false,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      thread: emptyDeepDiveThread(),
      shouldPersist: true,
      invalid: true,
    };
  }

  const current = DeepDiveThreadSchema.safeParse(value);
  if (current.success) {
    let changed = false;
    const messages = current.data.messages.map((message) => {
      if (message.status !== "streaming") return message;
      changed = true;
      return {
        ...message,
        status: "interrupted" as const,
        updatedAt: now,
        errorMessage: message.errorMessage ?? "Generation was interrupted.",
      };
    });
    return {
      thread: { schemaVersion: 2, messages },
      shouldPersist: changed,
      invalid: false,
    };
  }

  const legacy = LegacyThreadSchema.safeParse(value);
  if (legacy.success) {
    return {
      thread: {
        schemaVersion: 2,
        messages: legacy.data.map((turn, index) => ({
          id: `legacy_${now}_${index}`,
          role: turn.role,
          text: turn.text,
          status: "complete",
          createdAt: now + index,
          updatedAt: now + index,
        })),
      },
      shouldPersist: true,
      invalid: false,
    };
  }

  return {
    thread: emptyDeepDiveThread(),
    shouldPersist: true,
    invalid: true,
  };
}

export function beginDeepDiveResponse(
  thread: DeepDiveThread,
  options: {
    assistantId: string;
    userId?: string;
    question?: string;
    providerId: ProviderId;
    modelId: string;
    now?: number;
  },
): { thread: DeepDiveThread; assistantId: string } {
  const now = options.now ?? Date.now();
  const messages = [...thread.messages];
  if (options.question?.trim()) {
    messages.push({
      id: options.userId ?? `${options.assistantId}_user`,
      role: "user",
      text: options.question.trim(),
      status: "complete",
      createdAt: now,
      updatedAt: now,
    });
  }
  messages.push({
    id: options.assistantId,
    role: "assistant",
    text: "",
    status: "streaming",
    providerId: options.providerId,
    modelId: options.modelId,
    createdAt: now + (options.question?.trim() ? 1 : 0),
    updatedAt: now,
  });
  return {
    thread: { schemaVersion: 2, messages },
    assistantId: options.assistantId,
  };
}

export function restartDeepDiveResponse(
  thread: DeepDiveThread,
  assistantId: string,
  options: { providerId: ProviderId; modelId: string; now?: number },
): DeepDiveThread {
  return updateDeepDiveMessage(thread, assistantId, {
    text: "",
    status: "streaming",
    providerId: options.providerId,
    modelId: options.modelId,
    errorMessage: undefined,
    updatedAt: options.now ?? Date.now(),
  });
}

export function updateDeepDiveMessage(
  thread: DeepDiveThread,
  messageId: string,
  patch: Partial<Omit<DeepDiveMessage, "id" | "role" | "createdAt">>,
): DeepDiveThread {
  return {
    schemaVersion: 2,
    messages: thread.messages.map((message) =>
      message.id === messageId ? { ...message, ...patch } : message,
    ),
  };
}

/**
 * Return model context before the response being generated. Failed and
 * interrupted assistant output is deliberately excluded from future prompts.
 */
export function promptHistoryBefore(
  thread: DeepDiveThread,
  assistantId: string,
  maxTurns = 20,
): DeepDivePromptTurn[] {
  const responseIndex = thread.messages.findIndex(
    (message) => message.id === assistantId,
  );
  const preceding = thread.messages.slice(
    0,
    responseIndex < 0 ? thread.messages.length : responseIndex,
  );
  return preceding
    .filter(
      (message) =>
        message.status === "complete" && message.text.trim().length > 0,
    )
    .slice(-Math.max(1, maxTurns))
    .map(({ role, text }) => ({ role, text }));
}

export function lastRetryableAssistant(
  thread: DeepDiveThread,
): DeepDiveMessage | null {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index];
    if (message.role !== "assistant") continue;
    return message.status === "failed" || message.status === "interrupted"
      ? message
      : null;
  }
  return null;
}

export function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]").slice(0, 500);
}
