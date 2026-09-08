import { captureDatabaseGeneration, getDbForGeneration } from "../db/database";
import {
  DeepDiveThreadSchema,
  parseDeepDiveThread,
  type DeepDiveThread,
} from "./deepdive-thread";

export async function loadDeepDiveThread(
  postId: string,
): Promise<DeepDiveThread> {
  const generation = captureDatabaseGeneration();
  const db = await getDbForGeneration(generation);
  const row = await db.getFirstAsync<{ thread_json: string }>(
    "SELECT thread_json FROM deepdives WHERE post_id=?",
    postId,
  );
  const parsed = parseDeepDiveThread(row?.thread_json);
  if (parsed.shouldPersist) await saveDeepDiveThread(postId, parsed.thread, generation);
  return parsed.thread;
}

export async function saveDeepDiveThread(
  postId: string,
  thread: DeepDiveThread,
  generation = captureDatabaseGeneration(),
): Promise<void> {
  const validated = DeepDiveThreadSchema.parse(thread);
  await (
    await getDbForGeneration(generation)
  ).runAsync(
    "INSERT INTO deepdives(post_id,thread_json,created_at) VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET thread_json=excluded.thread_json,created_at=excluded.created_at",
    postId,
    JSON.stringify(validated),
    Date.now(),
  );
}
