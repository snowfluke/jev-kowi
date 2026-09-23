import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { AMBIENT_CHANNEL_ID, MAX_HISTORY, TOKEN, assertEnv } from "./config.ts";
import { generateReply, type HistoryTurn } from "./jev.ts";
import { enhanceReply, llmAnswer } from "./llm.ts";
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
    await handleReply(m, content, h, "mention");
    return;
  }
  if (m.author.bot) return;
  if (AMBIENT_CHANNEL_ID && m.channelId === AMBIENT_CHANNEL_ID) {
    await handleAmbient(m);
  }
});

// In-flight task per channel. A newer message supersedes per the priority
// rule below — latest wins, stale replies are dropped.
const channelTasks = new Map<string, { ctrl: AbortController; kind: ReplyKind }>();

// Last message ID Jev already answered in ambient mode — guards against
// double replies when messages arrive in quick succession.
let lastAmbientReplyId: string | null = null;

type ReplyKind = "mention" | "ambient";

/**
 * Priority rule. Mentions always win; ambient yields to an in-flight
 * mention but supersedes older ambient work. Pure — unit-testable.
 */
export function shouldSupersede(prevKind: ReplyKind | undefined, newKind: ReplyKind): boolean {
  if (!prevKind) return true;
  if (newKind === "mention") return true;
  return prevKind === "ambient";
}

async function handleAmbient(m: Message): Promise<void> {
  // A mention is already thinking here — don't even judge, let it finish.
  if (channelTasks.get(m.channelId)?.kind === "mention") {
    console.log(`${new Date().toISOString()} [jev] [AMBIENT] yield: mention in flight, skip`);
    return;
  }
  // Register the judge phase so a mention arriving mid-judge aborts it.
  const judgeCtrl = new AbortController();
  channelTasks.set(m.channelId, { ctrl: judgeCtrl, kind: "ambient" });
  try {
    const selfId = m.client.user?.id;
    const all = await fetchChannelHistory(m.channel, selfId);
    if (!all || all.length === 0) return;
    const target = all[all.length - 1]!;
    if (target.id === lastAmbientReplyId) return;
    if (target.author.bot) return; // never reply to self

    const relevant = await pickRelevant(
      target.content,
      toRelevant(all.slice(0, -1), selfId),
      RELEVANT_K,
      judgeCtrl.signal,
    );
    const { reply, score, reason } = await decideAmbient(
      [...relevant, ...toRelevant([target], selfId)],
      target.content,
      judgeCtrl.signal,
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
    await handleReply(target, content, h, "ambient");
  } catch (e) {
    if (judgeCtrl.signal.aborted) {
      console.log(`${new Date().toISOString()} [jev] [AMBIENT] aborted by newer message, stop`);
      return;
    }
    throw e;
  } finally {
    const cur = channelTasks.get(m.channelId);
    if (cur?.ctrl === judgeCtrl) channelTasks.delete(m.channelId);
  }
}

async function handleReply(
  m: Message,
  content: string,
  history: HistoryTurn[],
  kind: ReplyKind,
): Promise<void> {
  const prev = channelTasks.get(m.channelId);
  if (prev && !shouldSupersede(prev.kind, kind)) {
    console.log(
      `${new Date().toISOString()} [jev] [YIELD] ${kind} yields to in-flight ${prev.kind}, skip`,
    );
    return;
  }
  prev?.ctrl.abort();
  const ctrl = new AbortController();
  channelTasks.set(m.channelId, { ctrl, kind });
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
    // 3. Router answers from Jev-ranked context; tournament draft
    // (coherence-gated) is the outage fallback.
    let reply = await llmAnswer(content, relevant, signal);
    if (!reply) {
      const draft = await withGenLock(() => generateReply(content, genHistory, signal, 12));
      reply = await enhanceReply({ message: content, history: genHistory, draft }, signal);
      if (reply !== draft) {
        console.log(`${new Date().toISOString()} [jev] [LLM] draft="${draft}" final="${reply}"`);
      }
    }
    console.log(`${new Date().toISOString()} [jev] [OUT] ${reply}`);
    if (signal.aborted) {
      console.log(`${new Date().toISOString()} [jev] [DROP] aborted before send, no reply`);
      return;
    }
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
    const cur = channelTasks.get(m.channelId);
    if (cur?.ctrl === ctrl) channelTasks.delete(m.channelId);
  }
}

client.login(TOKEN);
