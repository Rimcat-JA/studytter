import { getDb } from "../db/database";
import {
  DeepDiveThreadSchema,
  parseDeepDiveThread,
  type DeepDiveThread,
} from "./deepdive-thread";

export async function loadDeepDiveThread(
  postId: string,
): Promise<DeepDiveThread> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ thread_json: string }>(
    "SELECT thread_json FROM deepdives WHERE post_id=?",
    postId,
  );
  const parsed = parseDeepDiveThread(row?.thread_json);
  if (parsed.shouldPersist) await saveDeepDiveThread(postId, parsed.thread);
  return parsed.thread;
}

export async function saveDeepDiveThread(
  postId: string,
  thread: DeepDiveThread,
): Promise<void> {
  const validated = DeepDiveThreadSchema.parse(thread);
  await (
    await getDb()
  ).runAsync(
    "INSERT INTO deepdives(post_id,thread_json,created_at) VALUES(?,?,?) ON CONFLICT(post_id) DO UPDATE SET thread_json=excluded.thread_json,created_at=excluded.created_at",
    postId,
    JSON.stringify(validated),
    Date.now(),
  );
}
