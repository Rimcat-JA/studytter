import { describe, expect, it } from "vitest";
import {
  freshness,
  interleave,
  rankPosts,
  redundancyPenalty,
  scorePost,
} from "./ranker";
import type { RankablePost } from "./types";
const now = 8 * 86400000;
const post = (
  id: string,
  subjectId = "a",
  format: RankablePost["format"] = "explainer",
): RankablePost => ({
  id,
  subjectId,
  atomId: id,
  topicKey: `${subjectId}:topic`,
  format,
  difficultyB: 0,
  createdAt: now,
  engagement: 0.5,
  urgency: 0.5,
  difficultyFit: 0.5,
});
describe("ranker", () => {
  it("decays freshness", () => {
    expect(freshness(now, now)).toBe(1);
    expect(freshness(0, now)).toBe(0);
    expect(freshness(now - 4 * 86400000, now)).toBeCloseTo(0.5);
  });
  it("penalizes repeated atoms and topics", () => {
    const p = post("x");
    expect(redundancyPenalty(p, [p])).toBe(1);
    const other = { ...post("y"), atomId: "y" };
    expect(redundancyPenalty(p, [other, other, other])).toBe(0.5);
    expect(redundancyPenalty(p, [])).toBe(0);
  });
  it("scores and sorts", () => {
    const low = { ...post("low"), engagement: 0, urgency: 0, difficultyFit: 0 };
    const high = post("high");
    expect(scorePost(high, [], now)).toBeGreaterThan(scorePost(low, [], now));
    expect(rankPosts([low, high], [], now)[0].post.id).toBe("high");
  });
  it("limits consecutive subjects", () => {
    const ranked = rankPosts(
      [post("a1"), post("a2"), post("a3"), post("b1", "b")],
      [],
      now,
    );
    const out = interleave(ranked, 0);
    expect(out.slice(0, 3).map((p) => p.subjectId)).not.toEqual([
      "a",
      "a",
      "a",
    ]);
  });
  it("retains the quiz ratio after enough interactions", () => {
    const ranked = rankPosts(
      [post("a1"), post("a2"), post("q", "a", "quiz"), post("b1", "b")],
      [],
      now,
    );
    expect(
      interleave(ranked, 55).filter((p) => p.format === "quiz"),
    ).toHaveLength(1);
  });
  it("injects an entertainment break after a jittered interval", () => {
    const learning = Array.from({ length: 10 }, (_, i) =>
      post(`p${i}`, i % 2 ? "a" : "b"),
    );
    const out = interleave(
      rankPosts([...learning, post("break", "a", "entertainment")]),
      0,
      () => 0,
    );
    expect(out[8].format).toBe("entertainment");
  });
  it("falls back when only one subject exists", () =>
    expect(
      interleave(rankPosts([post("a"), post("b"), post("c")]), 0),
    ).toHaveLength(3));
});
