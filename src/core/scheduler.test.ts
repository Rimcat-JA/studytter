import { describe, expect, it } from "vitest";
import { assembleJobs, shouldFlagRareCard, weightedFormat } from "./scheduler";
import type { SchedulerAtom, SchedulerSubject } from "./types";
const subject: SchedulerSubject = {
  subjectId: "s",
  formatWeights: {
    explainer: 0,
    quiz: 0,
    funfact: 0,
    misconception: 0,
    comparison: 1,
    mnemonic: 0,
  },
};
const atom = (i: number, note: string | null = "contrast"): SchedulerAtom => ({
  atomId: `a${i}`,
  subjectId: "s",
  topicLabel: `t${i}`,
  core: `core${i}`,
  note,
  sourceAnchor: "p.1",
  urgency: i / 20,
  seenCount: i,
});
describe("scheduler", () => {
  it("filters comparison without note and falls back", () =>
    expect(weightedFormat(subject, atom(1, null), () => 0.5)).toBe(
      "explainer",
    ));
  it("chooses weighted format", () =>
    expect(weightedFormat(subject, atom(1), () => 0.5)).toBe("comparison"));
  it("returns fallback last allowed format", () => {
    const s = {
      ...subject,
      formatWeights: {
        explainer: 0,
        quiz: 0,
        funfact: 0,
        misconception: 0,
        comparison: 0,
        mnemonic: 1,
      },
    };
    expect(weightedFormat(s, atom(1), () => 1)).toBe("mnemonic");
  });
  it("assembles due, exploration and sampled jobs", () => {
    const jobs = assembleJobs({
      atoms: Array.from({ length: 20 }, (_, i) => atom(i)),
      subjects: [subject],
      arms: new Map(),
      count: 10,
      rng: (() => {
        let x = 0.1;
        return () => (x = (x + 0.137) % 1);
      })(),
    });
    expect(jobs).toHaveLength(10);
    expect(new Set(jobs.map((j) => j.atomId)).size).toBe(10);
    expect(jobs.some((j) => j.reason === "due")).toBe(true);
    expect(jobs.some((j) => j.reason === "exploration")).toBe(true);
    expect(jobs.some((j) => j.reason === "sampled")).toBe(true);
  });
  it("ignores missing subject and empty atoms", () => {
    expect(
      assembleJobs({
        atoms: [atom(1)],
        subjects: [],
        arms: new Map(),
        count: 1,
        rng: () => 0.5,
      }),
    ).toEqual([]);
    expect(
      assembleJobs({
        atoms: [],
        subjects: [subject],
        arms: new Map(),
        count: 3,
      }),
    ).toEqual([]);
  });
  it("flags rare cards from streak probability", () => {
    expect(shouldFlagRareCard(2, () => 0)).toBe(false);
    expect(shouldFlagRareCard(3, () => 0.1)).toBe(true);
    expect(shouldFlagRareCard(3, () => 0.2)).toBe(false);
    expect(shouldFlagRareCard(100, () => 0.34)).toBe(true);
  });
});
