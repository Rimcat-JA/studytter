import { describe, expect, it } from "vitest";
import { QuizSchema, validateGeneratedPosts } from "./schemas";

const quiz = { question: "2 + 2?", choices: ["3", "4"], answerIndex: 1, answerText: "4", explanation: "Two pairs make four." };

describe("quiz invariants", () => {
  it("accepts a valid choice and a self-graded answer", () => {
    expect(QuizSchema.safeParse(quiz).success).toBe(true);
    expect(QuizSchema.safeParse({ question: "Recall four", answerText: "4", explanation: "Four." }).success).toBe(true);
  });
  it.each([
    { ...quiz, answerIndex: 2 }, { ...quiz, answerIndex: undefined },
    { ...quiz, choices: undefined }, { ...quiz, choices: ["4", " 4 "] },
    { ...quiz, question: " " }, { ...quiz, answerText: " " },
    { ...quiz, choices: ["", "4"] },
  ])("rejects unanswerable questions %#", (value) => {
    expect(QuizSchema.safeParse(value).success).toBe(false);
  });
  it("validates the complete requested batch before persistence", () => {
    expect(() => validateGeneratedPosts({ posts: [{ jobIndex: 0, text: "Question" }] }, ["quiz"])).toThrow(/quiz is required/);
    expect(() => validateGeneratedPosts({ posts: [{ jobIndex: 1, text: "Question", quiz }] }, ["quiz"])).toThrow(/exactly once/);
    expect(validateGeneratedPosts({ posts: [{ jobIndex: 0, text: "Question", quiz }] }, ["explainer"]).posts[0].quiz).toBeUndefined();
    expect(validateGeneratedPosts({ posts: [{ jobIndex: 0, text: "Question", quiz }] }, ["quiz"]).posts).toHaveLength(1);
  });
});
