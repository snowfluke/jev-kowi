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
        `Reply with ONLY the rewritten text, no quotes, no explanation, no emoji spam.`,
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

/**
 * Rewrite Jev's draft via the configured chat model.
 * Fail-safe: any error returns the raw draft unchanged.
 */
export async function enhanceReply(input: EnhanceInput): Promise<string> {
  if (LLM_MODE === "off") return input.draft;
  try {
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: buildEnhanceMessages(input),
        temperature: 0.7,
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status >= 400) {
      console.log(`${new Date().toISOString()} [jev] [LLM] status ${res.status}, keeping draft`);
      return input.draft;
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return input.draft;
    return capWords(text);
  } catch (e) {
    console.log(`${new Date().toISOString()} [jev] [LLM] err, keeping draft: ${e}`);
    return input.draft;
  }
}
