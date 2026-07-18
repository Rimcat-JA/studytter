import type { ProviderId } from "./config";

type CredentialProviderId = Exclude<ProviderId, "ollama">;

export class ProviderCredentialError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderCredentialError";
    this.status = status;
  }
}

export function credentialProbeUrl(
  providerId: CredentialProviderId,
  baseUrl: string,
): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");

  if (providerId === "nanogpt") {
    // NanoGPT's model catalog deliberately succeeds even for an invalid key.
    // Subscription usage is authenticated and does not invoke a model, so an
    // overloaded model cannot make a valid key look invalid during onboarding.
    if (/\/api\/subscription\/v1$/i.test(path)) {
      url.pathname = `${path}/usage`;
    } else if (/^(?:www\.)?nano-gpt\.com$/i.test(url.hostname)) {
      url.pathname = "/api/subscription/v1/usage";
    } else {
      // Preserve compatibility with a user-configured NanoGPT proxy whose
      // subscription API is rooted at the configured base URL.
      url.pathname = `${path}/usage`;
    }
  } else {
    url.pathname = `${path}/models`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function probeProviderCredentials(options: {
  providerId: CredentialProviderId;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { providerId, baseUrl, apiKey } = options;
  const authenticationHeaders: Record<string, string> =
    providerId === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : { Authorization: `Bearer ${apiKey}` };
  const response = await (options.fetchImpl ?? fetch)(
    credentialProbeUrl(providerId, baseUrl),
    {
      method: "GET",
      headers: { ...authenticationHeaders, ...(options.headers ?? {}) },
    },
  );
  const body = await response.text();
  if (!response.ok) {
    const providerName =
      providerId === "openai"
        ? "OpenAI"
        : providerId === "anthropic"
          ? "Anthropic"
          : "NanoGPT";
    throw new ProviderCredentialError(
      `${providerName} credential check failed (${response.status})${
        body ? `: ${body.slice(0, 400)}` : ""
      }`,
      response.status,
    );
  }

  // Reject captive-portal/proxy HTML even when it responds with HTTP 200.
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") throw new Error();
  } catch {
    throw new ProviderCredentialError(
      "認証確認先からJSONではない応答が返されました。Base URLを確認してください。",
      502,
    );
  }
}
