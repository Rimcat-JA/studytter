import { File } from "expo-file-system";
import { classifyGenerationError } from "../core/autogeneration";
import { ExtractionChunkSchema, type ExtractionChunk } from "./schemas";
import { createProvider, type ProviderId } from "./provider";
import { logUsage } from "./usage";

const SYSTEM = `You extract grounded learning atoms from user-provided study materials. Return schemaVersion 2. Every atom must be directly supported by the file, use a precise page or image sourceAnchor, and never add outside facts. Keep each atom atomic and under 500 characters. On the first chunk include a material profile. UI languages allowed: ja, en, zh-Hans.`;

export async function extractMaterialChunk(options: {
  providerId: Exclude<ProviderId, "ollama">;
  model: string;
  fileUri: string;
  filename: string;
  mimeType: string;
  pageStart?: number;
  pageEnd?: number;
  firstChunk: boolean;
  databaseGeneration?: number;
}): Promise<ExtractionChunk> {
  const { assertDatabaseGeneration, captureDatabaseGeneration } = await import("../db/database");
  const generation = options.databaseGeneration ?? captureDatabaseGeneration();
  assertDatabaseGeneration(generation);
  const provider = createProvider(options.providerId);
  const file = new File(options.fileUri);
  const data = await file.base64();
  const range = options.pageStart
    ? `The attached PDF is a physical excerpt containing original pages ${options.pageStart}–${options.pageEnd}. Process the complete attached excerpt. Its first PDF page is original page ${options.pageStart}; preserve the original page numbering in every sourceAnchor.`
    : "Process the complete material.";
  const user = [
    {
      type: "text" as const,
      text: `${range} ${options.firstChunk ? "Include profile." : "Omit profile."}`,
    },
    {
      type: "file" as const,
      data,
      mediaType: options.mimeType,
      filename: options.filename,
    },
  ];
  let lastValidationError: unknown;
  let lastValidationMessage = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      assertDatabaseGeneration(generation);
      const result = await provider.generateJson({
        model: options.model,
        system: SYSTEM,
        user: attempt
          ? [
              {
                type: "text",
                text: `Previous validation failed: ${lastValidationMessage}. Correct it.`,
              },
              ...user,
            ]
          : user,
        schema: ExtractionChunkSchema,
        maxTokens: 8_000,
      });
      assertDatabaseGeneration(generation);
      await logUsage(
        options.providerId,
        options.model,
        "extraction",
        result.usage,
        generation,
      );
      return ExtractionChunkSchema.parse(result.data);
    } catch (error) {
      // Retry only malformed structured output. Authentication, an invalid
      // endpoint/model, rate limits, and provider outages need user action or
      // backoff; immediately repeating the whole PDF upload only multiplies
      // requests and produces the misleading "failed after retry" screen.
      if (classifyGenerationError(error).code !== "validation") throw error;
      lastValidationError = error;
      lastValidationMessage =
        error instanceof Error ? error.message : String(error);
    }
  }
  const finalError = new Error(
    `Extraction validation failed after correction: ${lastValidationMessage}`,
  ) as Error & { cause?: unknown };
  finalError.cause = lastValidationError;
  throw finalError;
}

const normalize = (text: string) =>
  text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const words = (text: string) =>
  new Set(
    normalize(text)
      .split(/[\s、。,.，；;:：()（）]+/)
      .filter(Boolean),
  );
export function jaccard(a: string, b: string): number {
  const aa = words(a);
  const bb = words(b);
  const union = new Set([...aa, ...bb]);
  if (!union.size) return 1;
  let overlap = 0;
  for (const token of aa) if (bb.has(token)) overlap++;
  return overlap / union.size;
}
export function mergeExtractionChunks(
  chunks: readonly ExtractionChunk[],
): ExtractionChunk {
  const topics = new Map<string, { label: string; order: number }>();
  const atoms: ExtractionChunk["atoms"] = [];
  for (const chunk of chunks) {
    for (const topic of chunk.topics) {
      const key = normalize(topic.label);
      if (!topics.has(key)) topics.set(key, topic);
    }
    for (const atom of chunk.atoms) {
      atom.topicLabel =
        topics.get(normalize(atom.topicLabel))?.label ?? atom.topicLabel.trim();
      if (
        !atoms.some(
          (other) =>
            normalize(other.topicLabel) === normalize(atom.topicLabel) &&
            jaccard(other.core, atom.core) > 0.8,
        )
      )
        atoms.push(atom);
    }
  }
  return {
    schemaVersion: 2,
    topics: [...topics.values()].sort((a, b) => a.order - b.order),
    atoms,
    profile: chunks.find((c) => c.profile)?.profile,
  };
}
