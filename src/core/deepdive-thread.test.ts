import { describe, expect, it, vi } from "vitest";
import {
  buildDeepDiveConversation,
  formatDeepDivePrompt,
} from "../llm/deepdive";
import {
  beginDeepDiveResponse,
  emptyDeepDiveThread,
  lastRetryableAssistant,
  parseDeepDiveThread,
  promptHistoryBefore,
  restartDeepDiveResponse,
  safeErrorMessage,
  updateDeepDiveMessage,
} from "../services/deepdive-thread";

vi.mock("../llm/provider", () => ({ createProvider: vi.fn() }));
vi.mock("../llm/usage", () => ({ logUsage: vi.fn() }));

describe("deep-dive thread persistence", () => {
  it("migrates the original turn array into the v2 envelope", () => {
    const result = parseDeepDiveThread(
      JSON.stringify([
        { role: "assistant", text: "First explanation" },
        { role: "user", text: "Why?" },
      ]),
      1_000,
    );

    expect(result.invalid).toBe(false);
    expect(result.shouldPersist).toBe(true);
    expect(result.thread.schemaVersion).toBe(2);
    expect(result.thread.messages).toMatchObject([
      { role: "assistant", text: "First explanation", status: "complete" },
      { role: "user", text: "Why?", status: "complete" },
    ]);
  });

  it("falls back safely for corrupt or structurally invalid JSON", () => {
    expect(parseDeepDiveThread("not json").thread.messages).toEqual([]);
    const wrongShape = parseDeepDiveThread('{"messages":"wrong"}');
    expect(wrongShape.invalid).toBe(true);
    expect(wrongShape.shouldPersist).toBe(true);
    expect(wrongShape.thread).toEqual(emptyDeepDiveThread());
  });

  it("turns a stale streaming response into a retryable interruption", () => {
    const result = parseDeepDiveThread(
      JSON.stringify({
        schemaVersion: 2,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "partial",
            status: "streaming",
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      }),
      30,
    );

    expect(result.shouldPersist).toBe(true);
    expect(result.thread.messages[0]).toMatchObject({
      text: "partial",
      status: "interrupted",
      updatedAt: 30,
    });
  });

  it("adds the user turn and provider-scoped streaming placeholder together", () => {
    const result = beginDeepDiveResponse(emptyDeepDiveThread(), {
      assistantId: "assistant-1",
      userId: "user-1",
      question: "  What does this mean?  ",
      providerId: "nanogpt",
      modelId: "model-a",
      now: 100,
    });

    expect(result.thread.messages).toMatchObject([
      {
        id: "user-1",
        role: "user",
        text: "What does this mean?",
        status: "complete",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "",
        status: "streaming",
        providerId: "nanogpt",
        modelId: "model-a",
      },
    ]);
  });

  it("excludes failed assistant text while retaining its user question", () => {
    let thread = beginDeepDiveResponse(emptyDeepDiveThread(), {
      assistantId: "assistant-1",
      userId: "user-1",
      question: "Question one",
      providerId: "openai",
      modelId: "model-a",
      now: 100,
    }).thread;
    thread = updateDeepDiveMessage(thread, "assistant-1", {
      text: "unreliable partial",
      status: "failed",
      updatedAt: 101,
    });
    const second = beginDeepDiveResponse(thread, {
      assistantId: "assistant-2",
      userId: "user-2",
      question: "Question two",
      providerId: "openai",
      modelId: "model-a",
      now: 102,
    }).thread;

    expect(promptHistoryBefore(second, "assistant-2")).toEqual([
      { role: "user", text: "Question one" },
      { role: "user", text: "Question two" },
    ]);
  });

  it("resets a failed response for retry without duplicating the question", () => {
    let thread = beginDeepDiveResponse(emptyDeepDiveThread(), {
      assistantId: "assistant-1",
      userId: "user-1",
      question: "Only once",
      providerId: "openai",
      modelId: "old-model",
      now: 100,
    }).thread;
    thread = updateDeepDiveMessage(thread, "assistant-1", {
      text: "partial",
      status: "failed",
      errorMessage: "temporary",
      updatedAt: 101,
    });
    thread = restartDeepDiveResponse(thread, "assistant-1", {
      providerId: "anthropic",
      modelId: "new-model",
      now: 102,
    });

    expect(
      thread.messages.filter((message) => message.role === "user"),
    ).toHaveLength(1);
    expect(thread.messages[1]).toMatchObject({
      text: "",
      status: "streaming",
      providerId: "anthropic",
      modelId: "new-model",
    });
    expect(lastRetryableAssistant(thread)).toBeNull();
  });

  it("only offers retry when the latest assistant response needs it", () => {
    const failed = {
      id: "failed",
      role: "assistant" as const,
      text: "",
      status: "failed" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const complete = {
      ...failed,
      id: "complete",
      text: "done",
      status: "complete" as const,
      createdAt: 2,
      updatedAt: 2,
    };
    expect(
      lastRetryableAssistant({
        schemaVersion: 2,
        messages: [failed, complete],
      }),
    ).toBeNull();
  });

  it("redacts API-key-shaped values from stored errors", () => {
    expect(safeErrorMessage(new Error("bad sk-test-secretvalue123"))).toBe(
      "bad [redacted]",
    );
  });
});

describe("deep-dive model conversation", () => {
  it("adds the initial explanation request only to an empty conversation", () => {
    const turns = buildDeepDiveConversation({ history: [] });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");
  });

  it("does not duplicate a persisted final user question", () => {
    expect(
      buildDeepDiveConversation({
        history: [{ role: "user", text: "Why?" }],
      }),
    ).toEqual([{ role: "user", text: "Why?" }]);
  });

  it("formats ordered role turns separately from source context", () => {
    const prompt = formatDeepDivePrompt({
      postText: "Post",
      core: "Core",
      sourceAnchor: "p. 4",
      history: [{ role: "assistant", text: "Earlier" }],
      question: "Follow-up",
    });
    expect(prompt).toContain("SOURCE_CONTEXT");
    expect(prompt).toContain('ASSISTANT: "Earlier"');
    expect(prompt).toContain('USER: "Follow-up"');
    expect(prompt.match(/Follow-up/g)).toHaveLength(1);
  });
});
