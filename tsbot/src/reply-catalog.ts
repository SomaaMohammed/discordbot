import type {
  ConversationIntent,
  SimpleConversationIntentType,
} from "./conversation.js";

export interface ConversationReplyContext {
  guildId: string;
  invocation: string;
  botVersion: string;
  timezone: string;
  currentTime: string;
  gatewayPingMs: number | null;
  uptimeMs: number | null;
  randomInt: (maxExclusive: number) => number;
}

type ReplyFactory = (context: ConversationReplyContext) => string;

const greetingReplies: readonly ReplyFactory[] = [
  () => "Hi! What can I help with?",
  () => "Hello! How can I help?",
  () => "Hey! What do you need?",
  () => "Hi there! Ready when you are.",
  () => "Hey there! How can I help?",
  () => "Hello! What would you like to do?",
  () => "Hi! I’m here and ready to help.",
  () => "Hey! Ask me a question or try a utility.",
];

const wellbeingReplies: readonly ReplyFactory[] = [
  () => "I’m doing well and ready to help. How are you?",
  () => "Doing great, thanks! What’s up?",
  () => "All good here. How’s it going with you?",
  () => "I’m good and online. What can I do for you?",
  () => "Running smoothly, thanks for asking!",
  () => "I’m doing well. Need a hand with anything?",
  () => "Good over here! How are things with you?",
  () => "I’m all set and ready when you are.",
];

const activityReplies: readonly ReplyFactory[] = [
  () => "I’m here, watching for commands and questions.",
  () => "Just standing by to help this server.",
  () => "Waiting for something useful to do. What’s up?",
  () => "I’m online and ready for your next request.",
  () => "Keeping an eye out for commands and replies.",
  () => "Right now, I’m ready to help you.",
  () => "Nothing urgent—just waiting for your request.",
  () => "I’m available. Want to try a command or utility?",
];

const helpReplies: readonly ReplyFactory[] = [
  (context) =>
    `Try \`${inline(context.invocation)} cmds\`, \`${inline(context.invocation)} ping\`, \`${inline(context.invocation)} roll 2d6\`, or \`${inline(context.invocation)} choose tea or coffee\`.`,
  (context) =>
    `I understand short requests such as \`${inline(context.invocation)} hru\`, \`${inline(context.invocation)} wyd\`, \`${inline(context.invocation)} time now\`, and \`${inline(context.invocation)} ver\`.`,
  (context) =>
    `For chat help, try \`${inline(context.invocation)} commands\`. Slash commands are grouped under \`/config\`, \`/data\`, \`/panel\`, \`/utility\`, \`/activity\`, and \`/greetings\`.`,
  (context) =>
    `Useful examples: \`${inline(context.invocation)} uptime\`, \`${inline(context.invocation)} flip a coin\`, and \`${inline(context.invocation)} what time is it\`.`,
  (context) =>
    `Address me at the start or end of a request, mention me, or reply to one of my messages. Try \`${inline(context.invocation)} ping\`.`,
  (context) =>
    `I can answer status questions, roll bounded dice, and choose from a short list. Start with \`${inline(context.invocation)} help\`.`,
  (context) =>
    `Try \`hey ${inline(context.invocation)}, wyd?\`, \`${inline(context.invocation)} roll d20\`, or \`thanks ${inline(context.invocation)}\`.`,
  (context) =>
    `Need the command groups? Use \`/utility\` for information tools, \`/channel\` for channel tools, and \`/moderation\` for case management—or say \`${inline(context.invocation)} cmds\`.`,
];

const thanksReplies: readonly ReplyFactory[] = [
  () => "You’re welcome!",
  () => "Anytime!",
  () => "Happy to help!",
  () => "No problem!",
  () => "Glad I could help.",
  () => "You got it!",
  () => "Of course!",
  () => "Sure thing!",
];

const farewellReplies: readonly ReplyFactory[] = [
  () => "See you later!",
  () => "Take care!",
  () => "Bye for now!",
  () => "Catch you later!",
  () => "Have a good one!",
  () => "Goodnight!",
  () => "See you around!",
  () => "Talk to you later!",
];

const pingReplies: readonly ReplyFactory[] = [
  (context) => pingLine(context, "Pong! Gateway latency"),
  (context) => pingLine(context, "Online. Current gateway latency"),
  (context) => pingLine(context, "I’m here. Gateway latency"),
  (context) => pingLine(context, "Connection check complete. Gateway latency"),
  (context) => pingLine(context, "Ready. Current gateway latency"),
  (context) => pingLine(context, "Status: online. Gateway latency"),
  (context) => pingLine(context, "Response received. Gateway latency"),
  (context) => pingLine(context, "Available now. Gateway latency"),
];

const uptimeReplies: readonly ReplyFactory[] = [
  (context) => uptimeLine(context, "Uptime"),
  (context) => uptimeLine(context, "Current uptime"),
  (context) => uptimeLine(context, "I have been online for"),
  (context) => uptimeLine(context, "This process has been running for"),
  (context) => uptimeLine(context, "Time since startup"),
  (context) => uptimeLine(context, "Runtime so far"),
  (context) => uptimeLine(context, "Online duration"),
  (context) => uptimeLine(context, "Current session uptime"),
];

const aboutReplies: readonly ReplyFactory[] = [
  (context) =>
    aboutLine(context, "a configurable Discord utility and moderation bot"),
  (context) =>
    aboutLine(context, "a multi-server helper for utilities and moderation"),
  (context) =>
    aboutLine(
      context,
      "a Discord bot with chat, information, and moderation tools",
    ),
  (context) =>
    aboutLine(
      context,
      "a configurable helper built for multiple Discord servers",
    ),
  (context) =>
    aboutLine(context, "a utility bot with server-management features"),
  (context) =>
    aboutLine(context, "a Discord assistant for everyday server tasks"),
  (context) =>
    aboutLine(context, "a multi-server bot for useful commands and moderation"),
  (context) =>
    aboutLine(
      context,
      "a configurable bot for chat utilities and server tools",
    ),
];

const timeReplies: readonly ReplyFactory[] = [
  (context) => timeLine(context, "The configured server time is"),
  (context) => timeLine(context, "It is currently"),
  (context) => timeLine(context, "Current server time"),
  (context) =>
    timeLine(context, "The time in this server’s configured zone is"),
  (context) => timeLine(context, "Right now it is"),
  (context) => timeLine(context, "Configured local time"),
  (context) => timeLine(context, "The server clock reads"),
  (context) => timeLine(context, "Time check"),
];

export const SIMPLE_REPLY_CATALOG = {
  greeting: greetingReplies,
  wellbeing: wellbeingReplies,
  activity: activityReplies,
  help: helpReplies,
  thanks: thanksReplies,
  farewell: farewellReplies,
  ping: pingReplies,
  uptime: uptimeReplies,
  about: aboutReplies,
  time: timeReplies,
} as const satisfies Record<
  SimpleConversationIntentType,
  readonly ReplyFactory[]
>;

const lastReplyIndex = new Map<string, number>();
const MAX_REPLY_HISTORY_ENTRIES = 10_000;

export function buildConversationReply(
  intent: ConversationIntent,
  context: ConversationReplyContext,
): string {
  switch (intent.type) {
    case "greeting":
    case "wellbeing":
    case "activity":
    case "help":
    case "thanks":
    case "farewell":
    case "ping":
    case "uptime":
    case "about":
    case "time":
      return selectSimpleReply(intent.type, context);
    case "coinflip":
      return safeRandomIndex(context.randomInt, 2) === 0
        ? "Coin result: **heads**."
        : "Coin result: **tails**.";
    case "dice": {
      const rolls = Array.from(
        { length: intent.count },
        () => safeRandomIndex(context.randomInt, intent.sides) + 1,
      );
      const total = rolls.reduce((sum, roll) => sum + roll, 0);
      return intent.count === 1
        ? `Rolled **d${intent.sides}**: **${total}**.`
        : `Rolled **${intent.count}d${intent.sides}**: ${rolls.join(" + ")} = **${total}**.`;
    }
    case "choice": {
      const selected =
        intent.options[
          safeRandomIndex(context.randomInt, intent.options.length)
        ];
      return selected
        ? `I choose **${escapeUserText(selected)}**.`
        : choiceHelp(context);
    }
    case "invalid":
      return validationReply(intent, context);
  }
}

export function clearReplySelectionHistory(guildId?: string): void {
  if (guildId === undefined) {
    lastReplyIndex.clear();
    return;
  }
  const prefix = `${guildId}:`;
  for (const key of lastReplyIndex.keys()) {
    if (key.startsWith(prefix)) {
      lastReplyIndex.delete(key);
    }
  }
}

export function escapeUserText(value: string): string {
  return value
    .replace(/@(everyone|here)/gi, "@\u200B$1")
    .replace(/<@([!&]?\d{1,20})>/g, "<@\u200B$1>")
    .replaceAll("\\", "\\\\")
    .replace(/([`*_~|>\[\]()])/g, "\\$1");
}

function selectSimpleReply(
  type: SimpleConversationIntentType,
  context: ConversationReplyContext,
): string {
  const pool = SIMPLE_REPLY_CATALOG[type];
  const key = `${context.guildId}:${type}`;
  let selectedIndex = safeRandomIndex(context.randomInt, pool.length);
  if (pool.length > 1 && lastReplyIndex.get(key) === selectedIndex) {
    selectedIndex = (selectedIndex + 1) % pool.length;
  }
  rememberReplyIndex(key, selectedIndex);
  const factory = pool[selectedIndex] ?? pool[0];
  return factory ? factory(context) : "I’m here and ready to help.";
}

function rememberReplyIndex(key: string, index: number): void {
  if (
    !lastReplyIndex.has(key) &&
    lastReplyIndex.size >= MAX_REPLY_HISTORY_ENTRIES
  ) {
    const oldestKey = lastReplyIndex.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      lastReplyIndex.delete(oldestKey);
    }
  }
  // Refresh insertion order so the bounded map acts as a small LRU cache.
  lastReplyIndex.delete(key);
  lastReplyIndex.set(key, index);
}

function safeRandomIndex(
  randomInt: (maxExclusive: number) => number,
  maxExclusive: number,
): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 1) {
    return 0;
  }
  const candidate = randomInt(maxExclusive);
  if (!Number.isFinite(candidate)) {
    return 0;
  }
  const integer = Math.trunc(candidate);
  return ((integer % maxExclusive) + maxExclusive) % maxExclusive;
}

function pingLine(context: ConversationReplyContext, prefix: string): string {
  const ping = context.gatewayPingMs;
  if (ping === null || !Number.isFinite(ping) || ping < 0) {
    return `${prefix} is not available yet.`;
  }
  return `${prefix}: \`${Math.round(ping)} ms\`.`;
}

function uptimeLine(context: ConversationReplyContext, prefix: string): string {
  const uptime = context.uptimeMs;
  if (uptime === null || !Number.isFinite(uptime) || uptime < 0) {
    return "Uptime is not available yet.";
  }
  return `${prefix}: \`${formatUptime(uptime)}\`.`;
}

function aboutLine(
  context: ConversationReplyContext,
  description: string,
): string {
  return `Superior \`v${inline(context.botVersion)}\` is ${description}. Say \`${inline(context.invocation)} help\` for examples.`;
}

function timeLine(context: ConversationReplyContext, prefix: string): string {
  return `${prefix}: \`${inline(context.currentTime)}\` (\`${inline(context.timezone)}\`).`;
}

function validationReply(
  intent: Extract<ConversationIntent, { type: "invalid" }>,
  context: ConversationReplyContext,
): string {
  switch (intent.error) {
    case "dice_format":
      return `Use dice notation such as \`${inline(context.invocation)} roll 2d6\`.`;
    case "dice_count":
      return "Roll between 1 and 20 dice at a time.";
    case "dice_sides":
      return "Dice must have between 2 and 1,000 sides.";
    case "choice_count":
      return choiceHelp(context);
    case "choice_length":
      return "Keep each choice to 100 characters or fewer.";
  }
}

function choiceHelp(context: ConversationReplyContext): string {
  return `Give me between 2 and 20 choices, such as \`${inline(context.invocation)} choose tea or coffee\`.`;
}

function inline(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "ˋ")
    .replace(/@(everyone|here)/gi, "@\u200B$1")
    .replace(/<@([!&]?\d{1,20})>/g, "<@\u200B$1>");
}

function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    days > 0 ? `${days}d` : null,
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    seconds > 0 || totalSeconds === 0 ? `${seconds}s` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}
