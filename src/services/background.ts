import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { getSetting, setSetting } from "../db/database";
import {
  getAutoGenerationSettings,
  isAutoGenerationRunning,
  requestAutoGeneration,
} from "./autogeneration";
import {
  hasPendingExtractionJobs,
  recoverPendingExtractionJobs,
  requestExtractionWork,
} from "./extraction-jobs";

const TASK = "learnstream-refill";
const EXTRACTION_INTERVAL_MINUTES = 15;
const REGISTRATION_INTERVAL_KEY = "autoGenerationRegisteredIntervalMinutes";
const BACKGROUND_STATUS_KEY = "autoGenerationBackgroundStatus";
const EXTRACTION_BACKGROUND_STATUS_KEY = "extractionBackgroundStatus";

export type BackgroundRefillStatus = {
  available: boolean;
  registered: boolean;
  intervalMinutes: number | null;
  errorMessage: string | null;
  checkedAt: number;
};

TaskManager.defineTask(TASK, async () => {
  let extractionRetryableFailure = false;
  let generationRetryableFailure = false;
  try {
    // Expo BackgroundTask uses one Android worker for all registered tasks.
    // Run both queues from that worker so neither registration can starve the
    // other. Both service APIs are single-flight and join foreground callers.
    const extraction = await requestExtractionWork("background");
    extractionRetryableFailure =
      (extraction.status === "failed" && extraction.retryable === true) ||
      (extraction.status === "skipped" && extraction.reason === "backoff");
  } catch {
    extractionRetryableFailure = true;
  }
  try {
    // The immediate extraction worker must not join a generation promise that
    // was already started by the foreground app. That work owns its own lease
    // and lifecycle; joining it here can keep the data-sync notification alive
    // after extraction has finished if the Activity that started it goes away.
    // A periodic run will refill the feed independently when needed.
    if (!isAutoGenerationRunning()) {
      const generation = await requestAutoGeneration("background");
      generationRetryableFailure =
        generation.status === "failed" && generation.retryable === true;
    }
  } catch {
    generationRetryableFailure = true;
  }
  // Do not mutate the Expo periodic registration from inside the callback that
  // our immediate WorkManager worker is awaiting. Android testing showed that
  // the extraction and registration writes both completed, but the Expo task
  // completion callback was then never delivered, leaving the foreground
  // data-sync notification running. Registration changes are lifecycle work,
  // not part of completing the durable extraction transaction.
  //
  // Registration is reconciled when work is enqueued, when generation
  // settings change, and whenever the app starts. Keeping the existing
  // periodic fallback until the next reconciliation is safe and preserves
  // recovery if Android interrupts this run.
  return extractionRetryableFailure || generationRetryableFailure
    ? BackgroundTask.BackgroundTaskResult.Failed
    : BackgroundTask.BackgroundTaskResult.Success;
});

async function persistStatus(
  value: Omit<BackgroundRefillStatus, "checkedAt">,
): Promise<BackgroundRefillStatus> {
  const status = { ...value, checkedAt: Date.now() };
  await setSetting(BACKGROUND_STATUS_KEY, status);
  return status;
}

export async function getBackgroundRefillStatus(): Promise<BackgroundRefillStatus> {
  const stored = await getSetting<BackgroundRefillStatus>(
    BACKGROUND_STATUS_KEY,
    {
      available: false,
      registered: false,
      intervalMinutes: null,
      errorMessage: null,
      checkedAt: 0,
    },
  );
  try {
    const available =
      (await BackgroundTask.getStatusAsync()) ===
      BackgroundTask.BackgroundTaskStatus.Available;
    const registered = await TaskManager.isTaskRegisteredAsync(TASK);
    return {
      ...stored,
      available,
      registered,
      errorMessage: null,
      intervalMinutes: registered
        ? await getSetting<number | null>(REGISTRATION_INTERVAL_KEY, null)
        : null,
    };
  } catch {
    return stored;
  }
}

export async function syncBackgroundRefillRegistration(): Promise<BackgroundRefillStatus> {
  const settings = await getAutoGenerationSettings();
  try {
    const available =
      (await BackgroundTask.getStatusAsync()) ===
      BackgroundTask.BackgroundTaskStatus.Available;
    let registered = await TaskManager.isTaskRegisteredAsync(TASK);
    const registeredInterval = await getSetting<number | null>(
      REGISTRATION_INTERVAL_KEY,
      null,
    );
    const extractionPending = await hasPendingExtractionJobs();
    const desiredInterval = extractionPending
      ? EXTRACTION_INTERVAL_MINUTES
      : settings.enabled
        ? settings.backgroundIntervalMinutes
        : null;

    if (!available || desiredInterval === null) {
      if (registered) await BackgroundTask.unregisterTaskAsync(TASK);
      await setSetting(REGISTRATION_INTERVAL_KEY, null);
      return persistStatus({
        available,
        registered: false,
        intervalMinutes: null,
        errorMessage: null,
      });
    }

    if (
      registered &&
      registeredInterval !== desiredInterval
    ) {
      await BackgroundTask.unregisterTaskAsync(TASK);
      registered = false;
    }
    if (!registered) {
      // Expo expects minutes here. Android schedules this inexactly and may run later.
      await BackgroundTask.registerTaskAsync(TASK, {
        minimumInterval: desiredInterval,
      });
      registered = await TaskManager.isTaskRegisteredAsync(TASK);
    }
    await setSetting(
      REGISTRATION_INTERVAL_KEY,
      registered ? desiredInterval : null,
    );
    return persistStatus({
      available,
      registered,
      intervalMinutes: registered ? desiredInterval : null,
      errorMessage: null,
    });
  } catch (error) {
    return persistStatus({
      available: false,
      registered: false,
      intervalMinutes: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getBackgroundExtractionStatus(): Promise<BackgroundRefillStatus> {
  const stored = await getSetting<BackgroundRefillStatus>(
    EXTRACTION_BACKGROUND_STATUS_KEY,
    {
      available: false,
      registered: false,
      intervalMinutes: null,
      errorMessage: null,
      checkedAt: 0,
    },
  );
  try {
    const available =
      (await BackgroundTask.getStatusAsync()) ===
      BackgroundTask.BackgroundTaskStatus.Available;
    const pending = await hasPendingExtractionJobs();
    const registered = await TaskManager.isTaskRegisteredAsync(TASK);
    return {
      ...stored,
      available,
      registered: pending && registered,
      intervalMinutes:
        pending && registered ? EXTRACTION_INTERVAL_MINUTES : null,
      errorMessage: null,
    };
  } catch {
    return stored;
  }
}

export async function syncBackgroundExtractionRegistration(): Promise<BackgroundRefillStatus> {
  try {
    const pending = await hasPendingExtractionJobs();
    const shared = await syncBackgroundRefillRegistration();
    const status = {
      ...shared,
      registered: pending && shared.registered,
      intervalMinutes:
        pending && shared.registered ? EXTRACTION_INTERVAL_MINUTES : null,
      checkedAt: Date.now(),
    } satisfies BackgroundRefillStatus;
    await setSetting(EXTRACTION_BACKGROUND_STATUS_KEY, status);
    return status;
  } catch (error) {
    const status = {
      available: false,
      registered: false,
      intervalMinutes: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    } satisfies BackgroundRefillStatus;
    await setSetting(EXTRACTION_BACKGROUND_STATUS_KEY, status);
    return status;
  }
}

export async function registerBackgroundRefill() {
  await recoverPendingExtractionJobs();
  return syncBackgroundRefillRegistration();
}
