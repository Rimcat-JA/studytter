import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const subjects = sqliteTable("subjects", {
  subjectId: text("subject_id").primaryKey(),
  displayName: text("display_name").notNull(),
  handle: text("handle").notNull(),
  avatarSeed: text("avatar_seed").notNull(),
  contentLang: text("content_lang").notNull(),
  domainStyle: text("domain_style").notNull(),
  formatWeightsJson: text("format_weights_json").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export const materials = sqliteTable(
  "materials",
  {
    materialId: text("material_id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    filename: text("filename").notNull(),
    fileUri: text("file_uri").notNull(),
    mimeType: text("mime_type").notNull(),
    pageCount: integer("page_count"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    addedAt: integer("added_at").notNull(),
  },
  (table) => [index("materials_subject_idx").on(table.subjectId)],
);

export const atoms = sqliteTable(
  "atoms",
  {
    atomId: text("atom_id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    materialId: text("material_id").notNull(),
    topicLabel: text("topic_label").notNull(),
    kind: text("kind").notNull(),
    difficulty: real("difficulty").notNull(),
    core: text("core").notNull(),
    note: text("note"),
    sourceAnchor: text("source_anchor").notNull(),
    enabled: integer("enabled").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("atoms_subject_idx").on(table.subjectId),
    index("atoms_material_idx").on(table.materialId),
  ],
);

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    subjectId: text("subject_id").notNull(),
    atomId: text("atom_id").notNull(),
    topicKey: text("topic_key").notNull(),
    format: text("format").notNull(),
    personaId: text("persona_id").notNull(),
    text: text("text").notNull(),
    quizJson: text("quiz_json"),
    difficultyB: real("difficulty_b").notNull(),
    status: text("status").notNull().default("unread"),
    isRareCard: integer("is_rare_card").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("posts_status_idx").on(table.status),
    index("posts_atom_idx").on(table.atomId),
    index("posts_arm_idx").on(table.topicKey, table.format),
  ],
);

export const interactions = sqliteTable("interactions", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull(),
  action: text("action").notNull(),
  dwellMs: integer("dwell_ms"),
  createdAt: integer("created_at").notNull(),
});
export const banditArms = sqliteTable(
  "bandit_arms",
  {
    topicKey: text("topic_key").notNull(),
    format: text("format").notNull(),
    alpha: real("alpha").notNull().default(1),
    beta: real("beta").notNull().default(1),
  },
  (table) => [primaryKey({ columns: [table.topicKey, table.format] })],
);
export const atomMemory = sqliteTable("atom_memory", {
  atomId: text("atom_id").primaryKey(),
  stabilityDays: real("stability_days").notNull().default(1),
  lastReviewedAt: integer("last_reviewed_at"),
  reviewCount: integer("review_count").notNull().default(0),
  lapseCount: integer("lapse_count").notNull().default(0),
});
export const userTopicState = sqliteTable("user_topic_state", {
  topicKey: text("topic_key").primaryKey(),
  theta: real("theta").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
});
export const streakState = sqliteTable("streak_state", {
  id: integer("id").primaryKey(),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  lastActiveDate: text("last_active_date"),
  freezesOwned: integer("freezes_owned").notNull().default(0),
});
export const xpEvents = sqliteTable("xp_events", {
  id: text("id").primaryKey(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const deepdives = sqliteTable("deepdives", {
  postId: text("post_id").primaryKey(),
  threadJson: text("thread_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const usageLog = sqliteTable("usage_log", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  purpose: text("purpose").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  estCostUsd: real("est_cost_usd").notNull(),
});
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});
export const generationRuntime = sqliteTable("generation_runtime", {
  id: integer("id").primaryKey(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at").notNull().default(0),
});
export const extractionJobs = sqliteTable(
  "extraction_jobs",
  {
    jobId: text("job_id").primaryKey(),
    subjectId: text("subject_id")
      .notNull()
      .unique()
      .references(() => subjects.subjectId, { onDelete: "cascade" }),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    completedUnits: integer("completed_units").notNull().default(0),
    totalUnits: integer("total_units").notNull().default(0),
    progressLabel: text("progress_label"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("extraction_jobs_runnable_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);
