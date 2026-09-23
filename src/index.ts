import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { AMBIENT_CHANNEL_ID, MAX_HISTORY, TOKEN, assertEnv } from "./config.ts";
import { generateReply, type HistoryTurn } from "./jev.ts";
import { briefAnswer, enhanceReply } from "./llm.ts";
import { decideAmbient } from "./ambient.ts";
import { RELEVANT_K, fetchChannelHistory, pickRelevant, toRelevant, type RelevantMsg } from "./context.ts";
import { vocabSizes } from "./vocab.ts";

assertEnv();

// --- History: last MAX_HISTORY user turns per channel (Jev's own broken
// output is excluded — it poisons follow-ups, same as the Python original). ---
const channelHistory = new Map<string, HistoryTurn[]>();

function addHistory(channelId: string, role: HistoryTurn["role"], content: string): void {
  const h = channelHistory.get(channelId) ?? [];
  h.push({ role, content });
  channelHistory.set(channelId, h.slice(-MAX_HISTORY));
}

// --- Serialize generation so tournaments never overlap (API cost control). ---
let genQueue: Promise<void> = Promise.resolve();

function withGenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = genQueue.then(fn, fn);
  genQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function stripMention(content: string): string {
  return content.replace(/<@!?\d+>/g, "").trim();
}

async function shouldRespond(m: Message): Promise<boolean> {
  if (m.author.bot) return false;
  if (m.client.user && m.mentions.has(m.client.user)) return true;
  if (m.reference?.messageId) {
    try {
      const ref = await m.fetchReference();
      if (ref.author.id === m.client.user?.id) return true;
    } catch {
      // referenced message deleted / not accessible — ignore
    }
  }
  return false;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  const { en, id } = vocabSizes();
  console.log(`${new Date().toISOString()} [jev] online as ${c.user.tag} | vocab en=${en} id=${id}`);
});

client.on(Events.MessageCreate, async (m) => {
  if (await shouldRespond(m)) {
    const content = stripMention(m.content) || "hello";
    console.log(`${new Date().toISOString()} [jev] [IN] ${m.author.tag}: ${content.slice(0, 80)}`);
    addHistory(m.channelId, "user", content);
    const h = (channelHistory.get(m.channelId) ?? [])
      .slice(0, -1)
      .filter((x) => x.role === "user");
    await handleReply(m, content, h);
    return;
  }
  if (m.author.bot) return;
  if (AMBIENT_CHANNEL_ID && m.channelId === AMBIENT_CHANNEL_ID) {
    await handleAmbient(m);
  }
});

// Last message ID Jev already answered in ambient mode — guards against
// double replies when messages arrive in quick succession.
let lastAmbientReplyId: string | null = null;

async function handleAmbient(m: Message): Promise<void> {
  const selfId = m.client.user?.id;
  const all = await fetchChannelHistory(m.channel, selfId);
  if (!all || all.length === 0) return;
  const target = all[all.length - 1]!;
  if (target.id === lastAmbientReplyId) return;
  if (target.author.bot) return; // never reply to self

  const relevant = await pickRelevant(target.content, toRelevant(all.slice(0, -1), selfId), RELEVANT_K);
  const { reply, score, reason } = await decideAmbient(
    [...relevant, ...toRelevant([target], selfId)],
    target.content,
  );
  console.log(
    `${new Date().toISOString()} [jev] [AMBIENT] score=${score.toFixed(2)} reason=${reason} -> ${reply ? "reply" : "skip"}: ${target.content.slice(0, 80)}`,
  );
  if (!reply) return;

  lastAmbientReplyId = target.id;
  const content = stripMention(target.content) || "hello";
  console.log(`${new Date().toISOString()} [jev] [IN ambient] ${target.author.tag}: ${content.slice(0, 80)}`);
  addHistory(target.channelId, "user", content);
  const h = (channelHistory.get(target.channelId) ?? [])
    .slice(0, -1)
    .filter((x) => x.role === "user");
  await handleReply(target, content, h);
}

// In-flight generation per channel. A new message aborts the previous
// task in the same channel — latest wins, stale replies are dropped.
const channelTasks = new Map<string, AbortController>();

async function handleReply(m: Message, content: string, history: HistoryTurn[]): Promise<void> {
  channelTasks.get(m.channelId)?.abort();
  const ctrl = new AbortController();
  channelTasks.set(m.channelId, ctrl);
  const signal = ctrl.signal;

  // Keep the typing indicator alive — a reply takes ~1-3 min of tournaments.
  let typingTimer: Timer | undefined;
  try {
    if ("sendTyping" in m.channel && typeof m.channel.sendTyping === "function") {
      await m.channel.sendTyping();
      typingTimer = setInterval(() => {
        (m.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }, 5_000);
    }
    // 1-2. Pull channel history, let Jev pick the relevant ones.
    let genHistory = history;
    let relevant: RelevantMsg[] = [];
    const pool = await fetchChannelHistory(m.channel, m.client.user?.id, m.id);
    if (pool && pool.length > 0) {
      relevant = await pickRelevant(content, toRelevant(pool, m.client.user?.id), RELEVANT_K, signal);
      const humans = relevant
        .filter((r) => !r.mine)
        .slice(-MAX_HISTORY)
        .map((r): HistoryTurn => ({ role: "user", content: r.content || "hello" }));
      if (humans.length > 0) genHistory = humans;
    }
    // 3. LLM brief fuels Jev's tournament; "" on any failure.
    const brief = relevant.length > 0 ? await briefAnswer(content, relevant, signal) : "";
    if (brief) console.log(`${new Date().toISOString()} [jev] [BRIEF] ${brief.slice(0, 120)}`);
    // 4-5. Jev drafts from the enriched state, LLM rewrites short.
    const draft = await withGenLock(() => generateReply(content, genHistory, signal, brief));
    const reply = await enhanceReply({ message: content, history: genHistory, draft }, signal);
    if (reply !== draft) {
      console.log(`${new Date().toISOString()} [jev] [LLM] draft="${draft}" final="${reply}"`);
    }
    console.log(`${new Date().toISOString()} [jev] [OUT] ${reply}`);
    await m.reply({ content: reply, allowedMentions: { repliedUser: false } });
  } catch (e) {
    if (signal.aborted) {
      console.log(`${new Date().toISOString()} [jev] [DROP] superseded by newer message, no reply`);
      return;
    }
    console.error(`${new Date().toISOString()} [jev] Error:`, e);
    try {
      await m.reply({ content: "...", allowedMentions: { repliedUser: false } });
    } catch {
      // ignore
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer);
    if (channelTasks.get(m.channelId) === ctrl) channelTasks.delete(m.channelId);
  }
}

client.login(TOKEN);
