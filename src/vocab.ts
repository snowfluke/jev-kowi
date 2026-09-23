import { existsSync, readFileSync } from "node:fs";
import { END, VOCAB_EN_PATH, VOCAB_ID_PATH, VOCAB_MODE } from "./config.ts";

const BANNED = new Set(["unanswered"]);

// Punctuation / digit tokens live at the tail of the original vocab.txt.
// They must be present no matter which language mode is active, otherwise
// `id`-only mode could never end a sentence or use numbers.
const PUNCT_TOKENS = [".", ",", "!", "?", "'", '"', "-", ":", ";", "(", ")", "\n"];
const DIGIT_TOKENS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function loadWords(path: string): string[] {
  if (!existsSync(path)) {
    console.warn(`[jev] vocab file not found: ${path}`);
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w !== "" && !BANNED.has(w.toLowerCase()));
}

function stripPunctAndDigits(words: string[]): string[] {
  const extra = new Set([...PUNCT_TOKENS, ...DIGIT_TOKENS]);
  return words.filter((w) => !extra.has(w));
}

const RAW_EN = loadWords(VOCAB_EN_PATH);
const RAW_ID = loadWords(VOCAB_ID_PATH);

export const BASE_VOCAB_EN = stripPunctAndDigits(RAW_EN);
export const BASE_VOCAB_ID = stripPunctAndDigits(RAW_ID);

/** Tokens that are always appended regardless of language mode. */
export const BASE_TOKENS_ALWAYS = [...PUNCT_TOKENS, ...DIGIT_TOKENS];

console.log(
  `[jev] vocab loaded: en=${BASE_VOCAB_EN.length} id=${BASE_VOCAB_ID.length} (+${BASE_TOKENS_ALWAYS.length} punct/digit tokens)`,
);

// --- Stopwords (content vs filler penalty) ---

const EN_STOPWORDS = new Set(
  "a an the and or but if of to in on at by for with from as is are was were be been " +
    "being it its this that these those i you he she they we me him her them us my your " +
    "his their our not no so then than there here when where which who what how all any " +
    "some each into over under about above below up down out off again more most very " +
    "can will just do does did have has had would could should may might must".split(" "),
);

// Frequent Indonesian function words. Same role as EN_STOPWORDS: they get the
// gentler STOP_PENALTY so Jev can still use them to glue sentences together.
const ID_STOPWORDS = new Set(
  (
    "yang dan di ke dari pada untuk dengan oleh sebagai adalah ialah itu ini these mereka kami kita " +
    "saya aku kamu kau kalian dia beliau anda gue gua lu lo elo bro sis kak bang pak bu mas mbak " +
    "tidak tak nggak ngga enggak ga gak jangan belum sudah udah telah akan mau bisa dapat bisa dapatnya " +
    "harus perlu boleh janganlah lah kah pun nya ku mu nya si sang para atau ataupun tapi tetapi namun " +
    "melainkan sedangkan sementara kalau jika bila jikalau karena sebab agar supaya biar biarpun " +
    "meskipun walaupun walau kendati saat ketika waktu kapan dimana kemana darimana bagaimana berapa " +
    "apa siapa mengapa kenapa yang mana ini itu sini situ sana sinilah situlah sanalah sangat amat " +
    "sungguh benar benar-benar sekali saja sahajalah juga pun lagi masih terus selalu sering kadang " +
    "kadang-kadang jarang pernah belum pernah sudah pernah akan segera nanti tadi kemarin besok kini " +
    "sekarang dulu dahulu kemudian lalu lantas terus maka jadi sehingga hingga sampai sejak semenjak " +
    "selama sambil seraya tanpa tanpa kecuali selain selain itu apalagi malah bahkan justru hanya " +
    "cuma cuman doang aja saja kok sih deh dong nih tuh wah lho loh ya yuk ayo mari silakan tolong " +
    "maaf permisi halo hai hei oh ah eh hmm waduh aduh astaga ya ampun alhamdulillah masyaallah " +
    "insyaallah wkwk haha hehe"
  ).split(/\s+/),
);

export const STOPWORDS = new Set([...EN_STOPWORDS, ...ID_STOPWORDS]);

// --- Language detection ---

// High-signal Indonesian markers (function words + slang rarely seen in English).
const ID_MARKERS = new Set(
  (
    "yang tidak dengan untuk dari adalah itu ini saya kamu aku dia mereka kita kami " +
    "bisa sudah sedang akan sangat juga karena kalau atau tapi tetapi namun agar supaya " +
    "ketika sangatlah gue gua lu lo elo kak bang mas mbak pak bu wkwk nggak enggak gak " +
    "udah belum gimana kenapa siapa apa kabar terima kasih tolong maaf permisi halo " +
    "dong sih aja kok nih tuh deh yuk ayo banget sekali lagi masih pernah jangan harus " +
    "perlu boleh dapat mau tahu tau lihat dengar bilang kata orang hari malam pagi sore " +
    "rumah makan minum tidur kerja main anak ibu bapak adik kakak teman pacar sayang " +
    "cinta benci rindu kangen senang sedih marah takut capek lelah lapar haus sakit " +
    "sehat gila bodoh pintar cantik ganteng jelek bagus jelek mahal murah besar kecil " +
    "panjang pendek tinggi rendah jauh dekat lama cepat lambat baru lama panas dingin " +
    "hujan terang gelap ramai sepi bersih kotor penuh kosong mudah susah sulit gampang " +
    "benar salah baik buruk jahat jujur bohong janji sumpah doa tuhan allah makasih ya ga"
  ).split(/\s+/),
);

export type Language = "en" | "id";

/** Very small heuristic: >=2 marker hits (or 1 hit in a short message) => Indonesian. */
export function detectLanguage(message: string): Language {
  const words = message.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return "en";
  let hits = 0;
  for (const w of words) {
    if (ID_MARKERS.has(w)) hits++;
  }
  if (hits >= 2) return "id";
  if (hits === 1 && words.length <= 4) return "id";
  return "en";
}

export function resolveLanguage(message: string): Language {
  if (VOCAB_MODE === "id") return "id";
  if (VOCAB_MODE === "en") return "en";
  // "mixed" still reports the detected language so the state prompt can hint it,
  // but the vocab pool always contains both languages (see buildVocabulary).
  return detectLanguage(message);
}

/**
 * Build the per-message vocab pool.
 * - en: English only. - id: Indonesian only.
 * - mixed: always both (supports code-switching, costs ~1 extra call/word).
 * - auto (default): English always; Indonesian added when detected.
 * Message words are always added (Jev echoes names/slang), then punct/digits, then END.
 */
export function buildVocabulary(message: string, lang: Language): string[] {
  const seen = new Set<string>();
  const base: string[] = [];
  const pushAll = (words: string[]) => {
    for (const w of words) {
      if (!seen.has(w)) {
        seen.add(w);
        base.push(w);
      }
    }
  };

  if (VOCAB_MODE === "en") pushAll(BASE_VOCAB_EN);
  else if (VOCAB_MODE === "id") pushAll(BASE_VOCAB_ID);
  else if (VOCAB_MODE === "mixed") {
    pushAll(BASE_VOCAB_EN);
    pushAll(BASE_VOCAB_ID);
  } else if (lang === "id") {
    pushAll(BASE_VOCAB_EN);
    pushAll(BASE_VOCAB_ID);
  } else {
    pushAll(BASE_VOCAB_EN);
  }

  const extra: string[] = [];
  for (const w of message.toLowerCase().match(/[a-z']+/g) ?? []) {
    if (!seen.has(w)) {
      seen.add(w);
      extra.push(w);
    }
  }
  return [...base, ...extra, ...BASE_TOKENS_ALWAYS, END];
}

export function vocabSizes(): { en: number; id: number } {
  return { en: BASE_VOCAB_EN.length, id: BASE_VOCAB_ID.length };
}
