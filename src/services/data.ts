import { Directory, File, Paths } from "expo-file-system";
import { withDatabaseRestore, withDbTransaction } from "../db/database";
import { DEFAULT_FORMAT_WEIGHTS } from "../core/config";
import { ImportSchema } from "../llm/schemas";

const TABLES = [
  "subjects",
  "materials",
  "atoms",
  "posts",
  "interactions",
  "quiz_attempts",
  "bandit_arms",
  "atom_memory",
  "user_topic_state",
  "streak_state",
  "xp_events",
  "deepdives",
  "usage_log",
] as const;
const EXPORT_KEYS = [
  "subjects",
  "materials",
  "atoms",
  "posts",
  "interactions",
  "quizAttempts",
  "banditArms",
  "atomMemory",
  "userTopicState",
  "streakState",
  "xpEvents",
  "deepdives",
  "usageLog",
] as const;
const COLUMNS: Record<(typeof TABLES)[number], readonly string[]> = {
  subjects: [
    "subject_id",
    "display_name",
    "handle",
    "avatar_seed",
    "content_lang",
    "domain_style",
    "format_weights_json",
    "enabled",
    "created_at",
  ],
  materials: [
    "material_id",
    "subject_id",
    "filename",
    "file_uri",
    "mime_type",
    "page_count",
    "page_start",
    "page_end",
    "status",
    "error_message",
    "added_at",
  ],
  atoms: [
    "atom_id",
    "subject_id",
    "material_id",
    "topic_label",
    "kind",
    "difficulty",
    "core",
    "note",
    "source_anchor",
    "enabled",
    "created_at",
  ],
  posts: [
    "id",
    "subject_id",
    "atom_id",
    "topic_key",
    "format",
    "persona_id",
    "text",
    "quiz_json",
    "difficulty_b",
    "status",
    "is_rare_card",
    "created_at",
  ],
  interactions: ["id", "post_id", "action", "dwell_ms", "created_at"],
  quiz_attempts: ["id", "post_id", "session_key", "answer_index", "correct", "created_at", "next_review_at"],
  bandit_arms: ["topic_key", "format", "alpha", "beta"],
  atom_memory: [
    "atom_id",
    "stability_days",
    "last_reviewed_at",
    "review_count",
    "lapse_count",
  ],
  user_topic_state: ["topic_key", "theta", "attempts"],
  streak_state: [
    "id",
    "current_streak",
    "longest_streak",
    "last_active_date",
    "freezes_owned",
  ],
  xp_events: ["id", "amount", "reason", "created_at"],
  deepdives: ["post_id", "thread_json", "created_at"],
  usage_log: [
    "id",
    "created_at",
    "provider_id",
    "model_id",
    "purpose",
    "input_tokens",
    "output_tokens",
    "est_cost_usd",
  ],
};

const SYNTHETIC_MATERIAL_URI = /^(asset|studytter-package):\/\//;
export const isSyntheticMaterialUri = (uri: string) => SYNTHETIC_MATERIAL_URI.test(uri);

type ExportRow = Record<string, unknown>;

/** Earlier versions could store values the restore validator rejects (an
 * emptied subject name, all-zero weights, negative dwell/cost). Normalize
 * them in the snapshot so existing installs can still produce a backup. */
function repairLegacyExportRows(data: Record<string, unknown>) {
  for (const subject of (data.subjects ?? []) as ExportRow[]) {
    const name = String(subject.display_name ?? "").trim();
    subject.display_name = (name || String(subject.handle || subject.subject_id)).slice(0, 500);
    try {
      const weights = JSON.parse(String(subject.format_weights_json)) as Record<string, number>;
      if (!Object.values(weights).some((weight) => weight > 0))
        subject.format_weights_json = JSON.stringify(DEFAULT_FORMAT_WEIGHTS);
    } catch {
      subject.format_weights_json = JSON.stringify(DEFAULT_FORMAT_WEIGHTS);
    }
  }
  for (const row of (data.interactions ?? []) as ExportRow[])
    if (typeof row.dwell_ms === "number") row.dwell_ms = Math.max(0, Math.round(row.dwell_ms));
  for (const row of (data.usageLog ?? []) as ExportRow[])
    if (typeof row.est_cost_usd === "number") row.est_cost_usd = Math.max(0, row.est_cost_usd);
}

export async function createExportFile(): Promise<File> {
  const data: Record<string, unknown> = {
    schemaVersion: 2,
    exportedAt: Date.now(),
    originalFilesIncluded: false,
    settings: [],
  };
  // Take one coherent snapshot, including answer records and all derived state.
  await withDbTransaction(async (db) => {
    for (let i = 0; i < TABLES.length; i++)
      data[EXPORT_KEYS[i]] = await db.getAllAsync(`SELECT * FROM ${TABLES[i]}`);
  });
  repairLegacyExportRows(data);
  // Restore is all-or-nothing, so never hand the user a file it would reject.
  const checked = ImportSchema.safeParse(data);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(`バックアップを作成できません。復元できないデータがあります（${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}）。`);
  }
  const file = new File(
    new Directory(Paths.cache),
    `learnstream-export-${new Date().toISOString().slice(0, 10)}.json`,
  );
  file.create({ overwrite: true });
  file.write(JSON.stringify(data, null, 2));
  return file;
}

export async function importData(fileUri: string): Promise<void> {
  await restoreData(await readImportFile(fileUri));
}

/** Validate before asking the user to replace their current learning data. */
export async function readImportFile(fileUri: string) {
  const file = new File(fileUri);
  if (file.size > 50 * 1024 * 1024) throw new Error("バックアップは50MB以下にしてください。");
  return ImportSchema.parse(await file.json());
}

export async function restoreData(value: unknown): Promise<void> {
  // This full validation, including JSON and references, happens before the
  // restore barrier invalidates workers or any existing row is deleted.
  const parsed = ImportSchema.parse(value);
  const source = [
    parsed.subjects,
    parsed.materials,
    parsed.atoms,
    parsed.posts,
    parsed.interactions,
    parsed.quizAttempts,
    parsed.banditArms,
    parsed.atomMemory,
    parsed.userTopicState,
    parsed.streakState,
    parsed.xpEvents,
    parsed.deepdives,
    parsed.usageLog,
  ];
  await withDatabaseRestore(async (db) => {
    // A backup cannot grant access to arbitrary local paths. Only retain file
    // references already associated with this material on this installation.
    const localMaterials = new Map((await db.getAllAsync<{ material_id: string; file_uri: string }>(
      "SELECT material_id,file_uri FROM materials",
    )).map((row) => [row.material_id, row.file_uri]));
    for (const material of parsed.materials) {
      // Synthetic sources (bundled demo, Companion packages) are not local
      // paths and never had a file to re-attach, so they are kept verbatim.
      if (isSyntheticMaterialUri(material.file_uri)) continue;
      const hasLocalFile = material.file_uri !== "" && localMaterials.get(material.material_id) === material.file_uri;
      if (!hasLocalFile) material.file_uri = "";
      // Completed materials already have their atoms and posts; only work that
      // still needs the original file must be re-attached.
      if (material.status === "replaced" || material.status === "done") continue;
      if (!hasLocalFile || material.status === "pending" || material.status === "extracting") {
        material.status = "failed";
        material.error_message = hasLocalFile
          ? "復元前に抽出が中断されました。抽出を再開してください。"
          : "バックアップに元の教材ファイルは含まれません。教材を差し替えて抽出を再開してください。";
      }
    }
    // Pending jobs and leases refer to the replaced database and must not
    // resume against subjects with coincidentally identical identifiers.
    await db.runAsync("DELETE FROM extraction_jobs");
    await db.runAsync("UPDATE generation_runtime SET lease_token=NULL,lease_expires_at=0 WHERE id=1");
    const runtime = await db.getFirstAsync<{ value_json: string }>("SELECT value_json FROM settings WHERE key='autoGenerationState'");
    if (runtime) {
      let previous: Record<string, unknown> = {};
      try {
        const decoded: unknown = JSON.parse(runtime.value_json);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) previous = decoded as Record<string, unknown>;
      } catch { /* A malformed runtime record is safely reset. */ }
      await db.runAsync("UPDATE settings SET value_json=? WHERE key='autoGenerationState'", JSON.stringify({
        ...previous,
        phase: "idle", lastTrigger: null, lastStartedAt: null, lastFinishedAt: Date.now(),
        lastInserted: 0, lastErrorCode: null, lastErrorMessage: null,
        nextRetryAt: null, consecutiveFailures: 0, refillPending: false,
      }));
    }
    for (const table of [...TABLES].reverse())
      await db.execAsync(`DELETE FROM ${table}`);
    for (let i = 0; i < TABLES.length; i++)
      for (const row of source[i]) {
        const columns = COLUMNS[TABLES[i]];
        const record = row as Record<string, string | number | null>;
        await db.runAsync(
          `INSERT INTO ${TABLES[i]}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          ...columns.map((key) => record[key]),
        );
      }
    await db.runAsync("INSERT OR IGNORE INTO streak_state(id) VALUES(1)");
  });
}
