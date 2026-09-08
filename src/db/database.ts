import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import { DatabaseCoordinator } from "./coordinator";
import { selectFeedCandidates } from "./feed-candidates";
export { DatabaseReplacedError } from "./coordinator";

export type SubjectRow = {
  subject_id: string;
  display_name: string;
  handle: string;
  avatar_seed: string;
  content_lang: string;
  domain_style: string;
  format_weights_json: string;
  enabled: number;
  created_at: number;
};
export type PostRow = {
  id: string;
  subject_id: string;
  atom_id: string;
  topic_key: string;
  format: string;
  persona_id: string;
  text: string;
  quiz_json: string | null;
  difficulty_b: number;
  status: string;
  is_rare_card: number;
  created_at: number;
  display_name: string;
  handle: string;
  avatar_seed: string;
  source_anchor: string;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

const INITIAL_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS __learnstream_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS subjects (subject_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, handle TEXT NOT NULL, avatar_seed TEXT NOT NULL, content_lang TEXT NOT NULL, domain_style TEXT NOT NULL, format_weights_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS materials (material_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, filename TEXT NOT NULL, file_uri TEXT NOT NULL, mime_type TEXT NOT NULL, page_count INTEGER, page_start INTEGER, page_end INTEGER, status TEXT NOT NULL, error_message TEXT, added_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS materials_subject_idx ON materials(subject_id);
CREATE TABLE IF NOT EXISTS atoms (atom_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, material_id TEXT NOT NULL, topic_label TEXT NOT NULL, kind TEXT NOT NULL, difficulty REAL NOT NULL, core TEXT NOT NULL, note TEXT, source_anchor TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS atoms_subject_idx ON atoms(subject_id); CREATE INDEX IF NOT EXISTS atoms_material_idx ON atoms(material_id);
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, atom_id TEXT NOT NULL, topic_key TEXT NOT NULL, format TEXT NOT NULL, persona_id TEXT NOT NULL, text TEXT NOT NULL, quiz_json TEXT, difficulty_b REAL NOT NULL, status TEXT NOT NULL DEFAULT 'unread', is_rare_card INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS posts_status_idx ON posts(status); CREATE INDEX IF NOT EXISTS posts_atom_idx ON posts(atom_id); CREATE INDEX IF NOT EXISTS posts_arm_idx ON posts(topic_key,format);
CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, action TEXT NOT NULL, dwell_ms INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS interactions_post_time_idx ON interactions(post_id,created_at);
CREATE TABLE IF NOT EXISTS quiz_attempts (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, session_key TEXT NOT NULL, answer_index INTEGER, correct INTEGER NOT NULL CHECK(correct IN (0,1)), created_at INTEGER NOT NULL, next_review_at INTEGER NOT NULL, UNIQUE(post_id,session_key));
CREATE INDEX IF NOT EXISTS quiz_attempts_post_time_idx ON quiz_attempts(post_id,created_at);
CREATE TABLE IF NOT EXISTS bandit_arms (topic_key TEXT NOT NULL, format TEXT NOT NULL, alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1, PRIMARY KEY(topic_key,format));
CREATE TABLE IF NOT EXISTS atom_memory (atom_id TEXT PRIMARY KEY, stability_days REAL NOT NULL DEFAULT 1, last_reviewed_at INTEGER, review_count INTEGER NOT NULL DEFAULT 0, lapse_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS user_topic_state (topic_key TEXT PRIMARY KEY, theta REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS streak_state (id INTEGER PRIMARY KEY CHECK(id=1), current_streak INTEGER NOT NULL DEFAULT 0, longest_streak INTEGER NOT NULL DEFAULT 0, last_active_date TEXT, freezes_owned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS xp_events (id TEXT PRIMARY KEY, amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deepdives (post_id TEXT PRIMARY KEY, thread_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_log (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, purpose TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, est_cost_usd REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generation_runtime (id INTEGER PRIMARY KEY CHECK(id=1), lease_token TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS extraction_jobs (job_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL UNIQUE REFERENCES subjects(subject_id) ON DELETE CASCADE, status TEXT NOT NULL, trigger TEXT NOT NULL, completed_units INTEGER NOT NULL DEFAULT 0, total_units INTEGER NOT NULL DEFAULT 0, progress_label TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error_code TEXT, last_error TEXT, lease_token TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS extraction_jobs_runnable_idx ON extraction_jobs(status,next_attempt_at,lease_expires_at,created_at);
INSERT OR IGNORE INTO streak_state(id) VALUES(1);
INSERT OR IGNORE INTO generation_runtime(id) VALUES(1);
INSERT OR IGNORE INTO __learnstream_migrations(id,applied_at) VALUES('0000_initial',unixepoch()*1000);
INSERT OR IGNORE INTO __learnstream_migrations(id,applied_at) VALUES('0001_quiz_attempts',unixepoch()*1000);`;

function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("learnstream.db")
      .then(async (db) => {
        // Schema initialization belongs to the connection lifecycle. Running
        // the full DDL batch for every query creates needless contention with
        // extraction progress and lease heartbeats.
        await db.execAsync(INITIAL_SQL);
        return db;
      })
      .catch((error) => {
        // Allow a later call to recover from a transient open/migration error.
        dbPromise = null;
        throw error;
      });
  }
  return dbPromise;
}

const coordinator = new DatabaseCoordinator(openDb);
export const captureDatabaseGeneration = () => coordinator.captureGeneration();
export const assertDatabaseGeneration = (generation: number) => coordinator.assertGeneration(generation);
export const getDb = () => coordinator.getDb();
export const getDbForGeneration = (generation: number) => coordinator.getDb(generation);
export const withDbTransaction = <T>(work: (db: SQLite.SQLiteDatabase) => Promise<T>, generation?: number) => coordinator.transaction(work, generation);
export const withDatabaseRestore = <T>(work: (db: SQLite.SQLiteDatabase) => Promise<T>) => coordinator.restore(work);

export async function getSetting<T>(key: string, fallback: T, generation = captureDatabaseGeneration()): Promise<T> {
  const db = await getDbForGeneration(generation);
  const row = await db.getFirstAsync<{ value_json: string }>(
    "SELECT value_json FROM settings WHERE key=?",
    key,
  );
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return fallback;
  }
}
export async function setSetting(key: string, value: unknown, generation = captureDatabaseGeneration()): Promise<void> {
  const db = await getDbForGeneration(generation);
  await db.runAsync(
    "INSERT INTO settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    key,
    JSON.stringify(value),
  );
}
export async function listSubjects(): Promise<SubjectRow[]> {
  return (await getDb()).getAllAsync<SubjectRow>(
    "SELECT * FROM subjects ORDER BY created_at",
  );
}
export async function listFeed(subjectId?: string): Promise<PostRow[]> {
  return selectFeedCandidates(await getDb(), subjectId);
}
export async function getPost(postId: string): Promise<PostRow | null> {
  return (await getDb()).getFirstAsync<PostRow>(
    "SELECT p.*,s.display_name,s.handle,s.avatar_seed,COALESCE(a.source_anchor,'LearnStream') source_anchor FROM posts p JOIN subjects s ON s.subject_id=p.subject_id LEFT JOIN atoms a ON a.atom_id=p.atom_id WHERE p.id=?",
    postId,
  );
}
export async function addInteraction(
  postId: string,
  action: string,
  dwellMs?: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO interactions(id,post_id,action,dwell_ms,created_at) VALUES(?,?,?,?,?)",
    id("ix"),
    postId,
    action,
    dwellMs ?? null,
    Date.now(),
  );
}
export async function isLiked(postId: string): Promise<boolean> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ liked: number }>(
    "SELECT CASE WHEN (SELECT action FROM interactions WHERE post_id=? AND action IN ('like','unlike') ORDER BY created_at DESC LIMIT 1)='like' THEN 1 ELSE 0 END liked",
    postId,
  );
  return row?.liked === 1;
}
export async function debugInteractions() {
  return (await getDb()).getAllAsync(
    "SELECT * FROM interactions ORDER BY created_at DESC LIMIT 200",
  );
}
export { id as createId };

// expo-sqlite is persisted on native and IndexedDB-backed on web. Keep this export to
// make the platform limitation explicit in diagnostics.
export const databasePlatform = Platform.OS;
