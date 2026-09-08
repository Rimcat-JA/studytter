import prices from "../../assets/model-prices.json";
import { captureDatabaseGeneration, createId, getDbForGeneration, getSetting } from "../db/database";
import type { ProviderId, Usage } from "./provider";

type Price = { inputPerMillion: number; outputPerMillion: number };
export async function logUsage(
  providerId: ProviderId,
  modelId: string,
  purpose: "extraction" | "generation" | "deepdive",
  usage: Usage,
  generation = captureDatabaseGeneration(),
): Promise<void> {
  const table = await getSetting<Record<string, Price>>(
    "priceTable",
    prices.models,
    generation,
  );
  const price = table[modelId] ?? { inputPerMillion: 0, outputPerMillion: 0 };
  const estimate =
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion;
  await (
    await getDbForGeneration(generation)
  ).runAsync(
    "INSERT INTO usage_log VALUES(?,?,?,?,?,?,?,?)",
    createId("usage"),
    Date.now(),
    providerId,
    modelId,
    purpose,
    usage.inputTokens,
    usage.outputTokens,
    estimate,
  );
}
