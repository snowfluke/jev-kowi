import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import { MAX_HISTORY, TOKEN, assertEnv } from "./config.ts";
import { generateReply, type HistoryTurn } from "./jev.ts";
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
  if (!(await shouldRespond(m))) return;
  const content = stripMention(m.content) || "hello";
  console.log(`${new Date().toISOString()} [jev] [IN] ${m.author.tag}: ${content.slice(0, 80)}`);
  addHistory(m.channelId, "user", content);

  // Keep the typing indicator alive — a reply takes ~1-3 min of tournaments.
  let typingTimer: Timer | undefined;
  try {
    if ("sendTyping" in m.channel && typeof m.channel.sendTyping === "function") {
      await m.channel.sendTyping();
      typingTimer = setInterval(() => {
        (m.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }, 5_000);
    }
    const reply = await withGenLock(async () => {
      const h = (channelHistory.get(m.channelId) ?? [])
        .slice(0, -1)
        .filter((x) => x.role === "user");
      return generateReply(content, h);
    });
    console.log(`${new Date().toISOString()} [jev] [OUT] ${reply}`);
    await m.reply({ content: reply, allowedMentions: { repliedUser: false } });
  } catch (e) {
    console.error(`${new Date().toISOString()} [jev] Error:`, e);
    try {
      await m.reply({ content: "...", allowedMentions: { repliedUser: false } });
    } catch {
      // ignore
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer);
  }
});

client.login(TOKEN);
