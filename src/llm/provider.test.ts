import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as SecureStore from "expo-secure-store";

import { DEFAULT_PROVIDER_CONFIG, getPurposeRoute, normalizeBaseUrl, setProviderConfig, setPurposeRoute, type ProviderId } from "./config";
import { createProvider, getApiKey, listProviderModels, setApiKey, setProviderHeaders, testProviderCredentials } from "./provider";

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(), secrets: new Map<string, string>(),
  generate: vi.fn(), stream: vi.fn(), openai: vi.fn(), anthropic: vi.fn(), google: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("../db/database", () => ({
  getSetting: async (key: string, fallback: unknown) => mocks.settings.get(key) ?? fallback,
  setSetting: async (key: string, value: unknown) => { mocks.settings.set(key, value); },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => mocks.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.secrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.secrets.delete(key); },
}));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mocks.openai }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mocks.anthropic }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI: mocks.google }));
vi.mock("ai", () => ({ generateText: mocks.generate, streamText: mocks.stream, Output: { object: (value: unknown) => value }, jsonSchema: (value: unknown) => value }));

const request = { model: "test-model", system: "JSON", user: [{ type: "text" as const, text: "ok" }], schema: z.object({ ok: z.boolean() }), maxTokens: 100 };

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.settings.clear(); mocks.secrets.clear();
  mocks.generate.mockReset().mockResolvedValue({ output: { ok: true }, usage: {} });
  mocks.openai.mockReset().mockImplementation((config) => Object.assign((model: string) => ({ config, model, protocol: "responses" }), { chat: (model: string) => ({ config, model, protocol: "chat" }) }));
  mocks.anthropic.mockReset().mockImplementation((config) => (model: string) => ({ config, model, protocol: "anthropic" }));
  mocks.google.mockReset().mockImplementation((config) => (model: string) => ({ config, model, protocol: "gemini" }));
});

describe("provider routing and secrets", () => {
  it.each(["openai", "anthropic", "nanogpt", "openrouter", "gemini", "custom"] as ProviderId[])("uses %s's endpoint, adapter, and key", async (id) => {
    if (id === "ollama") return;
    await setApiKey(id, `${id}-secret`);
    await createProvider(id).generateJson(request);
    const call = mocks.generate.mock.calls[0][0];
    expect(call.model.config).toMatchObject({ apiKey: `${id}-secret`, baseURL: DEFAULT_PROVIDER_CONFIG[id].baseUrl });
    expect(call.model.protocol).toBe(id === "anthropic" || id === "gemini" ? id : id === "openai" ? "responses" : "chat");
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await call.model.config.fetch("https://example.com/request", { method: "POST", redirect: "follow" });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error" });
  });
  it("does not send a saved key when its endpoint changes", async () => {
    await setApiKey("openai", "private-key");
    await setProviderConfig("openai", { baseUrl: "https://other.example/v1", protocol: "chat" });
    await expect(createProvider("openai").generateJson(request)).rejects.toThrow(/接続先/);
    expect(mocks.generate).not.toHaveBeenCalled();
    await setApiKey("openai", "replacement");
    await expect(createProvider("openai").generateJson(request)).resolves.toMatchObject({ data: { ok: true } });
    expect(await getApiKey("openai")).toBe("replacement");
  });
  it("binds verified draft keys to the tested URL and prevents header override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":{}}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await testProviderCredentials("openrouter", { apiKey: "draft", baseUrl: "https://proxy.example/v1" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://proxy.example/v1/key");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer draft");
    await expect(setProviderHeaders("openai", { authorization: "Bearer wrong" })).rejects.toThrow(/APIキー/);
  });
  it("never reuses secret headers on another endpoint", async () => {
    await setApiKey("custom", "key");
    await setProviderHeaders("custom", { "X-Proxy-Secret": "private" });
    await expect(createProvider("custom", { baseUrl: "https://other.example/v1", apiKey: "new-key" }).generateJson(request)).rejects.toThrow(/追加ヘッダー/);
    await expect(createProvider("custom", { baseUrl: "https://other.example/v1", apiKey: "new-key", headers: { "x-proxy-secret": "private" } }).generateJson(request)).rejects.toThrow(/追加ヘッダー/);
  });
  it("does not pair an old resolved endpoint with a key saved concurrently for another endpoint", async () => {
    await setApiKey("openai", "original-key");
    const read = SecureStore.getItemAsync;
    vi.spyOn(SecureStore, "getItemAsync").mockImplementation(async (key) => {
      if (key === "apikey.openai") {
        mocks.settings.set("llm.provider.openai.baseUrl", "https://new.example/v1");
        return JSON.stringify({ version: 1, key: "new-endpoint-key", baseUrl: "https://new.example/v1" });
      }
      return read(key);
    });
    await expect(createProvider("openai").generateJson(request)).rejects.toThrow(/接続先/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("validates secret headers and their endpoint from the same saved record", async () => {
    await setProviderConfig("custom", { baseUrl: "https://new.example/v1", protocol: "chat" });
    await setApiKey("custom", "new-key");
    await setProviderHeaders("custom", { "X-Proxy-Secret": "old-secret" }, "https://old.example/v1");
    const read = SecureStore.getItemAsync;
    vi.spyOn(SecureStore, "getItemAsync").mockImplementation(async (key) => {
      const snapshot = await read(key);
      if (key === "providerheaders.custom")
        mocks.secrets.set(key, JSON.stringify({ version: 1, headers: { "X-Proxy-Secret": "new-secret" }, baseUrl: "https://new.example/v1" }));
      return snapshot;
    });
    await expect(createProvider("custom").generateJson(request)).rejects.toThrow(/追加ヘッダー/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("keeps configured provider and model routes", async () => {
    await setPurposeRoute("extraction", { providerId: "gemini", model: "model-z" });
    expect(await getPurposeRoute("extraction")).toEqual({ providerId: "gemini", model: "model-z" });
  });
  it("normalizes Gemini catalog model names and sends native credentials", async () => {
    await setApiKey("gemini", "google-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"models":[{"name":"models/gemini-2.5-flash"}]}'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await listProviderModels("gemini")).toMatchObject([{ id: "gemini-2.5-flash", pdfInput: true }]);
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("google-key");
  });
  it("propagates stream failures instead of saving an empty successful answer", async () => {
    await setApiKey("openai", "key");
    mocks.stream.mockReturnValue({ fullStream: (async function* () { yield { type: "text-delta", text: "partial" }; yield { type: "error", error: new Error("network failed") }; })() });
    const stream = createProvider("openai").streamText(request)[Symbol.asyncIterator]();
    expect(await stream.next()).toEqual({ done: false, value: "partial" });
    await expect(stream.next()).rejects.toThrow("network failed");
  });
  it("does not expose a proxy's echoed credentials through generated or streamed errors", async () => {
    await setApiKey("openai", "private-key");
    const upstream = Object.assign(new Error("Rejected private-key"), { statusCode: 429, responseBody: "private-key", responseHeaders: { "retry-after": "30" } });
    mocks.generate.mockRejectedValue({ name: "AI_RetryError", message: "Failed after 2 attempts.", lastError: upstream });
    const error = await createProvider("openai").generateJson(request).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "Provider rate limit reached (429).", statusCode: 429, responseHeaders: { "retry-after": "30" } });
    expect(JSON.stringify(error)).not.toContain("private-key");
    expect(error).not.toHaveProperty("responseBody");
    mocks.stream.mockReturnValue({ fullStream: (async function* () { yield { type: "error", error: upstream }; })() });
    await expect(createProvider("openai").streamText(request)[Symbol.asyncIterator]().next()).rejects.toThrow("Provider rate limit reached (429).");
  });
  it.each(["ftp://example.com", "https://key:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#x"])("rejects unsafe base URL %s", (url) => {
    expect(() => normalizeBaseUrl(url)).toThrow();
  });
});
