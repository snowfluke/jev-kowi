import {
  API_URL,
  CONTENT_PENALTY,
  CONTENT_PENALTY_CAP,
  END,
  MAX_CHOICES,
  MAX_WORDS,
  MIN_WORDS,
  MODEL,
  OPENROUTER_KEY,
  QUESTIONS_PER_CALL,
  REPEAT_PENALTY,
  REPEAT_WINDOW,
  STOP_PENALTY,
  STOP_PENALTY_CAP,
  STOP_THRESHOLD,
  TOP_PER_BUCKET,
} from "./config.ts";
import { STOPWORDS, buildVocabulary, resolveLanguage, type Language } from "./vocab.ts";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

const NO_SPACE_BEFORE = new Set([".", ",", "!", "?", ";", ":", ")", '"', "'"]);

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

/** Join word tokens into readable text, capitalizing after sentence ends. */
export function render(tokens: string[]): string {
  let out = "";
  for (const t of tokens) {
    if (t === "\n") {
      out += "\n";
    } else if (out === "" || out.endsWith("\n") || out.endsWith(" ") || NO_SPACE_BEFORE.has(t)) {
      out += t;
    } else {
      out += " " + t;
    }
  }
  return out
    .trim()
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, p1: string, p2: string) => p1 + p2.toUpperCase());
}

/** Repeat/content penalty: reuse of a word divides its probability. */
export function penalty(reply: string[], word: string): number {
  const tail = reply.slice(-REPEAT_WINDOW);
  const local = tail.filter((w) => w === word).length + 2 * (reply[reply.length - 1] === word ? 1 : 0);
  let p = Math.pow(REPEAT_PENALTY, local);
  const seen = reply.filter((w) => w === word).length;
  if (/^[a-z']+$/i.test(word) && !STOPWORDS.has(word.toLowerCase())) {
    p *= Math.pow(CONTENT_PENALTY, Math.min(seen, CONTENT_PENALTY_CAP));
  } else if (/^[a-z']+$/i.test(word)) {
    p *= Math.pow(STOP_PENALTY, Math.min(seen, STOP_PENALTY_CAP));
  }
  return p;
}

// --- OpenRouter decisions API ---

interface ChoiceAnswer {
  probabilities?: Record<string, number>;
}

interface NoulAnswer {
  noul?: number;
}

type Answers = Record<string, ChoiceAnswer & NoulAnswer>;

async function post(state: string, questions: Record<string, unknown>): Promise<Answers> {
  const body = JSON.stringify({ model: MODEL, state, questions });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status < 400) {
        const json = (await res.json()) as { answers?: Answers };
        return json.answers ?? {};
      }
      log(`[jev] API status ${res.status}, retry ${attempt}`);
      await Bun.sleep(1000 * (1 + 2 * attempt));
    } catch (e) {
      log(`[jev] API err ${attempt}: ${e}`);
      await Bun.sleep(1000 * (1 + 2 * attempt));
    }
  }
  return {};
}

/**
 * Single noul judgment call. Returns 0..1 confidence, 0 on failure
 * (fail-silent: callers treat 0 as "no").
 */
export async function askNoul(state: string, instructions: string): Promise<number> {
  const answers = await post(state, { judge: { type: "noul", instructions } });
  const noul = answers["judge"]?.noul;
  return typeof noul === "number" ? noul : 0;
}

function choiceQuestion(words: string[]): { type: string; instructions: string; criteria: Record<string, string> } {
  return {
    type: "choice",
    instructions: "Next word?",
    criteria: Object.fromEntries(words.map((w) => [w, ""])),
  };
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[i]!, a[j]!];
  }
  return a;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** One tournament round: buckets -> finalists -> runoff winner probabilities. */
async function nextWord(
  state: string,
  vocab: string[],
): Promise<{ probs: Record<string, number>; complete: number }> {
  const buckets = chunk(shuffled(vocab), MAX_CHOICES);
  const groups = chunk(buckets, QUESTIONS_PER_CALL);

  const groupCalls = groups.map((g, gi) => {
    const questions: Record<string, unknown> = {};
    g.forEach((b, i) => {
      questions[`b${gi * QUESTIONS_PER_CALL + i}`] = choiceQuestion(b);
    });
    return post(state, questions);
  });
  const completeCall = post(state, {
    complete: { type: "noul", instructions: "Is the reply complete?" },
  });

  const results = await Promise.all([...groupCalls, completeCall]);
  const complete = (results[results.length - 1]!["complete"]?.noul as number) ?? 0;

  const finalists: string[] = [];
  for (const groupAnswers of results.slice(0, -1)) {
    for (const ans of Object.values(groupAnswers)) {
      if (!ans.probabilities) continue;
      const ranked = Object.entries(ans.probabilities).sort((a, b) => b[1]! - a[1]!);
      for (const [w, p] of ranked.slice(0, TOP_PER_BUCKET)) {
        if (p! > 0) finalists.push(w);
      }
    }
  }
  if (!finalists.includes(END)) finalists.push(END);

  const runoff = await post(state, { final: choiceQuestion(finalists.slice(0, MAX_CHOICES)) });
  const probs = runoff["final"]?.probabilities ?? {};
  return { probs, complete };
}

export async function generateReply(message: string, history: HistoryTurn[] = []): Promise<string> {
  const lang: Language = resolveLanguage(message);
  const vocab = buildVocabulary(message, lang);
  const words: string[] = [];

  for (let step = 0; step < MAX_WORDS; step++) {
    const turns: string[] = [];
    if (lang === "id") turns.push("(Reply in Indonesian, matching the user's language.)");
    for (const h of history) {
      turns.push(`${h.role === "assistant" ? "Jev" : "User"}: ${h.content}`);
    }
    turns.push(`User: ${message}`);
    turns.push(`Jev: ${render(words)}`);
    const state = turns.join("\n");

    const { probs, complete } = await nextWord(state, vocab);
    if (Object.keys(probs).length === 0) break;

    const alnumCount = words.filter((w) => /[a-z0-9]/i.test(w)).length;
    const stoppable = alnumCount >= MIN_WORDS;
    if (stoppable && complete >= STOP_THRESHOLD) {
      log(`[jev] noul=${complete.toFixed(2)} stop`);
      break;
    }

    const scored: Record<string, number> = {};
    for (const [w, p] of Object.entries(probs)) {
      if (p <= 0) continue;
      if (NO_SPACE_BEFORE.has(w) && words[words.length - 1] === w) continue;
      if (w === END && !stoppable) continue;
      scored[w] = p / penalty(words, w);
    }
    if (Object.keys(scored).length === 0) break;

    const ranked = Object.entries(scored).sort((a, b) => b[1]! - a[1]!);
    const word = ranked[0]![0];
    const top3 = ranked
      .slice(0, 3)
      .map(([w]) => `${w}:${((probs[w] ?? 0) * 100).toFixed(0)}%`)
      .join(" ");
    log(`[jev] [${String(step + 1).padStart(2)}] ${word.padEnd(12)} ${top3} done=${complete.toFixed(2)} lang=${lang}`);

    if (word === END) break;
    words.push(word);
  }

  return words.length > 0 ? render(words) : "...";
}
