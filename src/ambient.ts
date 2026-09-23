import type { Message } from "discord.js";
import { AMBIENT_FETCH, AMBIENT_THRESHOLD } from "./config.ts";
import { askNoul, type HistoryTurn } from "./jev.ts";

const JUDGE_INSTRUCTIONS =
  "Is the latest message talking to Jev, asking Jev something, or expecting Jev to reply?";

export interface AddressVerdict {
  addressed: boolean;
  score: number;
  reason: "name" | "judge" | "empty";
}

/** Oldest-first, drop bots, keep the last `limit`. Pure — unit-testable. */
export function pickContext(messages: Message[], limit: number): Message[] {
  return messages
    .filter((m) => !m.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-limit);
}

export function buildAddressState(recent: Message[]): string {
  return recent
    .map((m) => `${m.author.username}: ${m.content || "(attachment)"}`)
    .join("\n");
}

export function contextHistory(recent: Message[], maxTurns: number): HistoryTurn[] {
  return recent
    .slice(0, -1)
    .slice(-maxTurns)
    .map((m) => ({ role: "user" as const, content: m.content || "hello" }));
}

/**
 * Decide whether the last message in `recent` (chronological, non-bot)
 * is talking to Jev. Fast-path on the name "jev", otherwise one noul
 * judgment call. Fail-silent: API errors score 0, no reply.
 */
export async function isTalkingToJev(recent: Message[]): Promise<AddressVerdict> {
  const target = recent[recent.length - 1];
  if (!target || !target.content) return { addressed: false, score: 0, reason: "empty" };
  if (/\bjev\b/i.test(target.content)) return { addressed: true, score: 1, reason: "name" };
  const score = await askNoul(buildAddressState(recent), JUDGE_INSTRUCTIONS);
  return { addressed: score >= AMBIENT_THRESHOLD, score, reason: "judge" };
}

/** Fetch recent messages and reduce to the last `AMBIENT_FETCH` non-bot ones. */
export async function fetchAmbientContext(channel: Message["channel"]): Promise<Message[] | null> {
  if (!("messages" in channel)) return null;
  try {
    const coll = await channel.messages.fetch({
      limit: Math.min(Math.max(AMBIENT_FETCH * 3, 20), 100),
    });
    return pickContext([...coll.values()], AMBIENT_FETCH);
  } catch {
    return null;
  }
}
