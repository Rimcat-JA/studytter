import { describe, expect, it, vi } from "vitest";
import {
  credentialProbeUrl,
  probeProviderCredentials,
} from "./credentials";

describe("provider credential probe", () => {
  it("uses NanoGPT subscription usage instead of invoking a model", () => {
    expect(
      credentialProbeUrl(
        "nanogpt",
        "https://nano-gpt.com/api/subscription/v1",
      ),
    ).toBe("https://nano-gpt.com/api/subscription/v1/usage");
    expect(
      credentialProbeUrl("nanogpt", "https://nano-gpt.com/api/v1"),
    ).toBe("https://nano-gpt.com/api/subscription/v1/usage");
  });

  it("accepts an authenticated response without any chat request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ active: true, state: "active" }), {
        status: 200,
      }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await probeProviderCredentials({
      providerId: "nanogpt",
      baseUrl: "https://nano-gpt.com/api/subscription/v1",
      apiKey: "test-key",
      fetchImpl,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://nano-gpt.com/api/subscription/v1/usage",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("preserves 401 so callers do not save a rejected key", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await expect(
      probeProviderCredentials({
        providerId: "nanogpt",
        baseUrl: "https://nano-gpt.com/api/subscription/v1",
        apiKey: "rejected-key",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "ProviderCredentialError",
      status: 401,
    });
  });

  it("uses authenticated model catalogs for OpenAI and Anthropic", () => {
    expect(
      credentialProbeUrl("openai", "https://api.openai.com/v1/"),
    ).toBe("https://api.openai.com/v1/models");
    expect(
      credentialProbeUrl("anthropic", "https://api.anthropic.com/v1"),
    ).toBe("https://api.anthropic.com/v1/models");
  });
});
