import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  computeGenerationBackoffMs,
} from "./autogeneration";
import { rewardFromInteractions, sampleBeta } from "./bandit";
import { interleave, rankPosts } from "./ranker";
import { assembleJobs } from "./scheduler";
import { DAY_MS, reviewMemory } from "./srs";
import type { RankablePost, SchedulerAtom, SchedulerSubject } from "./types";

const now = 8 * DAY_MS;
const post = (
  id: string,
  subjectId: string,
  format: RankablePost["format"],
  engagement: number,
): RankablePost => ({
  id,
  subjectId,
  atomId: id,
  topicKey: `${subjectId}:t`,
  format,
  difficultyB: 0,
  createdAt: now,
  engagement,
  urgency: 0,
  difficultyFit: 0,
});

describe("core regressions", () => {
  it("does not count retracted likes or saves as reward", () => {
    expect(rewardFromInteractions([{ action: "like" }, { action: "unlike" }])).toBe(0);
    expect(rewardFromInteractions([{ action: "unlike" }, { action: "like" }])).toBe(1);
    expect(
      rewardFromInteractions([{ action: "save" }, { action: "unsave" }, { action: "expand" }]),
    ).toBe(0.8);
  });

  it("never returns NaN from sampleBeta for tiny shapes", () => {
    for (let i = 0; i < 2_000; i++)
      expect(Number.isFinite(sampleBeta(0.001, 0.001))).toBe(true);
  });

  it("keeps the Thompson-sampled format for the generated job", () => {
    const subject: SchedulerSubject = {
      subjectId: "s",
      formatWeights: { explainer: 1, quiz: 1, funfact: 0, misconception: 0, comparison: 0, mnemonic: 0 },
    };
    const atoms: SchedulerAtom[] = Array.from({ length: 10 }, (_, i) => ({
      atomId: `a${i}`, subjectId: "s", topicLabel: "T", core: "c", sourceAnchor: "p.1",
      urgency: 0, seenCount: 5, reviewed: false,
    }));
    const arms = new Map([
      ["s:T:quiz", { alpha: 1000, beta: 1 }],
      ["s:T:explainer", { alpha: 1, beta: 1000 }],
    ]);
    let quizzes = 0;
    for (let i = 0; i < 200; i++) {
      const [job] = assembleJobs({ atoms, subjects: [subject], arms, count: 1 });
      if (job.format === "quiz") quizzes++;
    }
    expect(quizzes).toBeGreaterThan(190);
  });

  it("fills the due bucket with reviewed atoms instead of never-reviewed ones", () => {
    const subject: SchedulerSubject = {
      subjectId: "s",
      formatWeights: { explainer: 1, quiz: 0, funfact: 0, misconception: 0, comparison: 0, mnemonic: 0 },
    };
    const fresh = Array.from({ length: 10 }, (_, i): SchedulerAtom => ({
      atomId: `new${i}`, subjectId: "s", topicLabel: "T", core: "c", sourceAnchor: "p.1",
      urgency: 1, seenCount: 0, reviewed: false,
    }));
    const overdue: SchedulerAtom = { ...fresh[0], atomId: "overdue", urgency: 0.94, seenCount: 3, reviewed: true };
    const jobs = assembleJobs({ atoms: [...fresh, overdue], subjects: [subject], arms: new Map(), count: 4 });
    expect(jobs.find((job) => job.reason === "due")?.atomId).toBe("overdue");
  });

  it("spreads quizzes without moving top posts to the end or breaking subject runs", () => {
    const posts = [
      ...Array.from({ length: 10 }, (_, i) => post(`q${i}`, "A", "quiz", 0)),
      ...Array.from({ length: 40 }, (_, i) => post(`p${i}`, i % 2 ? "B" : "A", "explainer", 1 - i / 100)),
    ];
    const out = interleave(rankPosts(posts, [], now), 60, () => 0.99);
    const learning = out.filter((p) => p.format !== "entertainment");
    expect(learning.slice(0, 5).map((p) => p.id)).toContain("p0");
    for (let i = 0; i + 5 <= 25; i++)
      expect(learning.slice(i, i + 5).some((p) => p.format === "quiz")).toBe(true);
    for (let i = 2; i < learning.length; i++) {
      const run = learning.slice(i - 2, i + 1).map((p) => p.subjectId);
      if (learning.slice(i).some((p) => p.subjectId !== run[0]))
        expect(new Set(run).size).toBeGreaterThan(1);
    }
  });

  it("does not compound stability for massed correct answers", () => {
    let memory = { stabilityDays: 1, lastReviewedAt: null as number | null, reviewCount: 0, lapseCount: 0 };
    memory = reviewMemory(memory, true, now);
    for (let i = 1; i <= 4; i++) memory = reviewMemory(memory, true, now + i * 10_000);
    expect(memory.stabilityDays).toBeLessThan(2.3);
    const spaced = reviewMemory({ ...memory, lastReviewedAt: now }, true, now + 3 * DAY_MS);
    expect(spaced.stabilityDays).toBeCloseTo(memory.stabilityDays * 2.2);
  });

  it("treats explicit 429/5xx as transient even when the body mentions an API key", () => {
    expect(
      classifyGenerationError({ status: 429, message: "Rate limit exceeded for API key sk-x" }),
    ).toMatchObject({ code: "rate_limit", retryable: true });
    expect(
      classifyGenerationError({ status: 503, message: "authentication backend temporarily unavailable" }),
    ).toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("keeps jittered backoff under the six-hour ceiling", () => {
    expect(computeGenerationBackoffMs(99, undefined, () => 0.999)).toBeLessThanOrEqual(6 * 60 * 60_000);
  });
});

describe("feed redundancy", () => {
  it("does not place a post right after another post of the same atom when an alternative exists", () => {
    const explainer = { ...post("e", "A", "explainer", 0.9), atomId: "atom1" };
    const quiz = { ...post("q", "A", "quiz", 0.88), atomId: "atom1" };
    const other = { ...post("o", "B", "explainer", 0.85), atomId: "atom2" };
    const out = interleave(rankPosts([explainer, quiz, other], [], now), 0);
    expect(out.map((p) => p.id)).toEqual(["e", "o", "q"]);
  });
});
