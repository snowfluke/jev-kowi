import { LLM_API_URL, LLM_MAX_WORDS, LLM_MODE, LLM_MODEL, OPENROUTER_KEY } from "./config.ts";
import type { HistoryTurn } from "./jev.ts";
import { resolveLanguage } from "./vocab.ts";

export interface EnhanceInput {
  message: string;
  history: HistoryTurn[];
  draft: string;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Build the chat-completion prompt. Pure — unit-testable.
 * The LLM is a rewriter, not the author: Jev's draft stays the soul
 * of the reply, the model just makes it short, coherent and factual.
 */
export function buildEnhanceMessages({ message, history, draft }: EnhanceInput): ChatMessage[] {
  const lang = resolveLanguage(message);
  const langName = lang === "id" ? "Indonesian" : "English";

  const context = history
    .slice(-3)
    .map((h) => `${h.role === "assistant" ? "Jev" : "User"}: ${h.content}`)
    .join("\n");

  return [
    {
      role: "system",
      content:
        `You are Jev, a chaotic Discord bot who talks broken ${langName}. ` +
        `Rewrite the draft below into a short reply of max ${LLM_MAX_WORDS} words, in ${langName}. ` +
        `Keep it silly, blunt and a little broken — do NOT turn it into a polished assistant answer. ` +
        `Fix factual errors (Indonesia's president is Prabowo Subianto since Oct 2024; Jokowi held 2014-2024). ` +
        `If the draft already works, return it nearly unchanged. ` +
        `Your entire response must BE the reply: NEVER explain, describe, or narrate, NEVER start with "The user", ` +
        `no quotes, no explanation, no emoji spam. ` +
        `Example — User just said: tau wordle gak / Draft: Tau mabar / You reply: Tau dong, mabar gih.`,
    },
    {
      role: "user",
      content:
        (context ? `Recent chat:\n${context}\n\n` : "") +
        `User just said: ${message}\n` +
        `Your broken draft: ${draft}`,
    },
  ];
}

/** Defensively cap runaway output at roughly twice the word budget. */
export function capWords(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= LLM_MAX_WORDS * 2) return words.join(" ");
  return words.slice(0, LLM_MAX_WORDS * 2).join(" ");
}

/** Remove leaked chain-of-thought blocks some providers inline into content. */
export function stripThoughts(text: string): string {
  return text
    .replace(/<(think|thought|reasoning|analysis)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(think|thought|reasoning|analysis)\/>/gi, "")
    .trim();
}

/**
 * Reject meta-commentary ("The user is asking…", "Here is…"), safety
 * verdicts ("User Safety: safe") and refusals that some routed models
 * emit instead of the rewrite. Tight patterns only — a real Jev reply
 * never talks about the user in third person, mentions drafts or
 * policies, or opens with "I can't".
 */
export function looksLikeMeta(text: string): boolean {
  const t = text.trim();
  return (
    /^(the user|user (is asking|said|wants)|here'?s|here is|analysis)/i.test(t) ||
    /(the|your) (broken )?draft says?|as an ai|i('m| am) an ai|you asked me to/i.test(t) ||
    /user safety|content (policy|moderation|guidelines?)|safety (verdict|assessment|check|filter|label)/i.test(
      t,
    ) ||
    /^(i can'?t|i cannot|i am unable|i'm unable|unable to comply)/i.test(t)
  );
}

interface ChatPayload {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  max_tokens: number;
  reasoning?: { exclude: boolean };
}

/** One attempt against one model. Returns text on success, null on any failure. */
async function tryModel(
  model: string,
  payload: Omit<ChatPayload, "model">,
  signal?: AbortSignal,
): Promise<{ text: string } | { error: string }> {
  try {
    signal?.throwIfAborted();
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, model }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(45_000), signal]) : AbortSignal.timeout(45_000),
    });
    if (res.status >= 400) return { error: `status ${res.status}` };
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { error: "empty reply" };
    return { text };
  } catch (e) {
    signal?.throwIfAborted();
    return { error: String(e).split("\n")[0] };
  }
}

/**
 * Build the direct-answer prompt. Pure — unit-testable.
 * The router answers in Jev's voice from Jev-ranked context.
 */
export function buildAnswerMessages(
  message: string,
  relevant: { author: string; mine: boolean; content: string }[],
  users: { username: string; name: string; id: string }[] = [],
): { role: "system" | "user"; content: string }[] {
  const lang = resolveLanguage(message);
  const langName = lang === "id" ? "Indonesian" : "English";
  const lines = relevant.map((r) => `${r.mine ? "Jev" : r.author}: ${r.content}`).join("\n");
  const roster =
    users.length > 0
      ? `People here (mention with <@id> exactly, only these people):\n` +
        users.map((u) => `- ${u.username} (${u.name}): <@${u.id}>`).join("\n") +
        `\n`
      : "";
  return [
    {
      role: "system",
      content:
        `You are Jev, a chaotic Discord bot who talks broken ${langName}. ` +
        `Answer the user's message below in max ${LLM_MAX_WORDS} words, in ${langName}. ` +
        `Silly, blunt and a little broken — never a polished assistant answer. ` +
        `Fix factual errors (Indonesia's president is Prabowo Subianto since Oct 2024; Jokowi held 2014-2024). ` +
        (roster
          ? `To mention someone, write their <@id> exactly as listed. Only mention listed people, never invent IDs. ` +
            roster
          : "") +
        `Your entire response must BE the reply: NEVER explain, describe, or narrate, NEVER start with "The user", ` +
        `no quotes, no explanation, no emoji spam.`,
    },
    {
      role: "user",
      content:
        (lines ? `Recent chat:\n${lines}\n\n` : "") +
        `User just said: ${message}`,
    },
  ];
}

/**
 * Fix up mentions in a reply: @username becomes <@id> for known users,
 * unknown <@id> tokens are dropped (never let it ping strangers or
 * hallucinated IDs). Pure — unit-testable.
 */
export function normalizeMentions(
  text: string,
  users: { username: string; name: string; id: string }[],
): string {
  let out = text;
  for (const u of users) {
    const esc = u.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${esc}(?![\\w.])`, "g"), `<@${u.id}>`);
  }
  const known = new Set(users.map((u) => u.id));
  out = out.replace(/<@!?(\d+)>/g, (m, id: string) => (known.has(id) ? `<@${id}>` : ""));
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * One direct answer via the free router. Retries once on empty —
 * the router serves a random backend per call, so a one-off flake
 * (burnt thinking budget, hiccup) usually clears on the second try.
 * Returns "" if both fail (caller falls back to a Jev draft).
 */
export async function llmAnswer(
  message: string,
  relevant: { author: string; mine: boolean; content: string }[],
  signal?: AbortSignal,
  users: { username: string; name: string; id: string }[] = [],
): Promise<string> {
  if (LLM_MODE === "off") return "";
  const payload = {
    messages: buildAnswerMessages(message, relevant, users),
    temperature: 0.7,
    // Generous: reasoning models burn budget thinking; thin budgets
    // come back as empty replies.
    max_tokens: 400,
    reasoning: { exclude: true },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const result = await tryModel(LLM_MODEL, payload, signal);
    if ("text" in result) {
      const cleaned = stripThoughts(result.text);
      if (cleaned && !looksLikeMeta(cleaned)) {
        const final = capWords(cleaned);
        console.log(`${new Date().toISOString()} [jev] [LLM] model=${LLM_MODEL}`);
        return final;
      }
    }
    // Empty and unusable outputs retry (random backend per call);
    // transport and HTTP errors fall through fast.
    const why = "text" in result ? "unusable" : result.error;
    if (why === "empty reply" || "text" in result) {
      console.log(
        `${new Date().toISOString()} [jev] [LLM] answer ${why} (attempt ${attempt + 1}/2, ${relevant.length} relevant), retrying`,
      );
      continue;
    }
    console.log(
      `${new Date().toISOString()} [jev] [LLM] answer failed (${why}, ${relevant.length} relevant)`,
    );
    return "";
  }
  console.log(`${new Date().toISOString()} [jev] [LLM] answer still unusable, fallback to draft`);
  return "";
}

/**
 * Rewrite Jev's draft via the free-models router. Single attempt —
 * the router itself picks a live free model server-side.
 * Fail-safe: any failure returns the raw draft unchanged.
 */export async function enhanceReply(input: EnhanceInput, signal?: AbortSignal): Promise<string> {
  if (LLM_MODE === "off") return input.draft;
  const payload = {
    messages: buildEnhanceMessages(input),
    temperature: 0.7,
    max_tokens: 250,
    // Keep chain-of-thought out of `content` on providers that support it.
    reasoning: { exclude: true },
  };
  signal?.throwIfAborted();
  const result = await tryModel(LLM_MODEL, payload, signal);
  if ("error" in result) {
    console.log(`${new Date().toISOString()} [jev] [LLM] ${LLM_MODEL} failed (${result.error}), keeping draft`);
    return input.draft;
  }
  const cleaned = stripThoughts(result.text);
  if (!cleaned || looksLikeMeta(cleaned)) {
    console.log(`${new Date().toISOString()} [jev] [LLM] router output unusable, keeping draft`);
    return input.draft;
  }
  const final = capWords(cleaned);
  console.log(`${new Date().toISOString()} [jev] [LLM] model=${LLM_MODEL}`);
  return final;
}
