import { Directory, File, Paths } from "expo-file-system";
import { getDb } from "../db/database";
import { ImportSchema } from "../llm/schemas";

const TABLES = [
  "subjects",
  "materials",
  "atoms",
  "posts",
  "interactions",
  "bandit_arms",
  "atom_memory",
  "user_topic_state",
  "streak_state",
  "xp_events",
  "deepdives",
  "settings",
  "usage_log",
] as const;
const EXPORT_KEYS = [
  "subjects",
  "materials",
  "atoms",
  "posts",
  "interactions",
  "banditArms",
  "atomMemory",
  "userTopicState",
  "streakState",
  "xpEvents",
  "deepdives",
  "settings",
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
  settings: ["key", "value_json"],
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

export async function createExportFile(): Promise<File> {
  const db = await getDb();
  const data: Record<string, unknown> = {
    schemaVersion: 2,
    exportedAt: Date.now(),
    originalFilesIncluded: false,
  };
  for (let i = 0; i < TABLES.length; i++)
    data[EXPORT_KEYS[i]] = await db.getAllAsync(`SELECT * FROM ${TABLES[i]}`);
  const file = new File(
    new Directory(Paths.cache),
    `learnstream-export-${new Date().toISOString().slice(0, 10)}.json`,
  );
  file.create({ overwrite: true });
  file.write(JSON.stringify(data, null, 2));
  return file;
}

export async function importData(fileUri: string): Promise<void> {
  const parsed = ImportSchema.parse(await new File(fileUri).json());
  const db = await getDb();
  const source = [
    parsed.subjects,
    parsed.materials,
    parsed.atoms,
    parsed.posts,
    parsed.interactions,
    parsed.banditArms,
    parsed.atomMemory,
    parsed.userTopicState,
    parsed.streakState,
    parsed.xpEvents,
    parsed.deepdives,
    parsed.settings,
    parsed.usageLog,
  ];
  await db.withTransactionAsync(async () => {
    for (const table of [...TABLES].reverse())
      await db.execAsync(`DELETE FROM ${table}`);
    for (let i = 0; i < TABLES.length; i++)
      for (const row of source[i]) {
        const columns = Object.keys(row);
        if (!columns.length) continue;
        if (columns.some((column) => !COLUMNS[TABLES[i]].includes(column)))
          throw new Error(`Invalid column in ${TABLES[i]}`);
        await db.runAsync(
          `INSERT INTO ${TABLES[i]}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          ...columns.map((key) => row[key] as string | number | null),
        );
      }
    await db.runAsync("INSERT OR IGNORE INTO streak_state(id) VALUES(1)");
  });
}
