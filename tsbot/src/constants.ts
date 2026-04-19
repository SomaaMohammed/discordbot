import type { RoyalTitle } from "./types.js";

export const PACKAGE_VERSION = "0.1.1";

export const DEFAULT_STAFF_ROLE_IDS = new Set<string>([
  "1461376227095875707",
  "1461386876475932806",
  "1461485629178122465",
  "1461513633367330982",
  "1461513909130498230",
]);

export const DEFAULT_SILENT_LOCK_EXCLUDE_ROLES = new Set<string>([
  "1462082750101328029",
  "1461500213746204921",
  "1461382351874424842",
]);

export const STATE_FILE = "state.json";
export const QUESTIONS_FILE = "questions.json";
export const ANSWERS_FILE = "answers.json";

export const STORAGE_JSON_KEYS: Record<string, string> = {
  [STATE_FILE]: "state",
  [QUESTIONS_FILE]: "questions",
  [ANSWERS_FILE]: "answers",
};

export const ROLE_COLOR = 0x000000;
export const HISTORY_LIMIT = 50;
export const POST_RECORD_LIMIT = 100;
export const THREAD_CLOSE_HOURS = 24;
export const THREAD_AUTO_ARCHIVE_MINUTES = 1440;
export const REPLY_MUTE_MINUTES = 1;
export const ROLE_PANEL_MAX_BUTTONS = 5;
export const ROLE_PANEL_BUTTON_CUSTOM_ID = "court:role_panel_claim";
export const ROLE_PANEL_DEFAULT_BUTTON_LABEL = "Claim Role";
export const ROLE_PANEL_BUTTON_LABEL_MAX_LENGTH = 80;
export const ROLE_PANEL_FOOTER_PREFIX = "RolePanelTarget:";
export const ROLE_PANEL_TARGETS_FOOTER_PREFIX = "RolePanelTargets:";

export const ROYAL_TITLES: RoyalTitle[] = ["Emperor", "Empress"];

export const MSG_EVERYONE_MENTION = "@everyone";

export const REPLY_MUTE_ACTION_PATTERN = "(?:mute|silence|timeout|quiet|hush)";
export const REPLY_MUTE_INTENT_PATTERN =
  String.raw`(?:you\s+know\s+what\s+to\s+do|u\s+know\s+what\s+to\s+do|do\s+your\s+thing|handle\s+this)`;

export const REPLY_MUTE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`^\s*(?:hey|yo|oi)[\s,]+invictus[\s,:-]+${REPLY_MUTE_ACTION_PATTERN}\b(.*)$`, "i"),
  new RegExp(String.raw`^\s*invictus[\s,:-]+${REPLY_MUTE_ACTION_PATTERN}\b(.*)$`, "i"),
  new RegExp(
    String.raw`^\s*(?:hey|yo|oi)[\s,]+invictus[\s,:-]+${REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$`,
    "i",
  ),
  new RegExp(String.raw`^\s*invictus[\s,:-]+${REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$`, "i"),
];

export const SILENCE_LOCK_PHRASES = new Set<string>([
  "silence",
  "silence now",
  "silence the court",
  "court silence",
  "order in the court",
]);

export const EMPEROR_LOCK_PHRASES = new Set<string>([
  "the emperor is here",
  "emperor is here",
  "the emperor has arrived",
  "emperor has arrived",
  "make way for the emperor",
  "all rise for the emperor",
]);

export const EMPEROR_MENTION_PATTERN = /\b(sammy|emperor|his majesty|your majesty)\b/i;
export const EMPRESS_MENTION_PATTERN = /\b(empress|her majesty|tay|taytay|taylor|tayla)\b/i;
export const URL_PATTERN = /https?:\/\/|discord\.gg\//i;

export const USER_METRIC_PREFIX = "user_stats.";

export const USER_FUN_METRIC_FIELDS: Array<[string, string]> = [
  ["messages_sent", "Messages Sent"],
  ["reactions_sent", "Reactions Sent"],
  ["reactions_received", "Reactions Received"],
  ["anonymous_answers_sent", "Anonymous Answers"],
  ["battles_played", "Battles Played"],
  ["battles_won", "Battles Won"],
];

export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  general: "Broad prompts for everyday discussion.",
  gaming: "Games, consoles, mechanics, franchises, and hot gaming opinions.",
  music: "Songs, artists, albums, genres, and music takes.",
  "hot-take": "Controversial opinions and spicy takes.",
  chaos: "Funny, dumb, cursed, and unhinged prompts.",
};

export const IMPERIAL_VERDICTS = [
  "Approved. The throne nods in your favor.",
  "Denied. The court demands stronger resolve.",
  "Delayed. Return once your allies are prepared.",
  "Conditionally approved. Pay your debts before dawn.",
  "Accepted. Proceed, but carry steel and patience.",
  "Rejected. Fate advises a different road.",
] as const;

export const IMPERIAL_TITLES = [
  "Warden of the Iron Gate",
  "Keeper of Midnight Oaths",
  "High Marshal of Courtly Chaos",
  "Bearer of the Black Standard",
  "Chancellor of Loud Opinions",
  "Sovereign of Unhinged Takes",
  "Archivist of Forbidden Memes",
  "Champion of the Inner Court",
] as const;

export const IMPERIAL_OMENS = [
  "A quiet hallway means someone already heard your plan.",
  "Steel sings only for those who laugh first.",
  "When candles bend, old rivals wake.",
  "The loudest boast usually hides the weakest shield.",
  "Tonight favors bold words and careful exits.",
  "A sealed letter is worth more than ten promises.",
] as const;

export const RIO_USER_ID = "1206572825100685365";
export const TAYLOR_USER_ID = "661069422869610537";
