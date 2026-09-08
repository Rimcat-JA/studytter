import type { ProviderId } from "./config";
import { fetchJson } from "./transport";

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
    url.pathname = `${path}/${providerId === "openrouter" ? "key" : "models"}`;
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
  try {
    await fetchJson(
    credentialProbeUrl(providerId, baseUrl),
    {
      method: "GET",
      headers: { ...(options.headers ?? {}), ...authenticationHeaders(providerId, apiKey) },
    },
    options.fetchImpl,
  );
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && typeof error.status === "number")
      throw new ProviderCredentialError(`Credential check failed (${error.status}).`, error.status);
    throw error;
  }
}

export function authenticationHeaders(providerId: ProviderId, apiKey: string): Record<string, string> {
  if (providerId === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  if (providerId === "gemini") return { "x-goog-api-key": apiKey };
  if (providerId === "ollama") return {};
  return { Authorization: `Bearer ${apiKey}` };
}
