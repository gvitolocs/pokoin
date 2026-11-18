// Regenerate the Hermes parity fixtures. Does not read .env files: node:fs
// reads of dotenv paths fail with ENOENT before poko-connect.js loads config.js.
//
//   HERMES_RUNTIME=poko OPENAI_API_KEY=dummy \
//     node apps/poko-bot/tests/fixtures/gen_gate_cases.mjs
//
// Run from pokoin-rust/, or pass absolute paths; the Hermes checkout is read-only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const readFileSync = fs.readFileSync;
const existsSync = fs.existsSync;
const readFile = fs.promises.readFile.bind(fs.promises);

function isEnvFile(target) {
  const text = String(target);
  return (
    text === ".env" ||
    text.endsWith(`${path.sep}.env`) ||
    text.endsWith(".env.local") ||
    text.endsWith(`${path.sep}.env.local`)
  );
}

let blockedEnvReads = 0;
fs.readFileSync = function patchedRead(target, ...rest) {
  if (isEnvFile(target)) {
    blockedEnvReads += 1;
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  }
  return readFileSync.call(this, target, ...rest);
};
fs.existsSync = function patchedExists(target) {
  if (isEnvFile(target)) return false;
  return existsSync.call(this, target);
};
fs.promises.readFile = async function patchedReadFile(target, ...rest) {
  if (isEnvFile(target)) {
    blockedEnvReads += 1;
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  }
  return readFile.call(this, target, ...rest);
};

process.env.HERMES_RUNTIME = "poko";
process.env.OPENAI_API_KEY ||= "dummy-not-a-secret";
process.env.DOTENV_CONFIG_QUIET = "true";

const hermes = "/home/nez/Projects/Hermes/src";
const { shouldPokoEngage } = await import(`${hermes}/poko-reply-gate.js`);
const connect = await import(`${hermes}/poko-connect.js`);

const texts = [
  "",
  "   ",
  "hey poko",
  "ciao poko!",
  "poko, what is the wallet?",
  "pokémon",
  "pokoé",
  "perché",
  "come va",
  "come funziona pokoin",
  "mi spieghi la roadmap?",
  "non funziona il token",
  "buongiorno",
  "ciao",
  "hello everyone!",
  "thanks",
  "nice",
  "lfg",
  "ok",
  "gm",
  "random chatter about lunch",
  "lunch later?",
  "price?",
  "card?",
  "how do I start",
  "please look",
  "what is the pokoin wallet?",
  "show me the marketplace",
  "need help with the wallet",
  "can you check this card",
  "tell me about the roadmap",
  "explain the airdrop",
  "where is the contract address",
  "drop the wpkn ca pls",
  "ca",
  "c.a.",
  "wpkn contract",
  "what's the contract address",
  "poko ca",
  "send me the ca please",
  "https://pokoin.com/marketplace/card/1",
  "look at https://example.com/card",
  "@PokoBot price",
  "hey @everyone",
  "🔥",
  "😂 nice pull",
  "flareon card price?",
  "umbreon card",
  "flareon",
  "umbreon",
  "ask flareon",
  "tell flareon",
  "ping flareon",
  "flareon's tools",
  "flareon gmail",
  "ask hermes",
  "tell hermes",
  "gmail please",
  "check my inbox",
  "cursor project work",
  "journalctl -u poko",
  "what are we running today",
  "help",
  "support",
  "aiuto",
  "assistenza",
  "problema",
  "please",
  "pls",
  "dammi il token",
  "cerca questa card",
  "pokoin",
  "hypemeter",
  "marketplace",
  "wallet",
  "roadmap",
  "narrative",
  "token",
  "airdrop",
  "quest",
  "community",
  "pokemon tcg",
  "cards",
  "who is pikachu",
  "charizard price?",
];

const contexts = [
  { platform: "telegram", isDm: false, isMentioned: false, isReplyToBot: false, botUsername: "", channelName: "", parentName: "" },
  { platform: "telegram", isDm: true, isMentioned: false, isReplyToBot: false, botUsername: "PokoBot", channelName: "", parentName: "" },
  { platform: "discord", isDm: false, isMentioned: false, isReplyToBot: false, botUsername: "", channelName: "general", parentName: "" },
  { platform: "discord", isDm: false, isMentioned: true, isReplyToBot: false, botUsername: "", channelName: "general", parentName: "" },
  { platform: "discord", isDm: false, isMentioned: false, isReplyToBot: true, botUsername: "", channelName: "chat", parentName: "" },
  { platform: "discord", isDm: true, isMentioned: false, isReplyToBot: false, botUsername: "", channelName: "", parentName: "" },
  { platform: "discord", isDm: false, isMentioned: false, isReplyToBot: false, botUsername: "", channelName: "support", parentName: "help" },
  { platform: "telegram", isDm: false, isMentioned: false, isReplyToBot: false, botUsername: "PokoBot", channelName: "", parentName: "assistenza" },
];

const gateCases = [];
for (const text of texts) {
  for (const context of contexts) {
    const input = { text, ...context };
    const expected = shouldPokoEngage(input);
    gateCases.push({
      text,
      platform: context.platform,
      isDm: context.isDm,
      isMentioned: context.isMentioned,
      isReplyToBot: context.isReplyToBot,
      botUsername: context.botUsername,
      channelName: context.channelName,
      parentName: context.parentName,
      expected: { shouldReply: expected.shouldReply, reason: expected.reason },
    });
  }
}

if (gateCases.length < 120) {
  throw new Error(`gate fixture has ${gateCases.length} cases, need at least 120`);
}

const connectInputs = [
  ["/connect ABCD1234", "PokoBot"],
  ["/connect@PokoBot ABCD1234", "PokoBot"],
  ["/connect@OtherBot ABCD1234", "PokoBot"],
  ["/start", "PokoBot"],
  ["/start@PokoBot", "PokoBot"],
  ["/start connect_ABCD12", "PokoBot"],
  ["/start connect-ZXCV99", "PokoBot"],
  ["/help", "PokoBot"],
  ["/help@pokobot", "PokoBot"],
  ["/whoami", "PokoBot"],
  ["/disconnect", "PokoBot"],
  ["/CONNECT code12", "PokoBot"],
  ["connect ABCD1234", "PokoBot"],
  ["/connect", "PokoBot"],
  ["/unknown", "PokoBot"],
  ["hello", "PokoBot"],
  ["/connect ABCD extra", "PokoBot"],
  ["  /whoami  ", "PokoBot"],
  ["/start@", "PokoBot"],
  ["", "PokoBot"],
];

const connectCases = [];
for (const [text, botUsername] of connectInputs) {
  connectCases.push({
    fn: "parseTelegramCommand",
    text,
    botUsername,
    expected: connect.parseTelegramCommand(text),
  });
  connectCases.push({
    fn: "parseDiscordCommand",
    text,
    expected: connect.parseDiscordCommand(text),
  });
}
for (const text of [" ABCD1234 ", "abcd1234", "abc", "ABC_1234", "ABCDEFGHIJKLM", "ab cd12", "", "  ", "zz99zz"]) {
  connectCases.push({
    fn: "normalizeLinkCode",
    text,
    expected: connect.normalizeLinkCode(text),
  });
}

if (connectCases.length < 30) {
  throw new Error(`connect fixture has ${connectCases.length} cases, need at least 30`);
}

fs.writeFileSync(path.join(here, "gate_cases.json"), `${JSON.stringify(gateCases, null, 2)}\n`);
fs.writeFileSync(path.join(here, "connect_cases.json"), `${JSON.stringify(connectCases, null, 2)}\n`);
console.log(`gate ${gateCases.length} connect ${connectCases.length} blockedEnvReads ${blockedEnvReads}`);
