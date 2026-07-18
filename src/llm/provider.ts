import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  generateText,
  Output,
  streamText,
  type FilePart,
  type TextPart,
  type UserContent,
} from "ai";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import {
  getProviderConfig,
  normalizeBaseUrl,
  type ProviderConfig,
  type ProviderId,
} from "./config";
import { probeProviderCredentials } from "./credentials";

export type { ProviderId } from "./config";
export type LlmPart = TextPart | FilePart;
export type Usage = { inputTokens: number; outputTokens: number };

export type ProviderRuntimeOverrides = Partial<ProviderConfig> & {
  apiKey?: string;
  headers?: Record<string, string>;
};

export type ProviderModel = {
  id: string;
  name?: string;
  pdfInput?: boolean;
  imageInput?: boolean;
};

export type DiagnosticCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

export type ProviderDiagnostic = {
  ok: boolean;
  latencyMs: number;
  checks: DiagnosticCheck[];
  models: ProviderModel[];
};

export type ProviderDiagnosticOptions = {
  /** Run an actual one-page PDF + structured-output request. */
  testPdf?: boolean;
};

export interface LlmProvider {
  id: ProviderId;
  capabilities: { pdfInput: boolean; imageInput: boolean };
  generateJson<T>(opts: {
    model: string;
    system: string;
    user: LlmPart[];
    schema: z.ZodType<T>;
    maxTokens: number;
  }): Promise<{ data: T; usage: Usage }>;
  streamText(opts: {
    model: string;
    system: string;
    user: LlmPart[];
    abortSignal?: AbortSignal;
    maxTokens?: number;
  }): AsyncIterable<string>;
}

export const KEY_PREFIX = "apikey.";
const HEADER_PREFIX = "providerheaders.";

export async function setApiKey(
  provider: Exclude<ProviderId, "ollama">,
  key: string,
): Promise<void> {
  await SecureStore.setItemAsync(`${KEY_PREFIX}${provider}`, key.trim());
}
export async function getApiKey(
  provider: Exclude<ProviderId, "ollama">,
): Promise<string | null> {
  return SecureStore.getItemAsync(`${KEY_PREFIX}${provider}`);
}
export async function deleteApiKey(
  provider: Exclude<ProviderId, "ollama">,
): Promise<void> {
  await SecureStore.deleteItemAsync(`${KEY_PREFIX}${provider}`);
}

export async function setProviderHeaders(
  provider: ProviderId,
  headers: Record<string, string>,
): Promise<void> {
  const entries = Object.entries(headers).filter(
    ([name, value]) => name.trim() && value.trim(),
  );
  if (!entries.length) {
    await SecureStore.deleteItemAsync(`${HEADER_PREFIX}${provider}`);
    return;
  }
  await SecureStore.setItemAsync(
    `${HEADER_PREFIX}${provider}`,
    JSON.stringify(Object.fromEntries(entries)),
  );
}

export async function getProviderHeaders(
  provider: ProviderId,
): Promise<Record<string, string>> {
  const value = await SecureStore.getItemAsync(`${HEADER_PREFIX}${provider}`);
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function runtimeConfig(
  id: ProviderId,
  overrides?: ProviderRuntimeOverrides,
) {
  const stored = await getProviderConfig(id);
  return {
    baseUrl: normalizeBaseUrl(overrides?.baseUrl ?? stored.baseUrl),
    protocol: overrides?.protocol ?? stored.protocol,
    headers: overrides?.headers ?? (await getProviderHeaders(id)),
  };
}

async function apiKeyFor(
  id: ProviderId,
  overrides?: ProviderRuntimeOverrides,
): Promise<string> {
  if (id === "ollama") return overrides?.apiKey?.trim() || "ollama";
  const key =
    overrides?.apiKey?.trim() ||
    (await getApiKey(id as Exclude<ProviderId, "ollama">));
  if (!key) throw new Error(`${providerName(id)} API key is not configured.`);
  return key;
}

async function modelFor(
  id: ProviderId,
  modelId: string,
  overrides?: ProviderRuntimeOverrides,
) {
  const config = await runtimeConfig(id, overrides);
  const apiKey = await apiKeyFor(id, overrides);
  if (id === "anthropic")
    return createAnthropic({
      apiKey,
      baseURL: config.baseUrl,
      headers: config.headers,
      name: "learnstream-anthropic",
    })(modelId);

  const openAI = createOpenAI({
    apiKey,
    baseURL: config.baseUrl,
    headers: config.headers,
    name: `learnstream-${id}`,
  });
  if (id === "openai" && config.protocol === "responses")
    return openAI(modelId);
  return openAI.chat(modelId);
}

export function createProvider(
  id: ProviderId,
  overrides?: ProviderRuntimeOverrides,
): LlmProvider {
  return {
    id,
    capabilities: { pdfInput: id !== "ollama", imageInput: id !== "ollama" },
    async generateJson<T>(opts: {
      model: string;
      system: string;
      user: LlmPart[];
      schema: z.ZodType<T>;
      maxTokens: number;
    }) {
      const model = await modelFor(id, opts.model, overrides);
      const result = await generateText({
        model,
        system: opts.system,
        messages: [{ role: "user", content: opts.user as UserContent }],
        output: Output.object({ schema: opts.schema }),
        maxOutputTokens: opts.maxTokens,
        // Extraction has a separate schema-correction retry. Keep transport
        // retries bounded so a temporary outage does not fan out excessively.
        maxRetries: 1,
      });
      if (!result.output)
        throw new Error("The provider returned no structured output.");
      return {
        data: result.output as T,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
      };
    },
    async *streamText(opts) {
      const model = await modelFor(id, opts.model, overrides);
      const result = streamText({
        model,
        system: opts.system,
        messages: [{ role: "user", content: opts.user as UserContent }],
        maxRetries: 1,
        abortSignal: opts.abortSignal,
        maxOutputTokens: opts.maxTokens,
      });
      for await (const chunk of result.textStream) yield chunk;
    },
  };
}

export async function testProviderConnection(
  id: ProviderId,
  model: string,
  overrides?: ProviderRuntimeOverrides,
): Promise<boolean> {
  const provider = createProvider(id, overrides);
  const schema = z.object({ ok: z.boolean() });
  const result = await provider.generateJson({
    model,
    system: "Return JSON only.",
    user: [{ type: "text", text: 'Return {"ok":true}.' }],
    schema,
    maxTokens: 40,
  });
  const { logUsage } = await import("./usage");
  await logUsage(id, model, "generation", result.usage);
  return result.data.ok;
}

/**
 * Validate authentication without invoking a potentially overloaded model.
 * Generation and PDF capability checks remain available in diagnoseProvider.
 */
export async function testProviderCredentials(
  id: Exclude<ProviderId, "ollama">,
  overrides?: ProviderRuntimeOverrides,
): Promise<boolean> {
  const config = await runtimeConfig(id, overrides);
  const apiKey = await apiKeyFor(id, overrides);
  await probeProviderCredentials({
    providerId: id,
    baseUrl: config.baseUrl,
    apiKey,
    headers: config.headers,
  });
  return true;
}

const PDF_PROBE_MARKER = "LEARNSTREAM_PDF_PROBE_7429";
// A valid, 601-byte, one-page PDF containing only PDF_PROBE_MARKER. Keeping
// the probe inline avoids uploading a user's material merely to test whether
// an endpoint/model really accepts PDF file parts.
const PDF_PROBE_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTggPj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MjAgVGQKKExFQVJOU1RSRUFNX1BERl9QUk9CRV83NDI5KSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE4CiUlRU9GCg==";

export async function testProviderPdfConnection(
  id: Exclude<ProviderId, "ollama">,
  model: string,
  overrides?: ProviderRuntimeOverrides,
): Promise<boolean> {
  const provider = createProvider(id, overrides);
  const schema = z.object({ marker: z.literal(PDF_PROBE_MARKER) });
  const result = await provider.generateJson({
    model,
    system:
      "Read the attached one-page PDF. Return the marker printed in the PDF exactly. Do not infer or invent it.",
    user: [
      { type: "text", text: "Return the PDF marker." },
      {
        type: "file",
        data: PDF_PROBE_BASE64,
        mediaType: "application/pdf",
        filename: "learnstream-pdf-probe.pdf",
      },
    ],
    schema,
    maxTokens: 80,
  });
  const { logUsage } = await import("./usage");
  await logUsage(id, model, "extraction", result.usage);
  return result.data.marker === PDF_PROBE_MARKER;
}

const normalizeCapabilityKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
const PDF_KEYS = new Set([
  "pdf",
  "pdfinput",
  "pdfupload",
  "supportspdf",
  "documentinput",
  "documents",
  "fileinput",
]);
const IMAGE_KEYS = new Set([
  "image",
  "images",
  "imageinput",
  "supportsimage",
  "supportsvision",
  "vision",
  "visioninput",
]);
const MODALITY_KEYS = new Set([
  "inputmodalities",
  "inputmodality",
  "modalities",
  "inputtypes",
]);

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (["true", "yes", "supported", "enabled"].includes(normalized))
    return true;
  if (["false", "no", "unsupported", "disabled"].includes(normalized))
    return false;
  return undefined;
}

function readNestedCapability(
  value: unknown,
  kind: "pdf" | "image",
  depth = 0,
): boolean | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  const keys = kind === "pdf" ? PDF_KEYS : IMAGE_KEYS;
  let explicitFalse: boolean | undefined;
  for (const [rawKey, child] of Object.entries(value)) {
    const key = normalizeCapabilityKey(rawKey);
    if (keys.has(key)) {
      const direct = booleanValue(child);
      if (direct === true) return true;
      if (direct === false) explicitFalse = false;
    }
    if (MODALITY_KEYS.has(key) && Array.isArray(child)) {
      const modalities = child
        .filter((item): item is string => typeof item === "string")
        .map(normalizeCapabilityKey);
      if (
        modalities.some((item) =>
          kind === "pdf"
            ? item.includes("pdf") || item.includes("document")
            : item.includes("image") || item.includes("vision"),
        )
      )
        return true;
    }
    const nested = readNestedCapability(child, kind, depth + 1);
    if (nested === true) return true;
    if (nested === false) explicitFalse = false;
  }
  return explicitFalse;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const object = asRecord(payload);
  if (!object) return [];
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.models)) return object.models;
  return [];
}

function parseModels(payload: unknown): ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  for (const row of modelRows(payload)) {
    if (typeof row === "string") {
      models.set(row, { id: row });
      continue;
    }
    const object = asRecord(row);
    if (!object) continue;
    const id =
      typeof object.id === "string"
        ? object.id
        : typeof object.model === "string"
          ? object.model
          : typeof object.name === "string"
            ? object.name
            : "";
    if (!id) continue;
    models.set(id, {
      id,
      name: typeof object.name === "string" ? object.name : undefined,
      pdfInput: readNestedCapability(object, "pdf"),
      imageInput: readNestedCapability(object, "image"),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function providerName(id: ProviderId) {
  if (id === "openai") return "OpenAI";
  if (id === "anthropic") return "Anthropic";
  if (id === "nanogpt") return "NanoGPT";
  return "Ollama";
}

export async function listProviderModels(
  id: ProviderId,
  overrides?: ProviderRuntimeOverrides,
): Promise<ProviderModel[]> {
  const config = await runtimeConfig(id, overrides);
  const apiKey = await apiKeyFor(id, overrides);
  const url = `${config.baseUrl}/models${id === "nanogpt" ? "?detailed=true" : ""}`;
  const authenticationHeaders: Record<string, string> =
    id === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : id === "ollama"
        ? {}
        : { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(url, {
    headers: { ...authenticationHeaders, ...config.headers },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(
      `${providerName(id)} model list failed (${response.status})${body ? `: ${body}` : ""}`,
    );
  }
  const models = parseModels(await response.json());
  if (!models.length)
    throw new Error(`${providerName(id)}からモデル一覧が返されませんでした。`);
  return models;
}

export type NanoGptModel = ProviderModel;
export async function listNanoGptModels(): Promise<NanoGptModel[]> {
  return listProviderModels("nanogpt");
}

export function formatProviderError(error: unknown): string {
  const object = asRecord(error);
  const status =
    typeof object?.statusCode === "number"
      ? object.statusCode
      : typeof object?.status === "number"
        ? object.status
        : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  if (status === 401 || status === 403 || /unauthorized|api key/i.test(raw))
    return `認証に失敗しました。APIキーと追加ヘッダーを確認してください。 (${raw})`;
  if (status === 404 || /model.*not found|unknown model/i.test(raw))
    return `Base URLまたはモデル名を確認してください。 (${raw})`;
  if (status === 429 || /rate.?limit/i.test(raw))
    return `利用上限またはレート制限に達しました。少し待って再試行してください。 (${raw})`;
  if (
    /temporarily unavailable|service unavailable|overloaded|all_fallbacks_failed/i.test(
      raw,
    )
  )
    return `AIモデルが一時的に混雑しています。APIキー不正やPDF非対応を示すエラーではありません。少し待って再試行してください。 (${raw})`;
  if (status !== undefined && status >= 500)
    return `AIサービス側で一時エラーが発生しました。少し待って再試行してください。 (${raw})`;
  return raw;
}

export async function diagnoseProvider(
  id: ProviderId,
  model: string,
  overrides?: ProviderRuntimeOverrides,
  options?: ProviderDiagnosticOptions,
): Promise<ProviderDiagnostic> {
  const startedAt = Date.now();
  const checks: DiagnosticCheck[] = [];
  let models: ProviderModel[] = [];
  try {
    const config = await runtimeConfig(id, overrides);
    checks.push({ label: "Base URL", ok: true, detail: config.baseUrl });
  } catch (error) {
    checks.push({
      label: "Base URL",
      ok: false,
      detail: formatProviderError(error),
    });
    return { ok: false, latencyMs: Date.now() - startedAt, checks, models };
  }

  try {
    models = await listProviderModels(id, overrides);
    const selected = models.find((item) => item.id === model);
    checks.push({
      label: "モデル一覧",
      ok: true,
      detail: selected
        ? `${models.length}件（選択モデルを確認）`
        : `${models.length}件（選択モデルは一覧にありません）`,
    });
  } catch (error) {
    checks.push({
      label: "モデル一覧",
      ok: false,
      detail: formatProviderError(error),
    });
  }

  let generationOk = false;
  try {
    generationOk = await testProviderConnection(id, model, overrides);
    checks.push({
      label: "構造化テキスト生成",
      ok: generationOk,
      detail: generationOk ? "正常に応答しました。" : "応答内容が不正です。",
    });
  } catch (error) {
    checks.push({
      label: "構造化テキスト生成",
      ok: false,
      detail: formatProviderError(error),
    });
  }

  let pdfOk = !options?.testPdf;
  if (options?.testPdf) {
    const selected = models.find((item) => item.id === model);
    if (selected?.pdfInput === false) {
      checks.push({
        label: "PDF実読込",
        ok: false,
        detail: "モデル一覧ではPDF入力非対応です。",
      });
    } else if (id === "ollama") {
      checks.push({
        label: "PDF実読込",
        ok: false,
        detail: "Ollamaは教材PDFの抽出経路に対応していません。",
      });
    } else {
      try {
        pdfOk = await testProviderPdfConnection(id, model, overrides);
        checks.push({
          label: "PDF実読込",
          ok: pdfOk,
          detail: pdfOk
            ? "小さなPDFの読込と構造化出力に成功しました。"
            : "PDF内の検証文字を確認できませんでした。",
        });
      } catch (error) {
        checks.push({
          label: "PDF実読込",
          ok: false,
          detail: formatProviderError(error),
        });
      }
    }
  }
  return {
    ok: generationOk && pdfOk,
    latencyMs: Date.now() - startedAt,
    checks,
    models,
  };
}
