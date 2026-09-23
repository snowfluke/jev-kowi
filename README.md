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

Send a follow-up while Jev is still thinking and the stale run is dropped — latest message wins, per channel. Priority is explicit: a mention always supersedes ambient work, while ambient chatter never interrupts an in-flight mention reply (it yields before judging). No more queued replies to messages from three minutes ago, and no double replies when both paths fire at once.

## Reply pipeline

Every reply (mention, reply, ambient) flows through the same five stages:

1. **Pull 50** — recent channel history is fetched (humans plus Jev's own messages for reference; other bots excluded). A usermap (username, display name, id) is built from the active speakers — no extra calls, no privileged intents.
2. **Jev picks 10** — one `choice` call ranks the pool by relevance to the current message; failures fall back to the 10 most recent. This is where Jev's reranking lives.
3. **Router answers** — one direct reply from the ranked context, in Jev's voice (silly, blunt, broken, factual). It knows the usermap, so it can mention people with `<@id>`; unknown or invented IDs are stripped before sending, and `@username` is linked to the mapped ID. Retried once on empty output, since the router serves a random backend per call.
4. **Post** — the answer goes out as-is. Only when the router is fully down does the old word-by-word tournament run (capped at 12 words) as fallback — and Jev coherence-gates the draft first (salad scores ~0.06, good shorts ~0.96), so garbage posts `...` instead.

## Ambient channel (optional)

Set `JEV_AMBIENT_CHANNEL_ID` to a channel ID and Jev will listen there unprompted. Same 50-fetch and Jev top-10 as above, then a tiered gate on the latest message:

- Score ≥ `JEV_AMBIENT_THRESHOLD` (default 0.6), or the name "jev" appears → reply.
- Score between `JEV_AMBIENT_TIE_LOW` (default 0.35) and the threshold → a second `noul` question with different phrasing breaks the tie (replies at ≥ `JEV_AMBIENT_TIEBREAK`, default 0.5).
- Below that → skip. API failures fail silent — no reply.

Replies go through the same serialized pipeline, so ambient replies never overlap mention replies. An already-answered message is never answered twice.

## Replies: Jev reranks context, router answers (on by default)

Word-by-word tournament sampling gave Jev its charm but degenerated past a few words (`netral neutral netral…`, the 100-word pantun spiral) — and generating three candidate replies per message tripled output cost. So Jev's ranking moved to where it works best, the history: it picks the 10 relevant messages, the router answers once from them in Jev's voice, and that answer posts as-is:

- `JEV_LLM_MODEL` (default `openrouter/free`) — OpenRouter routes it server-side to a currently-available free model. Set it only to pin a specific model.
- `JEV_LLM_MAX_WORDS` (default 20) — per-candidate budget; output is defensively capped at 2x.
- `JEV_LLM_MODE=off` — skip the router entirely and always use the tournament draft.

The answer prompt enforces voice and facts (silly, blunt, a little broken; Prabowo president since Oct 2024). Router fully down → one capped 12-word tournament draft as fallback → `...` after that.

Free-tier note: `:free` models are rate-limited (20 req/min; 50/day, or 1000/day after a one-time $10 credit purchase). When the router is exhausted the bot falls back to the draft, then silence — degraded, never broken.

## Ambient channel (optional)

Set `JEV_AMBIENT_CHANNEL_ID` to a channel ID and Jev will listen there unprompted:

1. Every non-bot message triggers a lookback: the last `JEV_AMBIENT_FETCH` (default 10) non-bot messages are fetched as context.
2. If the latest message contains the name "jev", it replies immediately (free fast-path).
3. Otherwise Jev itself judges via one `noul` question ("is the latest message talking to Jev…?") and replies only when confidence ≥ `JEV_AMBIENT_THRESHOLD` (default 0.5). API failures fail silent — no reply.
4. Replies still go through the same serialized tournament pipeline, so ambient replies never overlap mention replies. An already-answered message is never answered twice.

Notes:

- The bot needs the **Read Message History** permission in any channel it replies in (the 50-message lookback runs everywhere now, not just the ambient channel).
- Each ambient message costs up to two judgment calls, plus full reply cost when it answers.
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

~$0.001 per normal reply (one relevance call, up to two ambient judgments, one free router call). A full tournament fallback runs ~$0.01–0.05 (~6 API calls per word). Indonesian replies cost a bit more when the tournament runs, since both 20K vocabs combine into a ~35K pool.

## Vocab

- `vocab-en.txt`: 20K word list (from [bewinxed/jevgpt](https://github.com/bewinxed/jevgpt)) with slurs removed.
- `vocab-id.txt`: 20K Indonesian words (curated core + frequency fill), see above.

Words can be added or removed freely — the vocab IS the content filter.

## Project layout

```
src/
  index.ts   # discord.js client, history, mention/reply handling, gen lock
  jev.ts     # tournament sampling + reply generation, choice/noul judges
  llm.ts     # router candidates in Jev's voice + legacy draft rewrite
  context.ts # 50-message fetch + Jev top-10 relevance picker
  vocab.ts   # vocab loading, ID/EN stopwords, language detection
  config.ts  # env-driven config (Bun loads .env automatically)
vocab-en.txt
vocab-id.txt
```

All tuning constants (`JEV_MAX_WORDS`, `JEV_STOP_THRESHOLD`, penalties, …) can be overridden via env — see `.env.example` and `src/config.ts`. Ported from the original `jev_bot.py` (discord.py + asyncio); behavior is identical except the lock is a promise queue instead of `asyncio.Lock`.

## Privacy policy

- By default the bot only reads messages that mention it or reply to it. Nothing else is read or stored.
- If `JEV_AMBIENT_CHANNEL_ID` is set, the bot additionally reads recent non-bot messages in that one channel to decide whether the latest message is addressed to it. No other channel is ever scanned.
- Mention/reply/ambient content is kept in memory (last 3 user messages per channel) to build conversational context, and is wiped on restart. The per-reply usermap (usernames, display names, IDs of active speakers) is derived from the same fetched messages and never stored. Nothing is written to disk, never sold, and never shared except as follows.
- To generate a reply, your message plus recent context is sent to OpenRouter (`~typesafe/jev-latest` for the draft, plus the free router model for the rewrite). OpenRouter's own privacy policy and retention apply to those requests.
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
