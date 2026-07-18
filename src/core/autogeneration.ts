export type AutoGenerationSettings = {
  enabled: boolean;
  lowWatermark: number;
  targetUnread: number;
  batchSize: number;
  foregroundIntervalMinutes: number;
  backgroundIntervalMinutes: number;
  dailyPostLimit: number;
};

export const DEFAULT_AUTO_GENERATION_SETTINGS: AutoGenerationSettings = {
  enabled: true,
  lowWatermark: 30,
  targetUnread: 45,
  batchSize: 10,
  foregroundIntervalMinutes: 2,
  backgroundIntervalMinutes: 30,
  dailyPostLimit: 60,
};

const integer = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.round(parsed)))
    : fallback;
};

export function normalizeAutoGenerationSettings(
  value: Partial<AutoGenerationSettings> | null | undefined,
): AutoGenerationSettings {
  const defaults = DEFAULT_AUTO_GENERATION_SETTINGS;
  const lowWatermark = integer(
    value?.lowWatermark,
    defaults.lowWatermark,
    1,
    500,
  );
  return {
    enabled: value?.enabled ?? defaults.enabled,
    lowWatermark,
    targetUnread: integer(
      value?.targetUnread,
      Math.max(defaults.targetUnread, lowWatermark + 1),
      lowWatermark + 1,
      1_000,
    ),
    batchSize: integer(value?.batchSize, defaults.batchSize, 1, 20),
    foregroundIntervalMinutes: integer(
      value?.foregroundIntervalMinutes,
      defaults.foregroundIntervalMinutes,
      1,
      60,
    ),
    // expo-background-task uses minutes and Android's minimum is 15 minutes.
    backgroundIntervalMinutes: integer(
      value?.backgroundIntervalMinutes,
      defaults.backgroundIntervalMinutes,
      15,
      1_440,
    ),
    dailyPostLimit: integer(
      value?.dailyPostLimit,
      defaults.dailyPostLimit,
      1,
      500,
    ),
  };
}

export type GenerationFailureCode =
  | "authentication"
  | "configuration"
  | "rate_limit"
  | "provider_unavailable"
  | "network"
  | "timeout"
  | "validation"
  | "unknown";

export type ClassifiedGenerationError = {
  code: GenerationFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; headers?: unknown };
  responseHeaders?: unknown;
  lastError?: unknown;
  cause?: unknown;
  errors?: unknown;
};

const statusOf = (error: ErrorLike): number | undefined => {
  const value = error.statusCode ?? error.status ?? error.response?.status;
  return typeof value === "number" ? value : undefined;
};

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function")
    return (headers as { get: (key: string) => string | null }).get(name);
  if (typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const matchingKey = Object.keys(record).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    const value = matchingKey ? record[matchingKey] : undefined;
    return typeof value === "string" ? value : null;
  }
  return null;
}

function retryAfter(error: ErrorLike, now: number): number | undefined {
  const raw =
    headerValue(error.responseHeaders, "retry-after") ??
    headerValue(error.response?.headers, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function errorChain(input: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 8) return;
    if (seen.has(value)) return;
    seen.add(value);
    const error = value as ErrorLike;
    chain.push(error);
    // AI_RetryError stores the useful HTTP error in lastError/errors. Causes
    // are also common in fetch wrappers, so inspect all without trusting only
    // the outer generic "Failed after N attempts" message.
    visit(error.lastError, depth + 1);
    visit(error.cause, depth + 1);
    if (Array.isArray(error.errors))
      for (let index = error.errors.length - 1; index >= 0; index--)
        visit(error.errors[index], depth + 1);
  };
  visit(input, 0);
  return chain;
}

function retryAfterFromMessage(message: string): number | undefined {
  const match = message.match(
    /(?:retry|try(?:\s+again)?|please\s+try(?:\s+again)?)?\s*after\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i,
  );
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit.startsWith("m") && unit !== "ms" && !unit.startsWith("milli"))
    return amount * 60_000;
  if (unit === "ms" || unit.startsWith("milli")) return amount;
  return amount * 1_000;
}

function retryAfterFromChain(
  chain: readonly ErrorLike[],
  message: string,
  now: number,
): number | undefined {
  for (const error of chain) {
    const value = retryAfter(error, now);
    if (value !== undefined) return value;
  }
  return retryAfterFromMessage(message);
}

export function classifyGenerationError(
  input: unknown,
  now = Date.now(),
): ClassifiedGenerationError {
  const chain = errorChain(input);
  const error = chain[0] ?? ({} as ErrorLike);
  const outerMessage =
    typeof error.message === "string" ? error.message : String(input);
  const innerMessages = chain
    .slice(1)
    .map((item) => item.message)
    .filter((item): item is string => typeof item === "string");
  const message =
    /^Failed after \d+ attempts\.?$/i.test(outerMessage.trim()) &&
    innerMessages[0]
      ? `${outerMessage} Last error: ${innerMessages[0]}`
      : outerMessage;
  const combinedMessage = [outerMessage, ...innerMessages].join("\n");
  const lower = combinedMessage.toLocaleLowerCase();
  const status = chain.map(statusOf).find((value) => value !== undefined);
  const retryAfterMs = retryAfterFromChain(chain, combinedMessage, now);
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  )
    return { code: "authentication", message, retryable: false };
  if (
    (status === 400 || status === 404 || status === 422) &&
    /(model|base.?url|endpoint|not found|unsupported)/i.test(combinedMessage)
  )
    return { code: "configuration", message, retryable: false };
  if (status === 429 || lower.includes("rate limit"))
    return {
      code: "rate_limit",
      message,
      retryable: true,
      retryAfterMs,
    };
  if (
    chain.some((item) => item.name === "AbortError") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  )
    return { code: "timeout", message, retryable: true };
  if (
    (status !== undefined && status >= 500) ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("temporarily overloaded") ||
    lower.includes("overloaded") ||
    lower.includes("all_fallbacks_failed") ||
    lower.includes("capacity")
  )
    return {
      code: "provider_unavailable",
      message,
      retryable: true,
      retryAfterMs,
    };
  if (
    lower.includes("network request failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("socket") ||
    lower.includes("econn")
  )
    return { code: "network", message, retryable: true };
  if (
    lower.includes("schema") ||
    lower.includes("validation") ||
    lower.includes("structured output") ||
    lower.includes("no object generated")
  )
    return { code: "validation", message, retryable: true };
  return { code: "unknown", message, retryable: true };
}

export function computeGenerationBackoffMs(
  consecutiveFailures: number,
  retryAfterMs?: number,
  rng: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(20, consecutiveFailures - 1));
  const exponential = Math.min(6 * 60 * 60_000, 60_000 * 2 ** exponent);
  const jittered = Math.round(exponential * (0.8 + 0.4 * rng()));
  return Math.max(jittered, retryAfterMs ?? 0);
}
