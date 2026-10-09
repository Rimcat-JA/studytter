/** A total deadline that also aborts the active native fetch/body stream. */
export function requestDeadline(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    const error = new Error("AI request timed out. Please retry.");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
      // In browsers a post-completion abort surfaces as an unhandled
      // AbortError from fetch internals; the request is already settled.
      if (typeof document !== "undefined") return;
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

/** SDK transports must use the same redirect policy as credential probes. */
export const providerFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: "error" });

// Web demo debugging: show the provider's own reason, with key-like tokens redacted.
function webErrorDetail(body: unknown): string {
  if (typeof window === "undefined" || typeof body !== "string" || !body) return "";
  let text = body;
  try {
    const e = JSON.parse(body).error;
    text = [e?.message, e?.metadata?.raw].filter(Boolean).join(" | ") || body;
  } catch {}
  return " " + String(text).replace(/(sk|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]").slice(0, 400);
}

/** API/Retry errors can contain echoed credentials in both message and body.
 * Preserve status/backoff metadata without retaining the server's raw text. */
export function sanitizeProviderError(input: unknown): unknown {
  const pending: unknown[] = [input];
  const seen = new Set<unknown>();
  let hasResponseBody = false;
  for (let inspected = 0; pending.length && inspected < 32; inspected++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const item = value as Record<string, unknown>;
    hasResponseBody ||= "responseBody" in item;
    const status = typeof item.statusCode === "number" ? item.statusCode : item.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      const message = status === 401 || status === 403 ? `Provider authentication failed (${status}).`
        : status === 429 ? `Provider rate limit reached (${status}).`
        : [400, 404, 422].includes(status) ? `Provider rejected the request, model or endpoint (${status}).`
        : `Provider request failed (${status}).`;
      const safe = new Error(message + webErrorDetail(item.responseBody)) as Error & { status: number; statusCode: number; responseHeaders?: Record<string, string> };
      safe.status = status;
      safe.statusCode = status;
      if (item.responseHeaders && typeof item.responseHeaders === "object") {
        const retry = (item.responseHeaders as Record<string, unknown>)["retry-after"];
        if (typeof retry === "string" && retry.length <= 100) safe.responseHeaders = { "retry-after": retry };
      }
      return safe;
    }
    pending.push(item.lastError, item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(-10));
  }
  if (hasResponseBody) return new Error("Provider returned an invalid response.");
  return input;
}

export async function fetchJson(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Promise<unknown> {
  const deadline = requestDeadline(timeoutMs, init.signal ?? undefined);
  try {
    const response = await fetchImpl(url, { ...init, signal: deadline.signal, redirect: "error" });
    if (!response.ok) {
      // Proxy errors can echo API keys: never persist raw response bodies.
      const error = new Error(`Provider request failed (${response.status}).`) as Error & { status: number; responseHeaders: Record<string, string> };
      error.status = response.status;
      error.responseHeaders = { "retry-after": response.headers.get("retry-after") ?? "" };
      throw error;
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error("Provider returned invalid JSON.");
    return body;
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason ?? error;
    if (error instanceof SyntaxError) throw new Error("認証確認先からJSONではない応答が返されました。Base URLを確認してください。");
    throw error;
  } finally {
    deadline.dispose();
  }
}
