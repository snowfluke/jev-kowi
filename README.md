# jevbot (discord.js + Bun)

Discord bot that makes [TypeSafe's Jev](https://openrouter.ai/~typesafe/jev-latest) talk — a decision model that "cannot generate text," loomed word-by-word into broken sentences. Now in TypeScript on Bun, with English + Indonesian vocab.

Jev is a non-autoregressive decision model. It answers questions with calibrated probabilities, not text. This bot gives it a word vocabulary and asks "next word?" repeatedly via tournament sampling until it forms a reply.

## How it works

1. **Tournament sampling**: vocab shuffled into 255-word buckets, all scored in parallel
2. **Runoff**: top-2 from each bucket compete in a final round
3. **Completeness judge**: a separate `noul` question asks "is the reply complete?" — jev stops when it thinks it's done
4. **Penalty system**: content words penalized 2.5x per reuse, stopwords (EN + ID) 1.6x — prevents "is are I is are" loops
5. **User-only history**: last 3 user messages included as context; jev's own broken output is excluded (it poisons follow-ups)

## Output examples

- "I love jazz because its improvised and freedom."
- "Rock.? Yeah"
- "No because overkill. Overkill!.!.!"
- "I depends on on situation of circumstances."
- "Yuck no ugh spit! Gag gagging ing"
- "Band is from california in san los angeles. Las angels."

## Setup

Requires [Bun](https://bun.sh) v1+.

```bash
bun install
cp .env.example .env   # then fill in your tokens
```

`.env` needs:

```
DISCORD_TOKEN_JEV=your_discord_bot_token
OPENROUTER_API_KEY=your_openrouter_key
```

Enable **Message Content Intent** in the Discord developer portal.

```bash
bun start        # run the bot
bun run dev      # run with --watch
bun run typecheck
```

## Usage

Mention jev or reply to jev's messages. Replies only — it won't respond to messages that don't involve it.

## LLM enhancement (optional, on by default)

Tournament sampling gives Jev its charm but also its incoherence (`2 jokowi 2`). After Jev drafts a reply, a chat model rewrites it — short, same language, still silly and a little broken, but coherent and factually fixed:

- `JEV_LLM_MODELS` — optional manual pin (comma-separated). Leave unset and the bot discovers free chat models itself from OpenRouter's live catalog, cached hourly: text-in/text-out `:free` models, junk categories (audio, embedding, safety, code-only) filtered out, generalist vendors first, `openrouter/free` last as the catch-all. First 4 candidates plus the router as the guaranteed final attempt; any failure (ended, 429, provider down, empty, reasoning leak, narration) moves on. Nothing to update when free models rotate.
- `JEV_LLM_MAX_WORDS` (default 20) — the rewrite budget; output is defensively capped at 2x, and drafts aren't generated past 2x either, so keep `JEV_MAX_WORDS` at 30–40 when enhancement is on. Longer only burns minutes and money on words the rewriter cuts.
- `JEV_LLM_MODE=off` — skip the LLM entirely and send Jev's raw draft.

The prompt tells the model to keep Jev's voice and only fix what's wrong (e.g. Indonesia's president is Prabowo since Oct 2024, not Jokowi). Any LLM failure fails safe to the raw draft, and the log shows which model answered plus both texts (`[LLM] model=…`, `[LLM] draft="…" final="…"`).

Free-tier note: `:free` models are rate-limited (20 req/min; 50/day, or 1000/day after a one-time $10 credit purchase). When every candidate is exhausted the bot just sends Jev's raw draft — degraded, never broken.

## Ambient channel (optional)

Set `JEV_AMBIENT_CHANNEL_ID` to a channel ID and Jev will listen there unprompted:

1. Every non-bot message triggers a lookback: the last `JEV_AMBIENT_FETCH` (default 10) non-bot messages are fetched as context.
2. If the latest message contains the name "jev", it replies immediately (free fast-path).
3. Otherwise Jev itself judges via one `noul` question ("is the latest message talking to Jev…?") and replies only when confidence ≥ `JEV_AMBIENT_THRESHOLD` (default 0.5). API failures fail silent — no reply.
4. Replies still go through the same serialized tournament pipeline, so ambient replies never overlap mention replies. An already-answered message is never answered twice.

Notes:

- The bot needs the **Read Message History** permission in that channel.
- Each ambient message costs one judgment API call, plus full tournament cost when it replies.
- Mention/reply behavior is unchanged and takes priority everywhere, including the ambient channel.

## Indonesian support

`vocab-id.txt` holds 20K curated Indonesian words: everyday verbs/nouns, Gen Z slang (`yapping`, `spill`, `ambyar`), regional address words (`mas`, `bli`, `uda`, `pace`), 2019–2026 public life — presidents, ministers, candidates, parties, elections, football and esports — plus a top usage-frequency fill so the pool matches the 20K English vocab word for word.

Per-message language handling (`src/vocab.ts`):

- `JEV_VOCAB_MODE=auto` (default): English always; Indonesian vocab is added when Indonesian markers are detected (`yang`, `nggak`, `gue`, `makasih`, …). Message words are always added, so names and slang echo through either way.
- `mixed`: always both vocabs (supports code-switching, costs ~1 extra API call per word).
- `en` / `id`: force a single vocab.
- Indonesian replies get a `(Reply in Indonesian…)` hint line in the decision state; Indonesian function words (`yang`, `dan`, `dong`, `nih`, …) get the gentler stopword penalty so Jev can still glue sentences together.

Punctuation and digit tokens are injected automatically, so `vocab-id.txt` holds words (plus `#` comment section headers and a few number tokens like `212`).

## Cost

~$0.01–0.05 per reply via OpenRouter for the tournament sampling (~6 API calls per word). Indonesian replies cost a bit more — both 20K vocabs combine into a ~35K pool. The enhancement model defaults to a free tier, so it adds latency (~seconds) but no cost.

## Vocab

- `vocab-en.txt`: 20K word list (from [bewinxed/jevgpt](https://github.com/bewinxed/jevgpt)) with slurs removed.
- `vocab-id.txt`: 20K Indonesian words (curated core + frequency fill), see above.

Words can be added or removed freely — the vocab IS the content filter.

## Project layout

```
src/
  index.ts   # discord.js client, history, mention/reply handling, gen lock
  jev.ts     # tournament sampling + reply generation
  llm.ts     # chat-model rewrite of Jev's draft (short, same voice)
  vocab.ts   # vocab loading, ID/EN stopwords, language detection
  config.ts  # env-driven config (Bun loads .env automatically)
vocab-en.txt
vocab-id.txt
```

All tuning constants (`JEV_MAX_WORDS`, `JEV_STOP_THRESHOLD`, penalties, …) can be overridden via env — see `.env.example` and `src/config.ts`. Ported from the original `jev_bot.py` (discord.py + asyncio); behavior is identical except the lock is a promise queue instead of `asyncio.Lock`.

## Privacy policy

- By default the bot only reads messages that mention it or reply to it. Nothing else is read or stored.
- If `JEV_AMBIENT_CHANNEL_ID` is set, the bot additionally reads recent non-bot messages in that one channel to decide whether the latest message is addressed to it. No other channel is ever scanned.
- Mention/reply/ambient content is kept in memory (last 3 user messages per channel) to build conversational context, and is wiped on restart. It is never written to disk, never sold, and never shared except as follows.
- To generate a reply, your message plus recent context is sent to OpenRouter (`~typesafe/jev-latest` for the draft, plus the `JEV_LLM_MODELS` chat chain for the rewrite). OpenRouter's own privacy policy and retention apply to those requests.
- No analytics, no tracking, no DMs unless you message the bot first. Ask the operator to wipe in-memory history any time.

## Terms of service

- The bot is a novelty. Its output is broken by design and may be nonsensical or wrong — do not rely on it.
- Replies cost the operator real API money (~$0.01–0.05 each). Do not spam it; the operator may rate-limit, ignore, or block abusers.
- Do not use the bot for harassment, hate, spam, or anything illegal. The vocab is a curated filter, not a guarantee — you are responsible for what you ask it to say.
- The bot runs on Discord, so Discord's Terms of Service apply. The service may go offline, break, or change at any time with no warranty.

## Credits

- [TypeSafe AI](https://typesafe.ai) for Jev
- [bewinxed/jevgpt](https://github.com/bewinxed/jevgpt) for the tournament sampling architecture and English vocab
- Built by [lyra](https://twitter.com/_lyraaaa_) + clod
