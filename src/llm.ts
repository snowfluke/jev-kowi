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
 * Reject meta-commentary ("The user is asking…", "Here is…") that some
 * models emit instead of the rewrite. Tight patterns only — a real Jev
 * reply never talks about the user in third person or mentions drafts.
 */
export function looksLikeMeta(text: string): boolean {
  const t = text.trim();
  return (
    /^(the user|user (is asking|said|wants)|here'?s|here is|analysis)/i.test(t) ||
    /(the|your) (broken )?draft says?|as an ai|i('m| am) an ai|you asked me to/i.test(t)
  );
}

/** Ordered candidate models from env pin, if set. */
export function candidateModels(): string[] {
  return LLM_MODELS.split(",")
    .map((m) => m.trim())
    .filter((m) => m !== "");
}

// --- Live catalog auto-discovery (self-sustaining mode) ---

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 3_600_000;
const MAX_ATTEMPTS = 5;

interface CatalogModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { modality?: string };
}

const JUNK = /transcrib|tts|embed|rerank|safety|moderat|guard|lyria|music|audio|vision|ocr|poolside|\bcode\b/i;

// Vendors, not model IDs: vendors are stable while free IDs rotate.
// Unknown vendors still work, they just sort after known generalists.
const VENDOR_RANK = [
  "qwen",
  "google",
  "z-ai",
  "meta-llama",
  "mistralai",
  "deepseek",
  "openai",
  "microsoft",
  "nvidia",
  "cohere",
  "anthropic",
  "x-ai",
];

function vendorRank(id: string): number {
  const i = VENDOR_RANK.indexOf(id.split("/")[0]!.toLowerCase());
  return i === -1 ? VENDOR_RANK.length : i;
}

/**
 * Pick free chat models from a catalog payload. Pure — unit-testable.
 * Keeps text-in/text-out models, drops audio/image/embedding/safety/
 * code-specialized ones, prefers pure-text non-reasoning models with
 * larger context first. `openrouter/free` (the router itself) goes last
 * as the final catch-all.
 */
export function selectFreeChatModels(catalog: { data?: CatalogModel[] }): string[] {
  const scored: { id: string; pure: number; vendor: number; reasoning: number; ctx: number }[] = [];
  for (const m of catalog.data ?? []) {
    if (!m.id.endsWith(":free") || m.id === "openrouter/free") continue;
    const modality = m.architecture?.modality ?? "";
    if (!modality.startsWith("text") || !modality.includes("->text")) continue;
    if (JUNK.test(`${m.id} ${m.name ?? ""}`)) continue;
    scored.push({
      id: m.id,
      pure: modality === "text->text" ? 0 : 1,
      vendor: vendorRank(m.id),
      reasoning: /reasoning/i.test(m.id) ? 1 : 0,
      ctx: m.context_length ?? 0,
    });
  }
  scored.sort(
    (a, b) =>
      a.vendor - b.vendor ||
      a.pure - b.pure ||
      a.reasoning - b.reasoning ||
      b.ctx - a.ctx ||
      (a.id < b.id ? -1 : 1),
  );
  const ids = scored.map((s) => s.id);
  ids.push("openrouter/free");
  return ids;
}

let catalogCache: { models: string[]; at: number } | null = null;
let catalogInflight: Promise<string[]> | null = null;

async function fetchCatalog(): Promise<string[]> {
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
  if (res.status >= 400) throw new Error(`catalog status ${res.status}`);
  const json = (await res.json()) as { data?: CatalogModel[] };
  return selectFreeChatModels(json);
}

/** Hourly-cached free model list; stale cache survives fetch failures. */
export async function freeChatModels(): Promise<string[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.models;
  if (!catalogInflight) {
    catalogInflight = fetchCatalog()
      .catch((e) => {
        console.log(`${new Date().toISOString()} [jev] [LLM] catalog refresh failed: ${String(e).split("\n")[0]}`);
        return catalogCache?.models ?? [];
      })
      .finally(() => {
        catalogInflight = null;
      });
  }
  const models = await catalogInflight;
  // Cache even an empty list briefly? No — empty means failure; keep old
  // cache if any, else callers fall back to the raw draft.
  if (models.length > 0) catalogCache = { models, at: now };
  return models;
}

/** Test hook: reset module cache state. */
export function _resetCatalogCache(): void {
  catalogCache = null;
  catalogInflight = null;
}

/** Resolve candidates: manual env pin wins, else the cached catalog. */
export async function resolveModels(): Promise<string[]> {
  const pinned = candidateModels();
  if (pinned.length > 0) return pinned;
  return freeChatModels();
}

/**
 * Order one reply's attempts: deduped candidates first, the
 * `openrouter/free` router always last so the catch-all is reachable
 * even under the attempt cap. Pure — unit-testable.
 */
export function orderAttempts(models: string[]): string[] {
  const deduped = [...new Set(models)];
  const rest = deduped.filter((m) => m !== "openrouter/free");
  return [...rest.slice(0, MAX_ATTEMPTS - 1), "openrouter/free"];
}

interface ChatPayload {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: number;
  max_tokens: number;
  reasoning?: { exclude: boolean };
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
    // Keep chain-of-thought out of `content` on providers that support it.
    reasoning: { exclude: true },
  };
  const models = orderAttempts(await resolveModels());
  if (models.length === 0) {
    console.log(`${new Date().toISOString()} [jev] [LLM] no candidates, keeping draft`);
    return input.draft;
  }
  for (const model of models) {
    const result = await tryModel(model, payload);
    if ("text" in result) {
      const cleaned = stripThoughts(result.text);
      if (!cleaned) {
        console.log(`${new Date().toISOString()} [jev] [LLM] ${model} returned only thoughts, next`);
        continue;
      }
      if (looksLikeMeta(cleaned)) {
        console.log(`${new Date().toISOString()} [jev] [LLM] ${model} narrated instead of replying, next`);
        continue;
      }
      const final = capWords(cleaned);
      console.log(`${new Date().toISOString()} [jev] [LLM] model=${model}`);
      return final;
    }
    console.log(`${new Date().toISOString()} [jev] [LLM] ${model} failed (${result.error}), next`);
    if (result.error.includes("429")) await Bun.sleep(1000);
  }
  console.log(`${new Date().toISOString()} [jev] [LLM] all models failed, keeping draft`);
  return input.draft;
}
