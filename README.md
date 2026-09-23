# jev-kowi (discord.js + Bun)

Discord bot that makes [TypeSafe's Jev](https://openrouter.ai/~typesafe/jev-latest) talk. Jev is a decision model: it answers with calibrated probabilities, not text. The bot gives it a 20K word vocabulary and asks "next word?" in tournament sampling until a reply forms. TypeScript on Bun, English + Indonesian vocab.

## How it works

1. **Tournament sampling**: vocab shuffled into 255-word buckets, scored in parallel.
2. **Runoff**: top-2 per bucket compete in a final round.
3. **Completeness judge**: a `noul` question asks "is the reply complete?"
4. **Penalties**: content words 2.5x per reuse, stopwords (EN + ID) 1.6x. High-confidence repeats are banned outright as loop attractors.
5. **User-only history**: last 3 user messages as context; Jev's own output excluded (it poisons follow-ups).

The tournament now drafts only as fallback (see pipeline). Day to day, Jev judges and ranks while the router writes.

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
cp .env.example .env   # fill in tokens
```

`.env` needs:

```
DISCORD_TOKEN_JEV=your_discord_bot_token
OPENROUTER_API_KEY=your_openrouter_key
```

Enable **Message Content Intent** in the Discord developer portal. Grant **Read Message History** wherever it replies (the 50-message lookback runs in every reply channel).

```bash
bun start        # run
bun run dev      # watch mode
bun run typecheck
```

Invite via OAuth2 URL (bot scope; View Channels, Send Messages, Read Message History).

## Usage

Mention Jev or reply to its messages. Nothing else triggers it, except the ambient channel below.

Follow up mid-thinking and the stale run drops: latest wins per channel. Mentions always supersede ambient work; ambient yields to in-flight mentions. No queued stale replies, no doubles.

## Reply pipeline

1. **Pull 50**: channel history (humans plus Jev's own for reference; other bots out). Usermap (username, display name, id) built from active speakers. No extra calls, no privileged intents.
2. **Jev picks 10**: one `choice` call ranks relevance. Failures fall back to the 10 most recent.
3. **Router answers**: one direct reply from ranked context, in Jev's voice (silly, blunt, broken, factual). Knows the usermap: `<@id>` for listed people only, unknown IDs stripped, `@username` linked. Retried once on empty output.
4. **Post** as-is. Router fully down: capped 12-word tournament draft, coherence-gated, rejects post `...` instead of salad.

## Ambient channel (optional)

Set `JEV_AMBIENT_CHANNEL_ID`. Same fetch and top-10, then a tiered gate on the latest message:

- Score >= threshold (0.6), or the name "jev" appears: reply.
- Score in the tiebreak band (0.35-0.6): a second `noul` question decides (passes at 0.5).
- Below: skip. Failures stay silent.

Same pipeline after that. Answered messages are never re-answered.

## Reply engine settings

- `JEV_LLM_MODEL` (default `openrouter/free`): server-routed free model. Pin only to override.
- `JEV_LLM_MAX_WORDS` (default 20): per-reply budget, hard-capped at 2x.
- `JEV_LLM_MODE=off`: router off, tournament draft always.

Voice and facts live in the prompt (Prabowo president since Oct 2024). Free tier limits: 20 req/min, 50/day (1000/day after a one-time $10 credit buy). An exhausted router degrades to draft, then silence.

## Indonesian support

`vocab-id.txt`: 20K words. Everyday speech, Gen Z slang (`yapping`, `spill`, `ambyar`), regional address (`mas`, `bli`, `uda`, `pace`), 2019-2026 public life (presidents, ministers, candidates, parties, elections, football, esports), plus a usage-frequency fill matching the 20K English pool.

- `JEV_VOCAB_MODE=auto` (default): English always, Indonesian added on detection (`yang`, `nggak`, `gue`, `makasih`, ...). Message words always join, so names and slang echo through.
- `mixed`: both vocabs (code-switching; ~1 extra call per word in tournament mode).
- `en` / `id`: force one vocab.

Punctuation and digits are auto-injected, so `vocab-id.txt` holds words plus `#` headers and number tokens like `212`.

## Cost

About $0.001 per normal reply (relevance + judgments + one free router call). Tournament fallback costs ~$0.01-0.05 (~6 calls per word); Indonesian tournament pools combine both vocabs (~35K).

## Vocab

- `vocab-en.txt`: 20K words (from [bewinxed/jevgpt](https://github.com/bewinxed/jevgpt)), slurs removed.
- `vocab-id.txt`: 20K Indonesian words (curated core + frequency fill).

Words are freely addable and removable. The vocab IS the content filter.

## Project layout

```
src/
  index.ts   # client, history, mention/ambient dispatch, abort lock
  jev.ts     # tournament, choice/noul judges, coherence gate
  llm.ts     # router answer, draft rewrite, mention normalize
  context.ts # 50-fetch, top-10 relevance, usermap
  vocab.ts   # vocab loading, stopwords, language detect
  config.ts  # env config (Bun loads .env automatically)
vocab-en.txt
vocab-id.txt
```

All tuning constants via env. See `.env.example` and `src/config.ts`. Ported from `jev_bot.py` (discord.py); since rewritten around rank-and-answer.

## Privacy policy

- Default: only messages that mention Jev or reply to it are read. Nothing else is stored.
- Ambient channel set: recent non-bot messages there are also read, to judge address. No other channel scanned.
- Memory only: last 3 user turns per channel plus the per-reply usermap. Wiped on restart. Never written to disk, sold, or shared, except below.
- Generation sends your message plus context to OpenRouter (Jev model + free router model). Their policy and retention apply.
- No analytics, no tracking. No DMs unless you message first.

## Terms of service

- Novelty bot. Output may be nonsensical or wrong. Do not rely on it.
- Replies cost real API money. Do not spam; abusers may be blocked.
- No harassment, hate, spam, or illegal use. The vocab filters, not guarantees. You own what you ask.
- Discord ToS applies. No warranty; may go offline anytime.

## Credits

- [TypeSafe AI](https://typesafe.ai) for Jev
- [bewinxed/jevgpt](https://github.com/bewinxed/jevgpt) for the tournament sampling architecture and English vocab
- Built by [lyra](https://twitter.com/_lyraaaa_) + clod
