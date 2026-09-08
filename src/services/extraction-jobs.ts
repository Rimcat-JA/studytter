import {
  computeGenerationBackoffMs,
  type GenerationFailureCode,
} from "../core/autogeneration";
import {
  classifyExtractionError,
  MAX_EXTRACTION_ATTEMPTS,
  type ExtractionJobStatus,
} from "../core/extraction-jobs";
import { assertDatabaseGeneration, captureDatabaseGeneration, createId, DatabaseReplacedError, getDb, withDbTransaction } from "../db/database";
import { extractSubject, type ExtractionProgress } from "../ingest";
import { scheduleImmediateExtractionWork } from "./extraction-scheduler";

export type { ExtractionJobStatus } from "../core/extraction-jobs";

export type ExtractionJobTrigger =
  | "material"
  | "retry"
  | "manual"
  | "startup"
  | "foreground"
  | "background"
  | "native_worker";

type ExtractionJobDbRow = {
  job_id: string;
  subject_id: string;
  status: ExtractionJobStatus;
  trigger: ExtractionJobTrigger;
  completed_units: number;
  total_units: number;
  progress_label: string | null;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: GenerationFailureCode | null;
  last_error: string | null;
  lease_token: string | null;
  lease_expires_at: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

export type ExtractionJob = {
  jobId: string;
  subjectId: string;
  status: ExtractionJobStatus;
  trigger: ExtractionJobTrigger;
  completedUnits: number;
  totalUnits: number;
  progressLabel: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: GenerationFailureCode | null;
  lastError: string | null;
  leaseExpiresAt: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
};

export type ExtractionWorkResult = {
  status: "completed" | "failed" | "skipped";
  job: ExtractionJob | null;
  reason?: "empty" | "in_flight" | "backoff";
  retryable?: boolean;
};

const LEASE_DURATION_MS = 3 * 60_000;
const LEASE_HEARTBEAT_MS = 45_000;

const fromDb = (row: ExtractionJobDbRow): ExtractionJob => ({
  jobId: row.job_id,
  subjectId: row.subject_id,
  status: row.status,
  trigger: row.trigger,
  completedUnits: row.completed_units,
  totalUnits: row.total_units,
  progressLabel: row.progress_label,
  attemptCount: row.attempt_count,
  nextAttemptAt: row.next_attempt_at,
  lastErrorCode: row.last_error_code,
  lastError: row.last_error,
  leaseExpiresAt: row.lease_expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
});

type ExtractionJobListener = (job: ExtractionJob) => void;
const listeners = new Set<ExtractionJobListener>();

export function subscribeToExtractionJobs(listener: ExtractionJobListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(job: ExtractionJob) {
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      // Persisted job state must not depend on a mounted screen listener.
    }
  }
}

async function readJobById(jobId: string): Promise<ExtractionJob | null> {
  const row = await (
    await getDb()
  ).getFirstAsync<ExtractionJobDbRow>(
    "SELECT * FROM extraction_jobs WHERE job_id=?",
    jobId,
  );
  return row ? fromDb(row) : null;
}

export async function getExtractionJob(
  subjectId: string,
): Promise<ExtractionJob | null> {
  const row = await (
    await getDb()
  ).getFirstAsync<ExtractionJobDbRow>(
    "SELECT * FROM extraction_jobs WHERE subject_id=?",
    subjectId,
  );
  return row ? fromDb(row) : null;
}

export async function listExtractionJobs(options: {
  activeOnly?: boolean;
} = {}): Promise<ExtractionJob[]> {
  const rows = await (
    await getDb()
  ).getAllAsync<ExtractionJobDbRow>(
    options.activeOnly
      ? "SELECT * FROM extraction_jobs WHERE status IN ('queued','running','backoff') ORDER BY created_at"
      : "SELECT * FROM extraction_jobs ORDER BY created_at DESC",
  );
  return rows.map(fromDb);
}

export async function hasPendingExtractionJobs(): Promise<boolean> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM extraction_jobs WHERE status IN ('queued','running','backoff')",
  );
  return (row?.count ?? 0) > 0;
}

export async function enqueueExtraction(
  subjectId: string,
  trigger: ExtractionJobTrigger = "material",
  options: { startImmediately?: boolean } = {},
): Promise<ExtractionJob> {
  const db = await getDb();
  const subject = await db.getFirstAsync<{ subject_id: string }>(
    "SELECT subject_id FROM subjects WHERE subject_id=?",
    subjectId,
  );
  if (!subject) throw new Error(`Subject not found: ${subjectId}`);

  const now = Date.now();
  const existing = await db.getFirstAsync<ExtractionJobDbRow>(
    "SELECT * FROM extraction_jobs WHERE subject_id=?",
    subjectId,
  );
  if (
    existing?.status === "running" &&
    existing.lease_token &&
    existing.lease_expires_at > now
  ) {
    const job = fromDb(existing);
    if (options.startImmediately !== false)
      await scheduleImmediateExtractionWork();
    return job;
  }

  const jobId = existing?.job_id ?? createId("extraction");
  if (existing) {
    await db.runAsync(
      `UPDATE extraction_jobs
       SET status='queued',trigger=?,completed_units=0,total_units=0,
           progress_label=NULL,next_attempt_at=NULL,last_error_code=NULL,
           last_error=NULL,attempt_count=0,lease_token=NULL,lease_expires_at=0,
           updated_at=?,finished_at=NULL
       WHERE job_id=?`,
      trigger,
      now,
      jobId,
    );
  } else {
    await db.runAsync(
      `INSERT INTO extraction_jobs(
         job_id,subject_id,status,trigger,completed_units,total_units,
         progress_label,attempt_count,next_attempt_at,last_error_code,last_error,
         lease_token,lease_expires_at,created_at,updated_at,finished_at
       ) VALUES(?,?,'queued',?,0,0,NULL,0,NULL,NULL,NULL,NULL,0,?,?,NULL)`,
      jobId,
      subjectId,
      trigger,
      now,
      now,
    );
  }
  const job = await readJobById(jobId);
  if (!job) throw new Error("Failed to persist extraction job.");
  announce(job);
  if (options.startImmediately !== false) {
    // Persist and register the OS worker before returning to the screen. This
    // closes the small window where an immediate task dismissal could occur
    // before durable background execution had been scheduled.
    await scheduleImmediateExtractionWork();
    void requestExtractionWork(trigger, { preferredSubjectId: subjectId });
  }
  return job;
}

export async function retryExtraction(subjectId: string) {
  return enqueueExtraction(subjectId, "retry");
}

/** Requeue temporary extraction failures after the user saves new AI settings. */
export async function retryBackoffExtractions(): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ job_id: string }>(
    "SELECT job_id FROM extraction_jobs WHERE status='backoff' ORDER BY created_at",
  );
  if (!rows.length) return 0;

  const now = Date.now();
  await db.runAsync(
    `UPDATE extraction_jobs
       SET status='queued',trigger='retry',completed_units=0,total_units=0,
           progress_label=NULL,next_attempt_at=NULL,last_error_code=NULL,
           last_error=NULL,attempt_count=0,lease_token=NULL,lease_expires_at=0,
           updated_at=?,finished_at=NULL
     WHERE status='backoff'`,
    now,
  );
  for (const row of rows) {
    const job = await readJobById(row.job_id);
    if (job) announce(job);
  }
  await scheduleImmediateExtractionWork();
  void requestExtractionWork("retry");
  return rows.length;
}

/**
 * Requeue work whose JS process disappeared. A live worker renews its short
 * lease; after normal task dismissal/process death the lease expires and the
 * next app launch or OS worker safely resumes it. Android force-stop remains
 * intentionally outside this guarantee because the OS suppresses all work.
 */
export async function recoverPendingExtractionJobs(): Promise<number> {
  const generation = captureDatabaseGeneration();
  const db = await getDb();
  const now = Date.now();
  const stale = await db.getAllAsync<{ job_id: string; subject_id: string }>(
    `SELECT job_id,subject_id FROM extraction_jobs
     WHERE status='running' AND lease_expires_at<=?`,
    now,
  );
  for (const row of stale) {
    await withDbTransaction(async (db) => {
      await db.runAsync(
        `UPDATE extraction_jobs
         SET status='queued',trigger='startup',lease_token=NULL,
             lease_expires_at=0,next_attempt_at=NULL,updated_at=?
         WHERE job_id=? AND status='running' AND lease_expires_at<=?`,
        now,
        row.job_id,
        now,
      );
      await db.runAsync(
        "UPDATE materials SET status='pending' WHERE subject_id=? AND status='extracting'",
        row.subject_id,
      );
    }, generation);
  }

  // Older builds classified an AI_RetryError whose outer message only said
  // "Failed after N attempts" as terminal, even when its visible inner text
  // said overloaded/503/429. Re-evaluate those persisted failures with the
  // current classifier so installing the fix resumes the user's material
  // automatically instead of requiring another tap.
  const previouslyFailed = await db.getAllAsync<{
    job_id: string;
    subject_id: string;
    attempt_count: number;
    last_error: string | null;
  }>(
    `SELECT job_id,subject_id,attempt_count,last_error
       FROM extraction_jobs
      WHERE status='failed' AND last_error IS NOT NULL`,
  );
  const recoveredFailedIds: string[] = [];
  for (const row of previouslyFailed) {
    const classified = classifyExtractionError(row.last_error);
    if (
      !classified.retryable ||
      row.attempt_count >= MAX_EXTRACTION_ATTEMPTS
    )
      continue;
    await withDbTransaction(async (db) => {
      const result = await db.runAsync(
        `UPDATE extraction_jobs
            SET status='queued',trigger='startup',next_attempt_at=NULL,
                last_error_code=NULL,last_error=NULL,progress_label=NULL,
                lease_token=NULL,lease_expires_at=0,updated_at=?,finished_at=NULL
          WHERE job_id=? AND status='failed'`,
        now,
        row.job_id,
      );
      if (result.changes !== 1) return;
      await db.runAsync(
        "UPDATE materials SET status='pending',error_message=NULL WHERE subject_id=? AND status='failed'",
        row.subject_id,
      );
      recoveredFailedIds.push(row.job_id);
    }, generation);
  }

  const orphaned = await db.getAllAsync<{ subject_id: string }>(
    `SELECT DISTINCT m.subject_id
       FROM materials m
       LEFT JOIN extraction_jobs j ON j.subject_id=m.subject_id
      WHERE m.status IN ('pending','extracting')
        AND (j.job_id IS NULL OR j.status='complete')`,
  );
  for (const row of orphaned) {
    await db.runAsync(
      "UPDATE materials SET status='pending' WHERE subject_id=? AND status='extracting'",
      row.subject_id,
    );
    assertDatabaseGeneration(generation);
    await enqueueExtraction(row.subject_id, "startup", {
      startImmediately: false,
    });
  }

  for (const row of stale) {
    const job = await readJobById(row.job_id);
    if (job) announce(job);
  }
  for (const jobId of recoveredFailedIds) {
    const job = await readJobById(jobId);
    if (job) announce(job);
  }
  return stale.length + orphaned.length + recoveredFailedIds.length;
}

async function acquireNextJob(
  trigger: ExtractionJobTrigger,
  preferredSubjectId?: string,
): Promise<{ row: ExtractionJobDbRow; token: string } | null> {
  const db = await getDb();
  const now = Date.now();
  const row = await db.getFirstAsync<ExtractionJobDbRow>(
    `SELECT * FROM extraction_jobs
      WHERE status IN ('queued','running','backoff')
        AND (next_attempt_at IS NULL OR next_attempt_at<=?)
        AND (lease_token IS NULL OR lease_expires_at<=?)
      ORDER BY CASE WHEN subject_id=? THEN 0 ELSE 1 END,created_at
      LIMIT 1`,
    now,
    now,
    preferredSubjectId ?? "",
  );
  if (!row) return null;

  const token = createId("extraction_lease");
  const result = await db.runAsync(
    `UPDATE extraction_jobs
       SET status='running',trigger=?,attempt_count=attempt_count+1,
           next_attempt_at=NULL,last_error_code=NULL,last_error=NULL,
           lease_token=?,lease_expires_at=?,updated_at=?,finished_at=NULL
     WHERE job_id=?
       AND status IN ('queued','running','backoff')
       AND (next_attempt_at IS NULL OR next_attempt_at<=?)
       AND (lease_token IS NULL OR lease_expires_at<=?)`,
    trigger,
    token,
    now + LEASE_DURATION_MS,
    now,
    row.job_id,
    now,
    now,
  );
  if (result.changes !== 1) return null;
  const acquired = await db.getFirstAsync<ExtractionJobDbRow>(
    "SELECT * FROM extraction_jobs WHERE job_id=?",
    row.job_id,
  );
  return acquired ? { row: acquired, token } : null;
}

async function renewLease(jobId: string, token: string): Promise<void> {
  await (
    await getDb()
  ).runAsync(
    `UPDATE extraction_jobs SET lease_expires_at=?,updated_at=?
     WHERE job_id=? AND lease_token=? AND status='running'`,
    Date.now() + LEASE_DURATION_MS,
    Date.now(),
    jobId,
    token,
  );
}

async function persistProgress(
  jobId: string,
  token: string,
  progress: ExtractionProgress,
): Promise<void> {
  const now = Date.now();
  const db = await getDb();
  const result = await db.runAsync(
    `UPDATE extraction_jobs
       SET completed_units=?,total_units=?,progress_label=?,
           lease_expires_at=?,updated_at=?
     WHERE job_id=? AND lease_token=? AND status='running'`,
    progress.completed,
    progress.total,
    progress.label.slice(0, 500),
    now + LEASE_DURATION_MS,
    now,
    jobId,
    token,
  );
  if (result.changes === 1) {
    const job = await readJobById(jobId);
    if (job) announce(job);
  }
}

async function completeJob(
  jobId: string,
  token: string,
): Promise<ExtractionJob | null> {
  const now = Date.now();
  const db = await getDb();
  await db.runAsync(
    `UPDATE extraction_jobs
       SET status='complete',completed_units=CASE
             WHEN total_units>completed_units THEN total_units
             ELSE completed_units END,
           progress_label=NULL,next_attempt_at=NULL,last_error_code=NULL,
           last_error=NULL,lease_token=NULL,lease_expires_at=0,
           updated_at=?,finished_at=?
     WHERE job_id=? AND lease_token=?`,
    now,
    now,
    jobId,
    token,
  );
  const job = await readJobById(jobId);
  if (job) announce(job);
  return job;
}

async function failJob(
  row: ExtractionJobDbRow,
  token: string,
  error: unknown,
): Promise<{ job: ExtractionJob | null; retryable: boolean }> {
  const retryableOverride =
    error && typeof error === "object"
      ? (error as { extractionRetryable?: unknown }).extractionRetryable
      : undefined;
  const classified = classifyExtractionError(
    error,
    typeof retryableOverride === "boolean" ? retryableOverride : undefined,
  );
  const exhausted =
    classified.retryable && row.attempt_count >= MAX_EXTRACTION_ATTEMPTS;
  const retryable = classified.retryable && !exhausted;
  const now = Date.now();
  const nextAttemptAt = retryable
    ? now +
      computeGenerationBackoffMs(
        row.attempt_count,
        classified.retryAfterMs,
      )
    : null;
  const db = await getDb();
  await db.runAsync(
    `UPDATE extraction_jobs
       SET status=?,next_attempt_at=?,last_error_code=?,last_error=?,
           progress_label=NULL,lease_token=NULL,lease_expires_at=0,
           updated_at=?,finished_at=?
     WHERE job_id=? AND lease_token=?`,
    retryable ? "backoff" : "failed",
    nextAttemptAt,
    classified.code,
    (exhausted
      ? `Automatic retry limit reached after ${MAX_EXTRACTION_ATTEMPTS} attempts. ${classified.message}`
      : classified.message
    ).slice(0, 2_000),
    now,
    retryable ? null : now,
    row.job_id,
    token,
  );
  const job = await readJobById(row.job_id);
  if (job) announce(job);
  return { job, retryable };
}

type MaterialError = Error & {
  status?: number;
  extractionRetryable?: boolean;
};

const statusFromMessage = (message: string): number | undefined => {
  const match = message.match(
    /(?:http(?: status)?|status(?: code)?)\D{0,12}(\d{3})/i,
  );
  return match ? Number(match[1]) : undefined;
};

async function materialFailure(subjectId: string): Promise<Error | null> {
  const failed = await (
    await getDb()
  ).getAllAsync<{ filename: string; error_message: string | null }>(
    `SELECT filename,error_message FROM materials
     WHERE subject_id=? AND status='failed' ORDER BY added_at`,
    subjectId,
  );
  if (!failed.length) return null;
  const messages = failed.map(
    (material) =>
      `${material.filename}: ${material.error_message ?? "Extraction failed"}`,
  );
  const classified = messages.map((message) => {
    const error = new Error(message) as MaterialError;
    error.status = statusFromMessage(message);
    return { error, classification: classifyExtractionError(error) };
  });
  const primary =
    classified.find((item) => !item.classification.retryable) ?? classified[0];
  const aggregate = new Error(
    messages.join("\n").slice(0, 2_000),
  ) as MaterialError;
  aggregate.status = primary?.error.status;
  aggregate.extractionRetryable = classified.every(
    (item) => item.classification.retryable,
  );
  return aggregate;
}

let inFlight: Promise<ExtractionWorkResult> | null = null;

export function isExtractionRunning() {
  return inFlight !== null;
}

/** All callers, including the OS worker, join the same in-process promise. */
export function requestExtractionWork(
  trigger: ExtractionJobTrigger,
  options: { preferredSubjectId?: string } = {},
): Promise<ExtractionWorkResult> {
  if (inFlight) return inFlight;
  inFlight = runExtractionWork(trigger, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runExtractionWork(
  trigger: ExtractionJobTrigger,
  options: { preferredSubjectId?: string },
): Promise<ExtractionWorkResult> {
  const generation = captureDatabaseGeneration();
  let lastResult: ExtractionWorkResult | null = null;
  let lastFailure: ExtractionWorkResult | null = null;
  let sawRetryableFailure = false;
  let preferredSubjectId = options.preferredSubjectId;
  try {
    await recoverPendingExtractionJobs();
    // Drain every currently runnable subject. A unique native worker scheduled
    // while already RUNNING may be ignored, so relying on another invocation
    // would leave the second subject waiting for the periodic fallback.
    while (true) {
      assertDatabaseGeneration(generation);
      const acquired = await acquireNextJob(trigger, preferredSubjectId);
      preferredSubjectId = undefined;
      if (!acquired) {
        const active = await listExtractionJobs({ activeOnly: true });
        const now = Date.now();
        const waitingForRetry = active.find(
          (job) => job.nextAttemptAt && job.nextAttemptAt > now,
        );
        if (waitingForRetry)
          return {
            status: "skipped",
            job: waitingForRetry,
            reason: "backoff",
          };
        const liveJob = active.find(
          (job) => job.status === "running" && job.leaseExpiresAt > now,
        );
        if (liveJob)
          return { status: "skipped", job: liveJob, reason: "in_flight" };
        if (lastFailure)
          return { ...lastFailure, retryable: sawRetryableFailure };
        if (lastResult) return lastResult;
        return {
          status: "skipped",
          job: active[0] ?? null,
          reason: "empty",
        };
      }
      assertDatabaseGeneration(generation);
      lastResult = await runAcquiredExtraction(acquired, generation);
      if (lastResult.status === "failed") {
        lastFailure = lastResult;
        sawRetryableFailure ||= lastResult.retryable === true;
      }
    }
  } catch (error) {
    if (error instanceof DatabaseReplacedError)
      return { status: "skipped", job: null, reason: "empty" };
    throw error;
  } finally {
    // Keep a durable retry scheduled while work remains. Do not reconcile the
    // Expo periodic registration here: a foreground extraction promise can be
    // joined by the headless WorkManager callback, so `trigger` alone cannot
    // tell us that registration changes are safe. Android testing showed that
    // mutating registration on this completion path can strand that callback
    // (and its foreground notification) even after the database job is done.
    // Startup, enqueue and settings changes reconcile registration instead.
    if (trigger !== "background") {
      const pending = await hasPendingExtractionJobs().catch(() => false);
      if (pending) {
        await scheduleImmediateExtractionWork().catch(() => {});
      }
    }
  }
}

async function runAcquiredExtraction(acquired: {
  row: ExtractionJobDbRow;
  token: string;
}, generation: number): Promise<ExtractionWorkResult> {
  assertDatabaseGeneration(generation);
  const { row, token } = acquired;
  const runningJob = await readJobById(row.job_id);
  assertDatabaseGeneration(generation);
  if (runningJob) announce(runningJob);

  // A killed JS runtime can leave a material in the transient extracting
  // state. Only the newly acquired lease is allowed to make it runnable again.
  await (
    await getDb()
  ).runAsync(
    "UPDATE materials SET status='pending' WHERE subject_id=? AND status='extracting'",
    row.subject_id,
  );

  let progressWrites = Promise.resolve();
  const heartbeat = setInterval(() => {
    progressWrites = progressWrites
      .then(() => { assertDatabaseGeneration(generation); return renewLease(row.job_id, token); })
      .catch(() => {});
  }, LEASE_HEARTBEAT_MS);

  try {
    assertDatabaseGeneration(generation);
    await extractSubject(row.subject_id, (progress) => {
      progressWrites = progressWrites
        .then(() => { assertDatabaseGeneration(generation); return persistProgress(row.job_id, token, progress); })
        .catch(() => {});
    }, generation);
    await progressWrites;
    assertDatabaseGeneration(generation);
    const failure = await materialFailure(row.subject_id);
    assertDatabaseGeneration(generation);
    if (failure) {
      const failed = await failJob(row, token, failure);
      return { status: "failed", ...failed };
    }
    return {
      status: "completed",
      job: await completeJob(row.job_id, token),
    };
  } catch (error) {
    await progressWrites;
    assertDatabaseGeneration(generation);
    const failed = await failJob(row, token, error);
    return { status: "failed", ...failed };
  } finally {
    clearInterval(heartbeat);
  }
}
