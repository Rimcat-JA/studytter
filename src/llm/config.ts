import { Platform } from "react-native";
import { getSetting, setSetting } from "../db/database";

export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "nanogpt",
  "openrouter",
  "gemini",
  "custom",
  "ollama",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const LLM_PURPOSES = ["extraction", "generation", "deepdive"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];
export type OpenAIProtocol = "responses" | "chat";

export type ProviderConfig = {
  baseUrl: string;
  protocol: OpenAIProtocol;
};

export type PurposeRoute = {
  providerId: ProviderId;
  model: string;
};

const androidOllamaUrl = "http://10.0.2.2:11434/v1";
const localOllamaUrl = "http://127.0.0.1:11434/v1";

export const DEFAULT_PROVIDER_CONFIG: Record<ProviderId, ProviderConfig> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    protocol: "responses",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "chat",
  },
  nanogpt: {
    baseUrl: "https://nano-gpt.com/api/subscription/v1",
    protocol: "chat",
  },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", protocol: "chat" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "chat" },
  custom: { baseUrl: "https://api.example.com/v1", protocol: "chat" },
  ollama: {
    baseUrl: Platform.OS === "android" ? androidOllamaUrl : localOllamaUrl,
    protocol: "chat",
  },
};

export const DEFAULT_MODELS: Record<ProviderId, Record<LlmPurpose, string>> = {
  openai: {
    extraction: "gpt-5.4",
    generation: "gpt-5.4-mini",
    deepdive: "gpt-5.4",
  },
  anthropic: {
    extraction: "claude-sonnet-4-6",
    generation: "claude-haiku-4-5",
    deepdive: "claude-sonnet-4-6",
  },
  nanogpt: {
    extraction: "deepseek-chat",
    generation: "deepseek-chat",
    deepdive: "deepseek-chat",
  },
  openrouter: {
    extraction: "google/gemini-2.5-flash",
    generation: "openai/gpt-5.4-mini",
    deepdive: "openai/gpt-5.4-mini",
  },
  gemini: {
    extraction: "gemini-2.5-flash",
    generation: "gemini-2.5-flash",
    deepdive: "gemini-2.5-flash",
  },
  custom: { extraction: "", generation: "", deepdive: "" },
  ollama: {
    extraction: "",
    generation: "llama3.2",
    deepdive: "llama3.2",
  },
};

const providerConfigKey = (providerId: ProviderId, field: string) =>
  `llm.provider.${providerId}.${field}`;

export function isProviderId(value: unknown): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

export function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("Base URLを入力してください。");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("Base URLの形式が正しくありません。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Base URLはhttp://またはhttps://で始めてください。");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Base URLに認証情報・クエリ・フラグメントは含められません。");
  return url.toString().replace(/\/+$/, "");
}

export const providerName = (id: ProviderId): string => ({
  openai: "OpenAI", anthropic: "Anthropic", nanogpt: "NanoGPT",
  openrouter: "OpenRouter", gemini: "Gemini", custom: "OpenAI互換", ollama: "Ollama",
})[id];

export const supportsResponses = (id: ProviderId) => id === "openai" || id === "custom";

export async function getProviderConfig(
  providerId: ProviderId,
): Promise<ProviderConfig> {
  const defaults = DEFAULT_PROVIDER_CONFIG[providerId];
  // ollamaBaseUrl was used by v1. Keep reading it so existing installs migrate
  // without losing the user's host/emulator endpoint.
  const legacyBaseUrl =
    providerId === "ollama"
      ? await getSetting("ollamaBaseUrl", defaults.baseUrl)
      : defaults.baseUrl;
  const storedProtocol =
    supportsResponses(providerId)
      ? await getSetting<unknown>(
          providerConfigKey(providerId, "protocol"),
          defaults.protocol,
        )
      : defaults.protocol;
  return {
    baseUrl: await getSetting(
      providerConfigKey(providerId, "baseUrl"),
      legacyBaseUrl,
    ),
    protocol:
      supportsResponses(providerId)
        ? storedProtocol === "chat"
          ? "chat"
          : "responses"
        : defaults.protocol,
  };
}

export async function setProviderConfig(
  providerId: ProviderId,
  config: ProviderConfig,
): Promise<void> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const protocol = supportsResponses(providerId) ? config.protocol : "chat";
  if (protocol !== "chat" && protocol !== "responses") throw new Error("API protocol is invalid.");
  await setSetting(providerConfigKey(providerId, "baseUrl"), baseUrl);
  await setSetting(providerConfigKey(providerId, "protocol"), protocol);
  if (providerId === "ollama") await setSetting("ollamaBaseUrl", baseUrl);
}

const providerKeyForPurpose: Record<LlmPurpose, string> = {
  extraction: "extractionProvider",
  generation: "generationProvider",
  deepdive: "deepdiveProvider",
};
const modelKeyForPurpose: Record<LlmPurpose, string> = {
  extraction: "extractionModel",
  generation: "generationModel",
  deepdive: "deepdiveModel",
};

export async function getPurposeRoute(
  purpose: LlmPurpose,
): Promise<PurposeRoute> {
  const storedProvider = await getSetting<unknown>(
    providerKeyForPurpose[purpose],
    "openai",
  );
  const providerId = isProviderId(storedProvider) ? storedProvider : "openai";
  const compatibleProvider =
    purpose === "extraction" && providerId === "ollama"
      ? "openai"
      : providerId;
  const storedModel = await getSetting<unknown>(
    modelKeyForPurpose[purpose],
    DEFAULT_MODELS[compatibleProvider][purpose],
  );
  return {
    providerId: compatibleProvider,
    model:
      typeof storedModel === "string" && storedModel.trim()
        ? storedModel
        : DEFAULT_MODELS[compatibleProvider][purpose],
  };
}

export async function setPurposeRoute(
  purpose: LlmPurpose,
  route: PurposeRoute,
): Promise<void> {
  if (!isProviderId(route.providerId)) throw new Error("Provider is invalid.");
  if (purpose === "extraction" && route.providerId === "ollama")
    throw new Error("OllamaはPDF・画像の抽出には利用できません。");
  if (!route.model.trim()) throw new Error("モデル名を入力してください。");
  await setSetting(providerKeyForPurpose[purpose], route.providerId);
  await setSetting(modelKeyForPurpose[purpose], route.model.trim());
}
