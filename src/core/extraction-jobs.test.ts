import { describe, expect, it } from "vitest";
import {
  classifyExtractionError,
  getExtractionJobPresentation,
  isExtractionRetryableCode,
  MAX_EXTRACTION_ATTEMPTS,
  shouldRetryExtraction,
  type ExtractionJobStatus,
} from "./extraction-jobs";

describe("extraction job policy", () => {
  it("retries only temporary provider and output failures", () => {
    expect(classifyExtractionError({ status: 503, message: "down" })).toMatchObject(
      { code: "provider_unavailable", retryable: true },
    );
    expect(
      classifyExtractionError({ status: 429, message: "rate limit" }),
    ).toMatchObject({ code: "rate_limit", retryable: true });
    expect(classifyExtractionError(new Error("Failed to fetch"))).toMatchObject(
      { code: "network", retryable: true },
    );
    expect(classifyExtractionError(new Error("request timeout"))).toMatchObject(
      { code: "timeout", retryable: true },
    );
    expect(
      classifyExtractionError(new Error("structured output validation failed")),
    ).toMatchObject({ code: "validation", retryable: true });
    expect(
      classifyExtractionError(
        new Error(
          "Model is temporarily overloaded. Please try again after 60 seconds.",
        ),
      ),
    ).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      retryAfterMs: 60_000,
    });
  });

  it("does not loop on permanent local, authentication or model errors", () => {
    expect(
      classifyExtractionError(new Error("No PDF header: corrupt or password protected")),
    ).toMatchObject({ code: "unknown", retryable: false });
    expect(
      classifyExtractionError({ status: 401, message: "Bad API key" }),
    ).toMatchObject({ code: "authentication", retryable: false });
    expect(
      classifyExtractionError({ status: 400, message: "Model does not support PDF" }),
    ).toMatchObject({ code: "configuration", retryable: false });
    expect(isExtractionRetryableCode("unknown")).toBe(false);
  });

  it("accepts an explicit aggregate-material retry decision", () => {
    expect(classifyExtractionError({ status: 503, message: "down" }, false).retryable).toBe(
      false,
    );
    expect(classifyExtractionError(new Error("local error"), true).retryable).toBe(
      true,
    );
  });

  it("stops automatic retries at the bounded attempt limit", () => {
    expect(shouldRetryExtraction("provider_unavailable", 1)).toBe(true);
    expect(
      shouldRetryExtraction("provider_unavailable", MAX_EXTRACTION_ATTEMPTS),
    ).toBe(false);
    expect(shouldRetryExtraction("configuration", 1)).toBe(false);
  });

  it("maps every persisted status to deterministic UI state", () => {
    const statuses: ExtractionJobStatus[] = [
      "queued",
      "running",
      "backoff",
      "failed",
      "complete",
    ];
    expect(statuses.map(getExtractionJobPresentation)).toEqual([
      { active: true, tone: "info", titleKey: "extractionJobQueued" },
      { active: true, tone: "info", titleKey: "extractionJobRunning" },
      { active: true, tone: "warning", titleKey: "extractionJobBackoff" },
      { active: false, tone: "warning", titleKey: "extractionJobFailed" },
      { active: false, tone: "success", titleKey: "extractionJobRunning" },
    ]);
  });
});
