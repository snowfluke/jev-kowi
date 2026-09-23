import { LLM_API_URL, LLM_MAX_WORDS, LLM_MODE, LLM_MODELS, OPENROUTER_KEY } from "./config.ts";
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

/** Ordered candidate models from env. Pure — unit-testable via fresh import. */
export function candidateModels(): string[] {
  return LLM_MODELS.split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
}

interface ChatPayload {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  max_tokens: number;
}

/** One attempt against one model. Returns text on success, null on any failure. */
async function tryModel(model: string, payload: Omit<ChatPayload, "model">): Promise<{ text: string } | { error: string }> {
  try {
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, model }),
      signal: AbortSignal.timeout(45_000),
    });
    if (res.status >= 400) return { error: `status ${res.status}` };
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { error: "empty reply" };
    return { text };
  } catch (e) {
    return { error: String(e).split("\n")[0] };
  }
}

/**
 * Rewrite Jev's draft via the first working model in the chain.
 * Fail-safe: every candidate exhausted returns the raw draft unchanged.
 */
export async function enhanceReply(input: EnhanceInput): Promise<string> {
  if (LLM_MODE === "off") return input.draft;
  const payload = {
    messages: buildEnhanceMessages(input),
    temperature: 0.7,
    max_tokens: 150,
  };
  const models = candidateModels();
  if (models.length === 0) return input.draft;
  for (const model of models) {
    const result = await tryModel(model, payload);
    if ("text" in result) {
      const final = capWords(result.text);
      console.log(`${new Date().toISOString()} [jev] [LLM] model=${model}`);
      return final;
    }
    console.log(`${new Date().toISOString()} [jev] [LLM] ${model} failed (${result.error}), next`);
    if (result.error.includes("429")) await Bun.sleep(1000);
  }
  console.log(`${new Date().toISOString()} [jev] [LLM] all models failed, keeping draft`);
  return input.draft;
}
