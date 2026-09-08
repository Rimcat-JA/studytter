import React from "react";
import { Pressable, Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostRow } from "../db/database";
import PostCard from "./PostCard";

const service = vi.hoisted(() => ({ state: vi.fn(), action: vi.fn(), submit: vi.fn(), push: vi.fn() }));
vi.mock("../services/interactions", () => ({
  getPostInteractionState: service.state,
  recordAction: service.action,
  submitQuizAnswer: service.submit,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: service.push }) }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => { throw new Error("Haptics unavailable"); },
  notificationAsync: async () => { throw new Error("Haptics unavailable"); },
  ImpactFeedbackStyle: { Light: "light", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key, i18n: { language: "ja" } }) }));
vi.mock("react-native", () => ({
  View: "View", Text: "Text", Pressable: "Pressable",
  Share: { share: async () => ({}) },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: { View: "View" },
    useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedStyle: (callback: () => unknown) => callback(),
    cancelAnimation: () => {},
    withRepeat: (value: unknown) => value,
    withSequence: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});

const emptyAttempt = { sessionKey: "initial:p1", completed: false, answerIndex: null, correct: null, nextReviewAt: null };
const savedAttempt = { sessionKey: "initial:p1", completed: true, answerIndex: 0, correct: true, nextReviewAt: Date.now() + 100_000 };
const quiz = { question: "1 + 1?", choices: ["2", "3"], answerIndex: 0, answerText: "2", explanation: "Addition" };
const post = (id: string, quizData: unknown = quiz): PostRow => ({
  id, subject_id: "s", atom_id: "a", topic_key: "topic", format: "quiz", persona_id: "p", text: `Post ${id}`,
  quiz_json: JSON.stringify(quizData), difficulty_b: 0, status: "unread", is_rare_card: 0, created_at: Date.now(),
  display_name: "Math", handle: "@math", avatar_seed: "math", source_anchor: "p.1",
});
let renderer: ReactTestRenderer | undefined;
const visible = () => JSON.stringify(renderer!.toJSON());
const button = (label: string) => renderer!.root.findAll((node) =>
  node.type === Pressable && node.findAll((child) => child.type === Text && child.props.children === label).length > 0,
)[0];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  service.state.mockResolvedValue({ databaseGeneration: 0, liked: false, saved: false, attempt: emptyAttempt });
  service.action.mockResolvedValue(undefined);
  service.submit.mockResolvedValue(savedAttempt);
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
});

describe("PostCard recycling and recovery", () => {
  it("resets a recycled card and restores each post's durable answer and bookmark", async () => {
    service.state.mockImplementation(async (id: string) => id === "p1"
      ? { databaseGeneration: 0, liked: true, saved: true, attempt: savedAttempt }
      : { databaseGeneration: 0, liked: false, saved: false, attempt: { ...emptyAttempt, sessionKey: "initial:p2" } });
    await act(async () => { renderer = create(<PostCard post={post("p1")} />); });
    expect(visible()).toContain("回答を記録しました");
    expect(visible()).toContain("♥");
    expect(visible()).toContain("▣");
    await act(async () => { renderer!.update(<PostCard post={post("p2")} />); });
    expect(visible()).not.toContain("回答を記録しました");
    expect(visible()).toContain("♡");
    expect(visible()).toContain("▢");
    expect(button("2").props.disabled).toBe(false);
    await act(async () => { renderer!.update(<PostCard post={post("p1")} />); });
    expect(visible()).toContain("回答を記録しました");
    expect(button("2").props.disabled).toBe(true);
  });

  it("ignores a late state lookup belonging to the previous recycled post", async () => {
    let finish!: (value: unknown) => void;
    service.state.mockImplementation((id: string) => id === "p1"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ databaseGeneration: 0, liked: false, saved: false, attempt: emptyAttempt }));
    await act(async () => { renderer = create(<PostCard post={post("p1")} />); });
    await act(async () => { renderer!.update(<PostCard post={post("p2")} />); });
    await act(async () => { finish({ databaseGeneration: 0, liked: true, saved: true, attempt: savedAttempt }); });
    expect(visible()).toContain("Post p2");
    expect(visible()).not.toContain("回答を記録しました");
    expect(visible()).toContain("♡");
    expect(button("2").props.disabled).toBe(false);
  });

  it("prevents rapid self grading and keeps retry available if persistence fails", async () => {
    const selfQuiz = { question: "Explain addition", answerText: "Combining quantities", explanation: "Example" };
    await act(async () => { renderer = create(<PostCard post={post("p1", selfQuiz)} />); });
    await act(async () => { await button("reveal").props.onPress(); });
    service.submit.mockRejectedValueOnce(new Error("Disk full"));
    await act(async () => { await button("knew").props.onPress(); });
    expect(visible()).toContain("保存できませんでした");
    expect(button("knew").props.disabled).toBe(false);
    await act(async () => {
      const grade = button("knew").props.onPress;
      await Promise.all([grade(), grade()]);
    });
    expect(service.submit).toHaveBeenCalledTimes(2);
    expect(button("knew").props.disabled).toBe(true);
    expect(button("didntKnow").props.disabled).toBe(true);
    expect(visible()).toContain("回答を記録しました");
  });

  it("renders malformed stored quiz JSON without crashing", async () => {
    await act(async () => { renderer = create(<PostCard post={{ ...post("p1"), quiz_json: "{bad" }} />); });
    expect(visible()).toContain("問題データを読み込めません");
    expect(visible()).toContain("Post p1");
  });
});
