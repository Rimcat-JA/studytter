import {
  classifyGenerationError,
  type ClassifiedGenerationError,
  type GenerationFailureCode,
} from "./autogeneration";

export type ExtractionJobStatus =
  | "queued"
  | "running"
  | "backoff"
  | "failed"
  | "complete";

const RETRYABLE_CODES = new Set<GenerationFailureCode>([
  "rate_limit",
  "provider_unavailable",
  "network",
  "timeout",
  "validation",
]);
export const MAX_EXTRACTION_ATTEMPTS = 8;

export function isExtractionRetryableCode(
  code: GenerationFailureCode,
): boolean {
  return RETRYABLE_CODES.has(code);
}

export function classifyExtractionError(
  input: unknown,
  retryableOverride?: boolean,
): ClassifiedGenerationError {
  const classified = classifyGenerationError(input);
  return {
    ...classified,
    retryable:
      retryableOverride ?? isExtractionRetryableCode(classified.code),
  };
}

export function shouldRetryExtraction(
  code: GenerationFailureCode,
  attemptCount: number,
): boolean {
  return (
    isExtractionRetryableCode(code) &&
    attemptCount < MAX_EXTRACTION_ATTEMPTS
  );
}

export type ExtractionJobPresentation = {
  active: boolean;
  tone: "info" | "warning" | "success";
  titleKey:
    | "extractionJobQueued"
    | "extractionJobRunning"
    | "extractionJobBackoff"
    | "extractionJobFailed";
};

export function getExtractionJobPresentation(
  status: ExtractionJobStatus,
): ExtractionJobPresentation {
  switch (status) {
    case "queued":
      return { active: true, tone: "info", titleKey: "extractionJobQueued" };
    case "running":
      return { active: true, tone: "info", titleKey: "extractionJobRunning" };
    case "backoff":
      return {
        active: true,
        tone: "warning",
        titleKey: "extractionJobBackoff",
      };
    case "failed":
      return {
        active: false,
        tone: "warning",
        titleKey: "extractionJobFailed",
      };
    case "complete":
      // Completed jobs are normally hidden, but a stable presentation keeps
      // status rendering exhaustive for diagnostics and future screens.
      return {
        active: false,
        tone: "success",
        titleKey: "extractionJobRunning",
      };
  }
}
