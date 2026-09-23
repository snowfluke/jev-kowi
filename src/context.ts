import type { Message } from "discord.js";
import { AMBIENT_FETCH } from "./config.ts";
import { askChoice } from "./jev.ts";

/** How many relevant messages Jev picks from the fetched pool. */
export const RELEVANT_K = 10;

export interface RelevantMsg {
  id: string;
  author: string;
  mine: boolean;
  content: string;
  createdTimestamp: number;
}

/**
 * Fetch recent channel history, oldest-first. Keeps humans and Jev's own
 * messages (references like "lanjut" need them); drops other bots.
 * Returns null when the channel type has no message history.
 */
export async function fetchChannelHistory(
  channel: Message["channel"],
  selfId: string | undefined,
  excludeId?: string,
  limit: number = AMBIENT_FETCH,
): Promise<Message[] | null> {
  if (!("messages" in channel)) return null;
  try {
    const coll = await channel.messages.fetch({ limit: Math.min(Math.max(limit, 20), 100) });
    return [...coll.values()]
      .filter((m) => (!m.author.bot || m.author.id === selfId) && m.id !== excludeId)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-limit);
  } catch {
    return null;
  }
}

export function toRelevant(msgs: Message[], selfId: string | undefined): RelevantMsg[] {
  return msgs.map((m) => ({
    id: m.id,
    author: m.author.username,
    mine: m.author.bot && m.author.id === selfId,
    content: (m.content || "(attachment)").slice(0, 300),
    createdTimestamp: m.createdTimestamp,
  }));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Rank pool by Jev-assigned relevance probability, keep top k,
 * re-sorted chronologically. Pure — unit-testable.
 */
export function selectTopK(pool: RelevantMsg[], probs: Record<string, number>, k: number): RelevantMsg[] {
  const scored = pool.map((p) => ({ p, s: probs[p.id] ?? 0 }));
  // No signal (mismatched keys or zeroed probs) — most recent k, not oldest.
  if (scored.every((x) => x.s <= 0)) return pool.slice(-k);
  const indexOf = new Map(pool.map((p, i) => [p.id, i]));
  return scored
    .sort((a, b) => b.s - a.s || (indexOf.get(a.p.id)! - indexOf.get(b.p.id)!))
    .slice(0, k)
    .map((x) => x.p)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

/**
 * Jev picks the k most relevant messages in one choice call.
 * Falls back to the most recent k on any failure.
 */
export async function pickRelevant(
  current: string,
  pool: RelevantMsg[],
  k: number,
  signal?: AbortSignal,
): Promise<RelevantMsg[]> {
  if (pool.length <= k) return pool;
  const probs = await askChoice(
    `User just said: ${current}\nWhich of these messages is the user referring or replying to?`,
    "Pick the relevant messages.",
    pool.map((p) => ({ id: p.id, label: truncate(`${p.author}: ${p.content}`, 120) })),
    signal,
  );
  if (Object.keys(probs).length === 0) return pool.slice(-k);
  return selectTopK(pool, probs, k);
}
