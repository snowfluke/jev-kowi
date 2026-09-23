// Central config. Every value can be overridden via environment variables.
// Bun loads `.env` automatically, so no dotenv dependency is needed.

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

export const TOKEN = process.env.DISCORD_TOKEN_JEV ?? "";
export const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

export const API_URL = str("JEV_API_URL", "https://openrouter.ai/api/alpha/decisions");
export const MODEL = str("JEV_MODEL", "~typesafe/jev-latest");
export const END = "<END>";

export const MAX_CHOICES = num("JEV_MAX_CHOICES", 255);
export const QUESTIONS_PER_CALL = num("JEV_QUESTIONS_PER_CALL", 20);
export const TOP_PER_BUCKET = num("JEV_TOP_PER_BUCKET", 2);
export const MAX_WORDS = num("JEV_MAX_WORDS", 30);
export const MIN_WORDS = num("JEV_MIN_WORDS", 2);
export const MAX_HISTORY = num("JEV_MAX_HISTORY", 3);
export const STOP_THRESHOLD = num("JEV_STOP_THRESHOLD", 0.5);
export const REPEAT_PENALTY = num("JEV_REPEAT_PENALTY", 1.5);
export const REPEAT_WINDOW = num("JEV_REPEAT_WINDOW", 8);
export const CONTENT_PENALTY = num("JEV_CONTENT_PENALTY", 2.5);
export const CONTENT_PENALTY_CAP = num("JEV_CONTENT_PENALTY_CAP", 4);
export const STOP_PENALTY = num("JEV_STOP_PENALTY", 1.6);
export const STOP_PENALTY_CAP = num("JEV_STOP_PENALTY_CAP", 6);

/** en | id | mixed | auto (default). auto detects Indonesian per message. */
export const VOCAB_MODE = str("JEV_VOCAB_MODE", "auto").toLowerCase();
export const VOCAB_EN_PATH = str("JEV_VOCAB_EN_PATH", new URL("../vocab-en.txt", import.meta.url).pathname);
export const VOCAB_ID_PATH = str("JEV_VOCAB_ID_PATH", new URL("../vocab-id.txt", import.meta.url).pathname);

/**
 * Optional ambient listening: a channel ID where Jev may reply unprompted.
 * Empty = disabled. When set, every non-bot message there is judged
 * (last AMBIENT_FETCH non-bot messages as context) and Jev replies only
 * when the latest message seems addressed to it.
 */
export const AMBIENT_CHANNEL_ID = str("JEV_AMBIENT_CHANNEL_ID", "");
export const AMBIENT_FETCH = num("JEV_AMBIENT_FETCH", 10);
export const AMBIENT_THRESHOLD = num("JEV_AMBIENT_THRESHOLD", 0.5);

/**
 * Optional LLM enhancement: Jev still writes the first draft
 * (tournament sampling), then a chat model rewrites it short.
 * - enhance (default): draft -> LLM rewrite, raw draft on failure.
 * - off: send Jev's raw draft, no extra API call.
 */
export const LLM_MODE = str("JEV_LLM_MODE", "enhance").toLowerCase();
export const LLM_MODEL = str("JEV_LLM_MODEL", "qwen/qwen3.8-27b:free");
export const LLM_API_URL = str("JEV_LLM_API_URL", "https://openrouter.ai/api/v1/chat/completions");
export const LLM_MAX_WORDS = num("JEV_LLM_MAX_WORDS", 20);

export function assertEnv(): void {
  const missing: string[] = [];
  if (!TOKEN) missing.push("DISCORD_TOKEN_JEV");
  if (!OPENROUTER_KEY) missing.push("OPENROUTER_API_KEY");
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
  }
}
