import type { SQLiteDatabase } from "expo-sqlite";
import { CONFIG } from "../core/config";
import type { PostRow } from "./database";

export type FeedOptions = { savedOnly?: boolean };
export type FeedCandidate = PostRow & {
  alpha: number;
  beta: number;
  stability_days: number;
  last_reviewed_at: number | null;
  theta: number;
};

// Keep counting and selection aligned, including disabled atoms and subjects.
const VISIBLE = "s.enabled=1 AND p.status!='discarded' AND (p.format='entertainment' OR a.enabled=1)";
const SAVED = "(SELECT action FROM interactions i WHERE i.post_id=p.id AND i.action IN ('save','unsave') ORDER BY i.created_at DESC,i.rowid DESC LIMIT 1)='save'";

export async function selectFeedCandidates(
  db: Pick<SQLiteDatabase, "getAllAsync">,
  subjectId?: string,
  options: FeedOptions = {},
  now = Date.now(),
): Promise<FeedCandidate[]> {
  const filter = subjectId ? "AND p.subject_id=? AND p.format!='entertainment'" : "";
  // Reserve an independent candidate budget for old due reviews. Their age
  // relative to stability is monotonic with the SRS urgency score.
  return db.getAllAsync<FeedCandidate>(
    `WITH eligible AS (
      SELECT p.*,s.display_name,s.handle,s.avatar_seed,
        COALESCE(a.source_anchor,'LearnStream') source_anchor,
        COALESCE(b.alpha,1) alpha,COALESCE(b.beta,1) beta,
        COALESCE(m.stability_days,1) stability_days,m.last_reviewed_at,
        COALESCE(t.theta,0) theta
      FROM posts p JOIN subjects s ON s.subject_id=p.subject_id
      LEFT JOIN atoms a ON a.atom_id=p.atom_id
      LEFT JOIN bandit_arms b ON b.topic_key=p.topic_key AND b.format=p.format
      LEFT JOIN atom_memory m ON m.atom_id=p.atom_id
      LEFT JOIN user_topic_state t ON t.topic_key=p.topic_key
      WHERE ${VISIBLE} ${filter} ${options.savedOnly ? `AND ${SAVED}` : ""}
    ), due AS (
      SELECT id FROM eligible WHERE format!='entertainment'
        AND last_reviewed_at IS NOT NULL
        AND (? - last_reviewed_at) >= MAX(stability_days,0.5) * ?
      ORDER BY (?-last_reviewed_at)/MAX(stability_days,0.5) DESC,id LIMIT 100
    ), fresh AS (
      SELECT id FROM eligible WHERE status='unread'
      ORDER BY is_rare_card DESC,created_at DESC,id LIMIT 150
    ), recent AS (
      SELECT id FROM eligible ORDER BY created_at DESC,id LIMIT 50
    ) SELECT * FROM eligible ${options.savedOnly ? "ORDER BY created_at DESC,id" : "WHERE id IN (SELECT id FROM due UNION SELECT id FROM fresh UNION SELECT id FROM recent)"}`,
    [...(subjectId ? [subjectId] : []), now,
      -Math.log(CONFIG.urgencyRetentionTarget) * 86_400_000, now],
  );
}

export async function countVisibleUnread(
  db: Pick<SQLiteDatabase, "getFirstAsync">,
  subjectId?: string,
): Promise<number> {
  const result = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) count FROM posts p JOIN subjects s ON s.subject_id=p.subject_id
     LEFT JOIN atoms a ON a.atom_id=p.atom_id WHERE ${VISIBLE} AND p.status='unread'
     ${subjectId ? "AND p.subject_id=? AND p.format!='entertainment'" : ""}`,
    subjectId ? [subjectId] : [],
  );
  return result?.count ?? 0;
}
