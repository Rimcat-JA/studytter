import {
  classifyGenerationError,
  computeGenerationBackoffMs,
  DEFAULT_AUTO_GENERATION_SETTINGS,
  normalizeAutoGenerationSettings,
  type AutoGenerationSettings,
  type GenerationFailureCode,
} from "../core/autogeneration";
import { createId, getDb, getSetting, setSetting } from "../db/database";
import { refillBatch } from "../llm/generate";

const SETTINGS_KEY = "autoGenerationSettings";
const STATE_KEY = "autoGenerationState";

export type GenerationTrigger =
  | "initial"
  | "foreground"
  | "health"
  | "feed_end"
  | "pull_refresh"
  | "material"
  | "background"
  | "manual"
  | "settings"
  | "legacy";

export type AutoGenerationPhase = "idle" | "running" | "backoff" | "paused";

export type AutoGenerationState = {
  phase: AutoGenerationPhase;
  lastTrigger: GenerationTrigger | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastInserted: number;
  lastErrorCode: GenerationFailureCode | null;
  lastErrorMessage: string | null;
  nextRetryAt: number | null;
  consecutiveFailures: number;
  generatedDay: string;
  generatedToday: number;
  refillPending: boolean;
};

export type AutoGenerationResult = {
  status: "generated" | "skipped" | "failed";
  inserted: number;
  reason?:
    | "disabled"
    | "not_onboarded"
    | "pool_full"
    | "daily_limit"
    | "monthly_cap"
    | "backoff"
    | "in_flight"
    | "no_content";
  errorCode?: GenerationFailureCode;
  errorMessage?: string;
  retryable?: boolean;
  nextRetryAt?: number;
};

const localDay = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

const emptyState = (): AutoGenerationState => ({
  phase: "idle",
  lastTrigger: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: null,
  lastInserted: 0,
  lastErrorCode: null,
  lastErrorMessage: null,
  nextRetryAt: null,
  consecutiveFailures: 0,
  generatedDay: localDay(),
  generatedToday: 0,
  refillPending: false,
});

function stateForToday(state: AutoGenerationState): AutoGenerationState {
  const today = localDay();
  return state.generatedDay === today
    ? state
    : { ...state, generatedDay: today, generatedToday: 0 };
}

export async function getAutoGenerationSettings(): Promise<AutoGenerationSettings> {
  const raw = await getSetting<Partial<AutoGenerationSettings>>(
    SETTINGS_KEY,
    DEFAULT_AUTO_GENERATION_SETTINGS,
  );
  return normalizeAutoGenerationSettings(raw);
}

export async function saveAutoGenerationSettings(
  value: Partial<AutoGenerationSettings>,
): Promise<AutoGenerationSettings> {
  const normalized = normalizeAutoGenerationSettings(value);
  await setSetting(SETTINGS_KEY, normalized);
  for (const listener of settingsListeners) {
    try {
      listener();
    } catch {
      // Saving settings must not depend on a mounted screen listener.
    }
  }
  return normalized;
}

type SettingsListener = () => void;
const settingsListeners = new Set<SettingsListener>();

export function subscribeToAutoGenerationSettings(listener: SettingsListener) {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export async function getAutoGenerationState(): Promise<AutoGenerationState> {
  const stored = await getSetting<AutoGenerationState>(STATE_KEY, emptyState());
  return stateForToday({ ...emptyState(), ...stored });
}

export async function clearAutoGenerationFailure(): Promise<void> {
  const state = await getAutoGenerationState();
  await saveState({
    ...state,
    phase: "idle",
    lastErrorCode: null,
    lastErrorMessage: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
  });
}

async function saveState(state: AutoGenerationState) {
  await setSetting(STATE_KEY, stateForToday(state));
}

async function unreadCount(): Promise<number> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM posts WHERE status='unread'",
  );
  return row?.count ?? 0;
}

async function hasGenerationContent(): Promise<boolean> {
  const row = await (
    await getDb()
  ).getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) count FROM atoms a JOIN subjects s ON s.subject_id=a.subject_id WHERE a.enabled=1 AND s.enabled=1",
  );
  return (row?.count ?? 0) > 0;
}

async function monthlyCapReached(): Promise<boolean> {
  if (!(await getSetting("monthlyCapEnabled", false))) return false;
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const row = await (
    await getDb()
  ).getFirstAsync<{ total: number }>(
    "SELECT COALESCE(SUM(est_cost_usd),0) total FROM usage_log WHERE created_at>=?",
    start.getTime(),
  );
  return (row?.total ?? 0) >= (await getSetting("monthlyCapUsd", 10));
}

type GenerationListener = (inserted: number) => void;
const listeners = new Set<GenerationListener>();

export function subscribeToGeneratedPosts(listener: GenerationListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(inserted: number) {
  if (inserted <= 0) return;
  for (const listener of listeners) {
    try {
      listener(inserted);
    } catch {
      // A screen listener must never make a completed generation look failed.
    }
  }
}

let inFlight: Promise<AutoGenerationResult> | null = null;
const LEASE_DURATION_MS = 15 * 60_000;

async function acquireGenerationLease(): Promise<string | null> {
  const now = Date.now();
  const token = createId("generation_lease");
  const result = await (
    await getDb()
  ).runAsync(
    "UPDATE generation_runtime SET lease_token=?,lease_expires_at=? WHERE id=1 AND (lease_token IS NULL OR lease_expires_at<?)",
    token,
    now + LEASE_DURATION_MS,
    now,
  );
  return result.changes === 1 ? token : null;
}

async function renewGenerationLease(token: string): Promise<void> {
  await (
    await getDb()
  ).runAsync(
    "UPDATE generation_runtime SET lease_expires_at=? WHERE id=1 AND lease_token=?",
    Date.now() + LEASE_DURATION_MS,
    token,
  );
}

async function releaseGenerationLease(token: string): Promise<void> {
  await (
    await getDb()
  ).runAsync(
    "UPDATE generation_runtime SET lease_token=NULL,lease_expires_at=0 WHERE id=1 AND lease_token=?",
    token,
  );
}

export function isAutoGenerationRunning() {
  return inFlight !== null;
}

export function requestAutoGeneration(
  trigger: GenerationTrigger,
  options: { force?: boolean } = {},
): Promise<AutoGenerationResult> {
  if (inFlight) return inFlight;
  inFlight = runAutoGeneration(trigger, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runAutoGeneration(
  trigger: GenerationTrigger,
  options: { force?: boolean },
): Promise<AutoGenerationResult> {
  const leaseToken = await acquireGenerationLease();
  if (!leaseToken)
    return { status: "skipped", inserted: 0, reason: "in_flight" };
  try {
    return await runAutoGenerationWithLease(trigger, options, leaseToken);
  } finally {
    await releaseGenerationLease(leaseToken).catch(() => {});
  }
}

async function runAutoGenerationWithLease(
  trigger: GenerationTrigger,
  options: { force?: boolean },
  leaseToken: string,
): Promise<AutoGenerationResult> {
  const now = Date.now();
  const settings = await getAutoGenerationSettings();
  let state = await getAutoGenerationState();
  const force = options.force === true;
  if (!settings.enabled && !force)
    return { status: "skipped", inserted: 0, reason: "disabled" };
  if (!force && !(await getSetting("onboardingComplete", false)))
    return { status: "skipped", inserted: 0, reason: "not_onboarded" };
  if (!force && state.phase === "paused")
    return { status: "skipped", inserted: 0, reason: "backoff" };
  if (!force && state.nextRetryAt && state.nextRetryAt > now)
    return {
      status: "skipped",
      inserted: 0,
      reason: "backoff",
      nextRetryAt: state.nextRetryAt,
    };
  if (state.generatedToday >= settings.dailyPostLimit)
    return { status: "skipped", inserted: 0, reason: "daily_limit" };
  if (await monthlyCapReached())
    return { status: "skipped", inserted: 0, reason: "monthly_cap" };
  if (!(await hasGenerationContent()))
    return { status: "skipped", inserted: 0, reason: "no_content" };

  let unread = await unreadCount();
  const needsRefill =
    unread < settings.lowWatermark ||
    (state.refillPending && unread < settings.targetUnread);
  if (!force && !needsRefill)
    return { status: "skipped", inserted: 0, reason: "pool_full" };

  state = {
    ...state,
    phase: "running",
    lastTrigger: trigger,
    lastStartedAt: now,
    lastFinishedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextRetryAt: null,
    refillPending: !force,
  };
  await saveState(state);

  const maxBatches = trigger === "background" || force ? 1 : 3;
  let inserted = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      await renewGenerationLease(leaseToken);
      const dailyRemaining =
        settings.dailyPostLimit - state.generatedToday - inserted;
      const poolRemaining = force
        ? settings.batchSize - inserted
        : settings.targetUnread - unread;
      const requested = Math.min(
        settings.batchSize,
        dailyRemaining,
        poolRemaining,
      );
      if (requested <= 0) break;
      const count = await refillBatch(requested);
      inserted += count;
      unread += count;
      // Empty/fully deduplicated output must not cause a tight API loop.
      if (count <= 0 || force) break;
    }
    const finishedAt = Date.now();
    state = {
      ...state,
      phase: "idle",
      lastFinishedAt: finishedAt,
      lastSuccessAt: finishedAt,
      lastInserted: inserted,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextRetryAt: null,
      consecutiveFailures: 0,
      generatedToday: state.generatedToday + inserted,
      refillPending: !force && inserted > 0 && unread < settings.targetUnread,
    };
    await saveState(state);
    announce(inserted);
    return {
      status: inserted > 0 ? "generated" : "skipped",
      inserted,
      reason: inserted > 0 ? undefined : "no_content",
    };
  } catch (error) {
    const classified = classifyGenerationError(error);
    const failures = state.consecutiveFailures + 1;
    const nextRetryAt = classified.retryable
      ? Date.now() +
        computeGenerationBackoffMs(failures, classified.retryAfterMs)
      : null;
    state = {
      ...state,
      phase: classified.retryable ? "backoff" : "paused",
      lastFinishedAt: Date.now(),
      lastInserted: inserted,
      lastErrorCode: classified.code,
      lastErrorMessage: classified.message.slice(0, 1_000),
      nextRetryAt,
      consecutiveFailures: failures,
      generatedToday: state.generatedToday + inserted,
      refillPending: !force && unread < settings.targetUnread,
    };
    await saveState(state);
    announce(inserted);
    return {
      status: "failed",
      inserted,
      errorCode: classified.code,
      errorMessage: classified.message,
      retryable: classified.retryable,
      nextRetryAt: nextRetryAt ?? undefined,
    };
  }
}
