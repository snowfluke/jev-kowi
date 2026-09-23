import { AMBIENT_THRESHOLD, AMBIENT_TIE_LOW, AMBIENT_TIEBREAK } from "./config.ts";
import { askNoul } from "./jev.ts";
import type { RelevantMsg } from "./context.ts";

const JUDGE_INSTRUCTIONS =
  "Is the latest message talking to Jev, asking Jev something, or expecting Jev to reply?";

const TIEBREAK_INSTRUCTIONS =
  "Would a short reply from Jev fit naturally here, or is the conversation fine without Jev?";

export type AmbientTier = "reply" | "tiebreak" | "skip";

/** Score tiers. Pure — unit-testable. */
export function ambientTier(score: number): AmbientTier {
  if (score >= AMBIENT_THRESHOLD) return "reply";
  if (score >= AMBIENT_TIE_LOW) return "tiebreak";
  return "skip";
}

export function buildAddressState(recent: Pick<RelevantMsg, "author" | "content">[]): string {
  return recent.map((m) => `${m.author}: ${m.content || "(attachment)"}`).join("\n");
}

/**
 * Score 0..1 for whether `target` addresses Jev, given relevant context.
 * Name fast-path first, otherwise one noul call. Fail-silent (0).
 */
export async function judgeTalkingToJev(
  recent: Pick<RelevantMsg, "author" | "content">[],
  targetContent: string,
  signal?: AbortSignal,
): Promise<number> {
  if (!targetContent) return 0;
  if (/\bjev\b/i.test(targetContent)) return 1;
  return askNoul(buildAddressState(recent), JUDGE_INSTRUCTIONS, signal);
}

/** Second opinion for borderline scores, with different phrasing. */
export async function tiebreakTalkingToJev(
  recent: Pick<RelevantMsg, "author" | "content">[],
  signal?: AbortSignal,
): Promise<number> {
  return askNoul(buildAddressState(recent), TIEBREAK_INSTRUCTIONS, signal);
}

export interface AmbientVerdict {
  reply: boolean;
  score: number;
  reason: "name" | "direct" | "tiebreak-pass" | "tiebreak-fail" | "skip" | "empty";
}

/** Tiered gate: direct reply on high score, tiebreaker in the middle, skip below. */
export async function decideAmbient(
  relevant: Pick<RelevantMsg, "author" | "content">[],
  targetContent: string,
  signal?: AbortSignal,
): Promise<AmbientVerdict> {
  if (!targetContent) return { reply: false, score: 0, reason: "empty" };
  const score = await judgeTalkingToJev(relevant, targetContent, signal);
  const tier = ambientTier(score);
  if (tier === "reply") {
    return { reply: true, score, reason: score >= 1 ? "name" : "direct" };
  }
  if (tier === "skip") return { reply: false, score, reason: "skip" };
  const second = await tiebreakTalkingToJev(relevant, signal);
  return second >= AMBIENT_TIEBREAK
    ? { reply: true, score, reason: "tiebreak-pass" }
    : { reply: false, score, reason: "tiebreak-fail" };
}
