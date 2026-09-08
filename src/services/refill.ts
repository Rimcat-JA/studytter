import { assembleJobs } from "../core/scheduler";
import { urgency } from "../core/srs";
import type {
  BanditArmState,
  GenerationJob,
  SchedulerSubject,
} from "../core/types";
import { captureDatabaseGeneration, getDbForGeneration } from "../db/database";

export async function buildRefillJobs(count: number, subjectId?: string, generation = captureDatabaseGeneration()): Promise<GenerationJob[]> {
  const db = await getDbForGeneration(generation);
  const atoms = await db.getAllAsync<{
    atom_id: string;
    subject_id: string;
    topic_label: string;
    core: string;
    note: string | null;
    source_anchor: string;
    stability_days: number;
    last_reviewed_at: number | null;
    seen_count: number;
  }>(
    `SELECT a.atom_id,a.subject_id,a.topic_label,a.core,a.note,a.source_anchor,COALESCE(m.stability_days,1) stability_days,m.last_reviewed_at,(SELECT COUNT(*) FROM posts p WHERE p.atom_id=a.atom_id AND p.status!='discarded') seen_count FROM atoms a LEFT JOIN atom_memory m ON m.atom_id=a.atom_id JOIN subjects s ON s.subject_id=a.subject_id WHERE a.enabled=1 AND s.enabled=1 ${subjectId ? "AND a.subject_id=?" : ""}`,
    subjectId ? [subjectId] : [],
  );
  const subjects = await db.getAllAsync<{
    subject_id: string;
    format_weights_json: string;
  }>(`SELECT subject_id,format_weights_json FROM subjects WHERE enabled=1 ${subjectId ? "AND subject_id=?" : ""}`, subjectId ? [subjectId] : []);
  const arms = await db.getAllAsync<{
    topic_key: string;
    format: string;
    alpha: number;
    beta: number;
  }>("SELECT * FROM bandit_arms");
  const armMap = new Map<string, BanditArmState>(
    arms.map((a) => [
      `${a.topic_key}:${a.format}`,
      { alpha: a.alpha, beta: a.beta },
    ]),
  );
  const jobs = assembleJobs({
    count,
    atoms: atoms.map((a) => ({
      atomId: a.atom_id,
      subjectId: a.subject_id,
      topicLabel: a.topic_label,
      core: a.core,
      note: a.note,
      sourceAnchor: a.source_anchor,
      urgency: urgency({
        stabilityDays: a.stability_days,
        lastReviewedAt: a.last_reviewed_at,
      }),
      seenCount: a.seen_count,
    })),
    subjects: subjects.map(
      (s) =>
        ({
          subjectId: s.subject_id,
          formatWeights: JSON.parse(s.format_weights_json),
        }) as SchedulerSubject,
    ),
    arms: armMap,
  });
  const interactions = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM interactions",
  );
  if ((interactions?.count ?? 0) >= 50) {
    const target = Math.ceil(jobs.length * 0.2);
    let quizzes = jobs.filter((job) => job.format === "quiz").length;
    for (const job of jobs) {
      if (quizzes >= target) break;
      if (job.format !== "quiz") {
        job.format = "quiz";
        quizzes++;
      }
    }
  }
  return jobs;
}
