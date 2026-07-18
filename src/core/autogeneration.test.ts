import { describe, expect, it } from "vitest";
import {
  classifyGenerationError,
  computeGenerationBackoffMs,
  normalizeAutoGenerationSettings,
} from "./autogeneration";

describe("auto generation policy", () => {
  it("normalizes unsafe settings and keeps target above low watermark", () => {
    expect(
      normalizeAutoGenerationSettings({
        lowWatermark: 50,
        targetUnread: 10,
        batchSize: 99,
        foregroundIntervalMinutes: 0,
        backgroundIntervalMinutes: 1,
        dailyPostLimit: 0,
      }),
    ).toMatchObject({
      lowWatermark: 50,
      targetUnread: 51,
      batchSize: 20,
      foregroundIntervalMinutes: 1,
      backgroundIntervalMinutes: 15,
      dailyPostLimit: 1,
    });
  });

  it("classifies configuration errors as non-retryable", () => {
    expect(
      classifyGenerationError({ statusCode: 401, message: "Bad API key" }),
    ).toMatchObject({ code: "authentication", retryable: false });
    expect(
      classifyGenerationError({ status: 404, message: "Model not found" }),
    ).toMatchObject({ code: "configuration", retryable: false });
  });

  it("honors Retry-After for rate limits", () => {
    const error = classifyGenerationError({
      status: 429,
      message: "Rate limit",
      responseHeaders: { "retry-after": "120" },
    });
    expect(error).toMatchObject({
      code: "rate_limit",
      retryable: true,
      retryAfterMs: 120_000,
    });
    expect(computeGenerationBackoffMs(1, error.retryAfterMs, () => 0)).toBe(
      120_000,
    );
  });

  it("backs off exponentially with a six-hour ceiling and jitter", () => {
    expect(computeGenerationBackoffMs(1, undefined, () => 0.5)).toBe(60_000);
    expect(computeGenerationBackoffMs(3, undefined, () => 0.5)).toBe(240_000);
    expect(computeGenerationBackoffMs(99, undefined, () => 0.5)).toBe(
      6 * 60 * 60_000,
    );
  });

  it("recognizes network, provider and validation failures", () => {
    expect(classifyGenerationError(new Error("Failed to fetch")).code).toBe(
      "network",
    );
    expect(
      classifyGenerationError({ status: 503, message: "down" }).code,
    ).toBe("provider_unavailable");
    expect(
      classifyGenerationError(new Error("structured output validation failed"))
      .code,
    ).toBe("validation");
  });

  it("treats the reported overloaded model error as a timed provider outage", () => {
    expect(
      classifyGenerationError(
        new Error(
          "Model is temporarily overloaded. Please try again after 60 seconds or choose another model.",
        ),
      ),
    ).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      retryAfterMs: 60_000,
    });
  });

  it("unwraps AI retry errors and honors inner status and Retry-After", () => {
    const inner = {
      statusCode: 429,
      message: "upstream rate limit",
      responseHeaders: { "Retry-After": "75" },
    };
    const outer = {
      name: "AI_RetryError",
      message: "Failed after 2 attempts",
      lastError: inner,
      errors: [inner],
    };
    const classified = classifyGenerationError(outer);
    expect(classified).toMatchObject({
      code: "rate_limit",
      retryable: true,
      retryAfterMs: 75_000,
    });
    expect(classified.message).toContain("upstream rate limit");
  });

  it("unwraps an inner 503 instead of classifying the retry wrapper as unknown", () => {
    expect(
      classifyGenerationError({
        name: "AI_RetryError",
        message: "Failed after 2 attempts",
        lastError: { status: 503, message: "all_fallbacks_failed" },
      }),
    ).toMatchObject({ code: "provider_unavailable", retryable: true });
  });

  it("unwraps an inner model error as non-retryable configuration", () => {
    expect(
      classifyGenerationError({
        name: "AI_RetryError",
        message: "Failed after 2 attempts",
        lastError: { status: 404, message: "Model not found" },
      }),
    ).toMatchObject({ code: "configuration", retryable: false });
  });
});
