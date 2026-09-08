import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./transport";
afterEach(() => vi.useRealTimers());

describe("bounded provider transport", () => {
  it("aborts hung requests after a deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })) as unknown as typeof fetch;
    const result = expect(fetchJson("https://example.com", {}, fetchMock, 50)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(51);
    await result;
  });
  it("rejects HTML and retains HTTP status without exposing echoed secrets", async () => {
    await expect(fetchJson("https://example.com", {}, vi.fn().mockResolvedValue(new Response("<html>proxy</html>")))).rejects.toThrow(/JSON/);
    await expect(fetchJson("https://example.com", {}, vi.fn().mockResolvedValue(new Response("secret-key", { status: 429 })))).rejects.toMatchObject({ status: 429, message: "Provider request failed (429)." });
  });
});
