import { DateTime, Duration } from "luxon";
import {
  EMPEROR_LOCK_PHRASES,
  HISTORY_LIMIT,
  IMPERIAL_OMENS,
  IMPERIAL_TITLES,
  IMPERIAL_VERDICTS,
  MSG_EVERYONE_MENTION,
  REPLY_MUTE_ACTION_PATTERN,
  REPLY_MUTE_INTENT_PATTERN,
  ROLE_PANEL_BUTTON_CUSTOM_ID,
  ROLE_PANEL_MAX_BUTTONS,
  ROLE_PANEL_TARGETS_FOOTER_PREFIX,
  ROYAL_TITLES,
  SILENCE_LOCK_PHRASES,
  THREAD_CLOSE_HOURS,
} from "./constants.js";
import { formatDuration, parseIso } from "./time.js";
import type {
  BackfillStatusSnapshot,
  CourtState,
  MetricsShape,
  PostRecord,
  RoyalAfkShape,
  RoyalPresenceShape,
  RoyalTitle,
} from "./types.js";

const ROLE_PANEL_ROLE_ID_PATTERN = /^RolePanelTarget:(\d+)$/;
const ROLE_PANEL_ROLE_CUSTOM_ID_PREFIX = `${ROLE_PANEL_BUTTON_CUSTOM_ID}:role:`;
export const IMPORT_STATE_DATE_KEYS = [
  "last_posted_date",
  "last_dry_run_date",
  "last_weekly_digest_week",
] as const;

export const DEFAULT_BACKFILL_STATUS: BackfillStatusSnapshot = {
  running: false,
  started_at: null,
  lookback_days: null,
  initiated_by_user_id: null,
  last_started_at: null,
  last_completed_at: null,
  last_status: "never",
  last_summary: null,
  last_error: null,
};

export function coerceInt(
  value: unknown,
  defaultValue = 0,
  minimum?: number,
  maximum?: number,
): number {
  const raw = Number.parseInt(String(value), 10);
  let parsed = Number.isNaN(raw) ? defaultValue : raw;

  if (minimum !== undefined) {
    parsed = Math.max(parsed, minimum);
  }
  if (maximum !== undefined) {
    parsed = Math.min(parsed, maximum);
  }

  return parsed;
}

function toOptionalScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return null;
}

function toStringOrFallback(value: unknown, fallback = ""): string {
  return toOptionalScalarString(value) ?? fallback;
}

export function normalizeQuestionText(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").trim();
}

export function ensureMetricsShape(metrics: unknown): MetricsShape {
  const shaped =
    typeof metrics === "object" && metrics !== null
      ? { ...(metrics as Record<string, unknown>) }
      : {};

  const commandUsageRaw = shaped.command_usage;
  const commandFailuresRaw = shaped.command_failures;
  const postsByCategoryRaw = shaped.posts_by_category;
  const lastSuccessfulAutoPost = toOptionalScalarString(
    shaped.last_successful_auto_post,
  );

  return {
    command_usage:
      typeof commandUsageRaw === "object" && commandUsageRaw !== null
        ? coerceNumberRecord(commandUsageRaw as Record<string, unknown>)
        : {},
    command_failures:
      typeof commandFailuresRaw === "object" && commandFailuresRaw !== null
        ? coerceNumberRecord(commandFailuresRaw as Record<string, unknown>)
        : {},
    posts_by_category:
      typeof postsByCategoryRaw === "object" && postsByCategoryRaw !== null
        ? coerceNumberRecord(postsByCategoryRaw as Record<string, unknown>)
        : {},
    posts_total: coerceInt(shaped.posts_total, 0, 0),
    posts_auto: coerceInt(shaped.posts_auto, 0, 0),
    posts_manual: coerceInt(shaped.posts_manual, 0, 0),
    custom_posts: coerceInt(shaped.custom_posts, 0, 0),
    answers_total: coerceInt(shaped.answers_total, 0, 0),
    last_successful_auto_post:
      lastSuccessfulAutoPost && lastSuccessfulAutoPost.length > 0
        ? lastSuccessfulAutoPost
        : null,
  };
}

function coerceNumberRecord(
  record: Record<string, unknown>,
): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const cleanKey = key.trim();
    if (!cleanKey) {
      continue;
    }
    output[cleanKey] = coerceInt(value, 0, 0);
  }
  return output;
}

export function flattenMetricsForStorage(
  metrics: unknown,
): Record<string, string> {
  const shaped = ensureMetricsShape(metrics);

  const flattened: Record<string, string> = {
    posts_total: String(coerceInt(shaped.posts_total, 0, 0)),
    posts_auto: String(coerceInt(shaped.posts_auto, 0, 0)),
    posts_manual: String(coerceInt(shaped.posts_manual, 0, 0)),
    custom_posts: String(coerceInt(shaped.custom_posts, 0, 0)),
    answers_total: String(coerceInt(shaped.answers_total, 0, 0)),
    last_successful_auto_post: shaped.last_successful_auto_post ?? "",
  };

  for (const [commandName, count] of Object.entries(shaped.command_usage)) {
    const key = commandName.trim();
    if (!key) {
      continue;
    }
    flattened[`command_usage.${key}`] = String(coerceInt(count, 0, 0));
  }

  for (const [commandName, count] of Object.entries(shaped.command_failures)) {
    const key = commandName.trim();
    if (!key) {
      continue;
    }
    flattened[`command_failures.${key}`] = String(coerceInt(count, 0, 0));
  }

  for (const [category, count] of Object.entries(shaped.posts_by_category)) {
    const key = category.trim();
    if (!key) {
      continue;
    }
    flattened[`posts_by_category.${key}`] = String(coerceInt(count, 0, 0));
  }

  return flattened;
}

export function ensureRoyalPresenceShape(
  royalPresence: unknown,
): RoyalPresenceShape {
  const shaped =
    typeof royalPresence === "object" && royalPresence !== null
      ? { ...(royalPresence as Record<string, unknown>) }
      : {};

  const byTitleRaw =
    typeof shaped.last_message_at_by_title === "object" &&
    shaped.last_message_at_by_title !== null
      ? { ...(shaped.last_message_at_by_title as Record<string, unknown>) }
      : {};

  const byTitle: Record<RoyalTitle, string | null> = {
    Emperor: null,
    Empress: null,
  };

  for (const title of ROYAL_TITLES) {
    const value = byTitleRaw[title];
    byTitle[title] = toOptionalScalarString(value);
  }

  const legacyLastSpeaker = shaped.last_speaker;
  const legacyLastMessageAt = shaped.last_message_at;
  if (
    (legacyLastSpeaker === "Emperor" || legacyLastSpeaker === "Empress") &&
    byTitle[legacyLastSpeaker] === null
  ) {
    byTitle[legacyLastSpeaker] = toOptionalScalarString(legacyLastMessageAt);
  }

  return {
    last_message_at_by_title: byTitle,
    last_message_at: toOptionalScalarString(legacyLastMessageAt),
    last_speaker:
      legacyLastSpeaker === "Emperor" || legacyLastSpeaker === "Empress"
        ? legacyLastSpeaker
        : null,
  };
}

export function ensureRoyalAfkShape(royalAfk: unknown): RoyalAfkShape {
  const shaped =
    typeof royalAfk === "object" && royalAfk !== null
      ? { ...(royalAfk as Record<string, unknown>) }
      : {};
  const byTitleRaw =
    typeof shaped.by_title === "object" && shaped.by_title !== null
      ? shaped.by_title
      : {};

  const byTitle: RoyalAfkShape["by_title"] = {
    Emperor: { active: false, reason: "", set_at: null, set_by_user_id: null },
    Empress: { active: false, reason: "", set_at: null, set_by_user_id: null },
  };

  for (const title of ROYAL_TITLES) {
    const entryRaw =
      typeof (byTitleRaw as Record<string, unknown>)[title] === "object" &&
      (byTitleRaw as Record<string, unknown>)[title] !== null
        ? ((byTitleRaw as Record<string, unknown>)[title] as Record<
            string,
            unknown
          >)
        : {};

    byTitle[title] = {
      active: Boolean(entryRaw.active ?? false),
      reason: toStringOrFallback(entryRaw.reason, ""),
      set_at: toOptionalScalarString(entryRaw.set_at),
      set_by_user_id: toOptionalScalarString(entryRaw.set_by_user_id),
    };
  }

  return { by_title: byTitle };
}

export function parseRolePanelTargetsFromFooter(
  footerText: string,
): Record<number, string> {
  const cleaned = footerText.trim();
  const singleMatch = ROLE_PANEL_ROLE_ID_PATTERN.exec(cleaned);
  if (singleMatch?.[1]) {
    return { 1: singleMatch[1] };
  }

  if (!cleaned.startsWith(ROLE_PANEL_TARGETS_FOOTER_PREFIX)) {
    return {};
  }

  const payload = cleaned.slice(ROLE_PANEL_TARGETS_FOOTER_PREFIX.length).trim();
  if (!payload) {
    return {};
  }

  const targets: Record<number, string> = {};
  for (const entry of payload.split(",")) {
    const segment = entry.trim();
    if (!segment.includes("=")) {
      continue;
    }

    const [slotRaw, roleIdRaw] = segment
      .split("=", 2)
      .map((item) => item.trim());
    if (
      !slotRaw ||
      !roleIdRaw ||
      !/^\d+$/.test(slotRaw) ||
      !/^\d+$/.test(roleIdRaw)
    ) {
      continue;
    }

    const slot = Number.parseInt(slotRaw, 10);
    if (slot >= 1 && slot <= ROLE_PANEL_MAX_BUTTONS && !(slot in targets)) {
      targets[slot] = roleIdRaw;
    }
  }

  return targets;
}

export function extractRolePanelRoleIdForSlot(
  footerTexts: string[],
  slot: number,
): string | null {
  if (slot < 1 || slot > ROLE_PANEL_MAX_BUTTONS) {
    return null;
  }

  for (const footerText of footerTexts) {
    const targets = parseRolePanelTargetsFromFooter(String(footerText));
    if (slot in targets) {
      return targets[slot] ?? null;
    }
  }

  return null;
}

export function extractRolePanelRoleId(footerTexts: string[]): string | null {
  return extractRolePanelRoleIdForSlot(footerTexts, 1);
}

export function buildRolePanelButtonCustomId(roleId: string | number): string {
  const roleIdText = String(roleId).trim();
  if (!/^\d+$/.test(roleIdText)) {
    return ROLE_PANEL_BUTTON_CUSTOM_ID;
  }

  return `${ROLE_PANEL_ROLE_CUSTOM_ID_PREFIX}${roleIdText}`;
}

export function extractRolePanelRoleIdFromCustomId(
  customId: string | null | undefined,
): string | null {
  if (!customId?.startsWith(ROLE_PANEL_ROLE_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const roleId = customId.slice(ROLE_PANEL_ROLE_CUSTOM_ID_PREFIX.length).trim();
  if (!/^\d+$/.test(roleId)) {
    return null;
  }

  return roleId;
}

export function extractRolePanelButtonSlot(
  customId: string | null | undefined,
): number | null {
  if (!customId) {
    return null;
  }

  if (customId === ROLE_PANEL_BUTTON_CUSTOM_ID) {
    return 1;
  }

  const prefix = `${ROLE_PANEL_BUTTON_CUSTOM_ID}:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }

  const slotValue = customId.slice(prefix.length);
  if (!/^\d+$/.test(slotValue)) {
    return null;
  }

  const slot = Number.parseInt(slotValue, 10);
  if (slot >= 1 && slot <= ROLE_PANEL_MAX_BUTTONS) {
    return slot;
  }

  return null;
}

export function normalizeTriggerPhrase(content: string): string {
  const cleaned = content.toLowerCase().replaceAll(/[^a-z0-9'\s]/g, " ");
  return cleaned.split(/\s+/).filter(Boolean).join(" ");
}

export function parseReplyMuteMessage(
  content: string,
  invocationTerms: readonly string[] = ["invictus"],
): string | null {
  const invocationPattern = buildInvocationPattern(invocationTerms);
  if (!invocationPattern) {
    return null;
  }
  const patterns = [
    new RegExp(
      String.raw`^\s*(?:hey|yo|oi)[\s,]+(?:${invocationPattern})[\s,:-]+${REPLY_MUTE_ACTION_PATTERN}\b(.*)$`,
      "i",
    ),
    new RegExp(
      String.raw`^\s*(?:${invocationPattern})[\s,:-]+${REPLY_MUTE_ACTION_PATTERN}\b(.*)$`,
      "i",
    ),
    new RegExp(
      String.raw`^\s*(?:hey|yo|oi)[\s,]+(?:${invocationPattern})[\s,:-]+${REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$`,
      "i",
    ),
    new RegExp(
      String.raw`^\s*(?:${invocationPattern})[\s,:-]+${REPLY_MUTE_INTENT_PATTERN}\b(?:[\s,:-]*(.*))$`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match) {
      const reason = match[1] ?? "";
      return reason.trim();
    }
  }

  return null;
}

export type PrivilegedInvictusChatIntent =
  | "greeting"
  | "status"
  | "counsel"
  | "help"
  | "title"
  | "coinflip"
  | "time"
  | "thanks"
  | "farewell";

export const PUBLIC_INVICTUS_CHAT_INTENTS =
  new Set<PrivilegedInvictusChatIntent>([
    "greeting",
    "help",
    "coinflip",
    "time",
    "thanks",
    "farewell",
  ]);

export function isPublicInvictusChatIntent(
  intent: PrivilegedInvictusChatIntent,
): boolean {
  return PUBLIC_INVICTUS_CHAT_INTENTS.has(intent);
}

export function parsePrivilegedInvictusChatIntent(
  content: string,
  invocationTerms: readonly string[] = ["invictus"],
): PrivilegedInvictusChatIntent | null {
  const normalized = normalizeTriggerPhrase(content);
  if (!containsInvocation(normalized, invocationTerms)) {
    return null;
  }

  if (/\b(thanks|thank you|ty)\b/.test(normalized)) {
    return "thanks";
  }

  if (/\b(goodnight|good night|sleep well)\b/.test(normalized)) {
    return "farewell";
  }

  if (/\b(help|commands|options|what can you do)\b/.test(normalized)) {
    return "help";
  }

  if (
    /\b(title me|give me a title|grant me a title|bestow a title|bestow title)\b/.test(
      normalized,
    )
  ) {
    return "title";
  }

  if (/\b(flip a coin|flip coin|coin flip|heads or tails)\b/.test(normalized)) {
    return "coinflip";
  }

  if (/\b(what time is it|time now|current time)\b/.test(normalized)) {
    return "time";
  }

  if (/\b(status report|status)\b/.test(normalized)) {
    return "status";
  }

  if (
    /\b(advice|omen|prophecy|what should i do|what do you think)\b/.test(
      normalized,
    )
  ) {
    return "counsel";
  }

  if (
    /\b(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)\b/.test(
      normalized,
    )
  ) {
    return "greeting";
  }

  return null;
}

export function isSilenceLockTrigger(content: string): boolean {
  return SILENCE_LOCK_PHRASES.has(normalizeTriggerPhrase(content));
}

export function isEmperorLockTrigger(
  content: string,
  emperorLabel = "Emperor",
): boolean {
  const normalized = normalizeTriggerPhrase(content);
  const normalizedLabel = normalizeTriggerPhrase(emperorLabel);
  if (EMPEROR_LOCK_PHRASES.has(normalized)) {
    return true;
  }
  if (!normalizedLabel || normalizedLabel === "emperor") {
    return false;
  }
  return Array.from(EMPEROR_LOCK_PHRASES).some(
    (phrase) => phrase.replaceAll("emperor", normalizedLabel) === normalized,
  );
}

export function hasEmperorMention(content: string, label = "Emperor"): boolean {
  return containsInvocation(normalizeTriggerPhrase(content), [
    label,
    "his majesty",
  ]);
}

export function hasEmpressMention(content: string, label = "Empress"): boolean {
  return containsInvocation(normalizeTriggerPhrase(content), [
    label,
    "her majesty",
  ]);
}

export function parseRoyalMentions(
  content: string,
  labels: { emperor: string; empress: string } = {
    emperor: "Emperor",
    empress: "Empress",
  },
): RoyalTitle[] {
  const mentioned: RoyalTitle[] = [];
  if (hasEmperorMention(content, labels.emperor)) {
    mentioned.push("Emperor");
  }
  if (hasEmpressMention(content, labels.empress)) {
    mentioned.push("Empress");
  }
  return mentioned;
}

function buildInvocationPattern(invocationTerms: readonly string[]): string {
  return literalInvocationTerms(invocationTerms)
    .map((term) => escapeRegExp(term).replaceAll(/\s+/g, String.raw`\s+`))
    .join("|");
}

function containsInvocation(
  normalizedContent: string,
  invocationTerms: readonly string[],
): boolean {
  for (const term of normalizedInvocationTerms(invocationTerms)) {
    if (
      normalizedContent === term ||
      normalizedContent.startsWith(`${term} `) ||
      normalizedContent.endsWith(` ${term}`) ||
      normalizedContent.includes(` ${term} `)
    ) {
      return true;
    }
  }
  return false;
}

function normalizedInvocationTerms(
  invocationTerms: readonly string[],
): string[] {
  return Array.from(
    new Set(
      invocationTerms
        .map(normalizeTriggerPhrase)
        .filter((term) => term.length > 0),
    ),
  ).sort((left, right) => right.length - left.length);
}

function literalInvocationTerms(invocationTerms: readonly string[]): string[] {
  return Array.from(
    new Set(
      invocationTerms
        .map((term) => term.trim().toLowerCase().replaceAll(/\s+/g, " "))
        .filter((term) => term.length > 0),
    ),
  ).sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MentionedMemberLike {
  roles?: Array<{ id: string } | string>;
}

export function parseRoyalMemberMentions(
  mentionedMembers: MentionedMemberLike[] | null | undefined,
  emperorRoleId: string,
  empressRoleId: string,
): RoyalTitle[] {
  if (!mentionedMembers || mentionedMembers.length === 0) {
    return [];
  }

  const mentionedTitles: RoyalTitle[] = [];
  for (const member of mentionedMembers) {
    const roleIds = new Set(
      (member.roles ?? []).map((role) => {
        if (typeof role === "string") {
          return role;
        }
        return role.id;
      }),
    );

    if (roleIds.has(emperorRoleId) && !mentionedTitles.includes("Emperor")) {
      mentionedTitles.push("Emperor");
    }

    if (roleIds.has(empressRoleId) && !mentionedTitles.includes("Empress")) {
      mentionedTitles.push("Empress");
    }
  }

  return mentionedTitles;
}

export function getFateReading(roll: number): [string, string] {
  const normalizedRoll = Math.max(1, Math.min(100, Math.trunc(roll)));

  if (normalizedRoll <= 10) {
    return [
      "Dire Omen",
      "Storm clouds gather. Move carefully and trust fewer people.",
    ];
  }
  if (normalizedRoll <= 30) {
    return ["Trial Ahead", "A test is coming. Discipline beats luck today."];
  }
  if (normalizedRoll <= 70) {
    return [
      "Balanced Winds",
      "No doom, no blessing. Your choices decide the outcome.",
    ];
  }
  if (normalizedRoll <= 90) {
    return [
      "Favorable Tide",
      "Momentum is with you. Strike while your name carries weight.",
    ];
  }

  return [
    "Imperial Blessing",
    "The throne smiles. Ask for more than you think you deserve.",
  ];
}

export function countOpenAndOverduePosts(
  posts: PostRecord[],
  now: DateTime,
): [number, number] {
  const openPosts = posts.filter((post) => !post.closed);
  let overduePosts = 0;

  for (const post of openPosts) {
    const postedAt = parseIso(post.posted_at);
    const closeAfterHours = coerceInt(
      post.close_after_hours,
      THREAD_CLOSE_HOURS,
      1,
    );
    if (!postedAt) {
      continue;
    }

    if (now.diff(postedAt).as("hours") >= closeAfterHours) {
      overduePosts += 1;
    }
  }

  return [openPosts.length, overduePosts];
}

export function getPostCloseDeadline(
  record: Pick<PostRecord, "posted_at" | "close_after_hours">,
): DateTime | null {
  const postedAt = parseIso(record.posted_at);
  if (!postedAt) {
    return null;
  }
  return postedAt.plus({
    hours: coerceInt(record.close_after_hours, THREAD_CLOSE_HOURS, 1),
  });
}

export function shouldAnnounceRoyalPresence(
  previousMessageAt: DateTime | null,
  currentMessageAt: DateTime,
): boolean {
  if (!previousMessageAt) {
    return true;
  }
  return currentMessageAt.diff(previousMessageAt).as("hours") >= 3;
}

export function parseBoolish(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function sanitizeImportedHistory(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-HISTORY_LIMIT);
}

export function sanitizeImportedUsedQuestions(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const cleanItem = item.trim();
    if (!cleanItem || seen.has(cleanItem)) {
      continue;
    }

    seen.add(cleanItem);
    deduped.push(cleanItem);
  }

  return deduped;
}

export function sanitizeImportedPosts(value: unknown): PostRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((post): post is PostRecord => {
    if (typeof post !== "object" || post === null) {
      return false;
    }

    const maybePost = post as Partial<PostRecord>;
    return (
      /^\d+$/.test(String(maybePost.message_id ?? "")) &&
      /^\d+$/.test(String(maybePost.channel_id ?? ""))
    );
  });
}

function createImportedStateBase(base: CourtState): CourtState {
  return {
    ...base,
    history: [...base.history],
    used_questions: [...base.used_questions],
    posts: [...base.posts],
    metrics: ensureMetricsShape(base.metrics),
    royal_presence: ensureRoyalPresenceShape(base.royal_presence),
    royal_afk: ensureRoyalAfkShape(base.royal_afk),
  };
}

function applyImportedDateKeys(
  merged: CourtState,
  importedObj: Record<string, unknown>,
): void {
  for (const key of IMPORT_STATE_DATE_KEYS) {
    if (!(key in importedObj)) {
      continue;
    }
    const value = importedObj[key];
    if (value === null || typeof value === "string") {
      merged[key] = value;
    }
  }
}

function applyImportedCollections(
  merged: CourtState,
  importedObj: Record<string, unknown>,
): void {
  const history = sanitizeImportedHistory(importedObj.history);
  if (history !== null) {
    merged.history = history;
  }

  const usedQuestions = sanitizeImportedUsedQuestions(
    importedObj.used_questions,
  );
  if (usedQuestions !== null) {
    merged.used_questions = usedQuestions;
  }

  const posts = sanitizeImportedPosts(importedObj.posts);
  if (posts !== null) {
    merged.posts = posts;
  }
}

function applyImportedStructuredShapes(
  merged: CourtState,
  importedObj: Record<string, unknown>,
): void {
  if (typeof importedObj.metrics === "object" && importedObj.metrics !== null) {
    merged.metrics = ensureMetricsShape(importedObj.metrics);
  }

  if (
    typeof importedObj.royal_presence === "object" &&
    importedObj.royal_presence !== null
  ) {
    merged.royal_presence = ensureRoyalPresenceShape(
      importedObj.royal_presence,
    );
  }

  if (
    typeof importedObj.royal_afk === "object" &&
    importedObj.royal_afk !== null
  ) {
    merged.royal_afk = ensureRoyalAfkShape(importedObj.royal_afk);
  }
}

export function mergeImportedState(
  imported: unknown,
  base: CourtState,
  _legacyDefaultCourtChannelId = 0,
): CourtState {
  if (typeof imported !== "object" || imported === null) {
    return base;
  }

  const importedObj = imported as Record<string, unknown>;
  const merged = createImportedStateBase(base);

  applyImportedDateKeys(merged, importedObj);

  applyImportedCollections(merged, importedObj);
  applyImportedStructuredShapes(merged, importedObj);

  return merged;
}

export function backfillLookbackText(lookbackDays: number | null): string {
  if (lookbackDays === null || lookbackDays <= 0) {
    return "all available history";
  }
  return `last ${lookbackDays} day(s)`;
}

export function getBackfillStatusSnapshot(
  state: BackfillStatusSnapshot,
): BackfillStatusSnapshot {
  return { ...state };
}

export function markBackfillStarted(
  state: BackfillStatusSnapshot,
  initiatedByUserId: number | string,
  lookbackDays: number,
  nowIso: string,
): void {
  state.running = true;
  state.started_at = nowIso;
  state.lookback_days = Math.trunc(lookbackDays);
  state.initiated_by_user_id = String(initiatedByUserId);
  state.last_started_at = nowIso;
  state.last_status = "running";
  state.last_summary = null;
  state.last_error = null;
}

export function markBackfillFinished(
  state: BackfillStatusSnapshot,
  status: string,
  nowIso: string,
  summary: string | null = null,
  error: string | null = null,
): void {
  state.running = false;
  state.started_at = null;
  state.last_completed_at = nowIso;
  state.last_status = status;
  state.last_summary = summary;
  state.last_error = error;
}

export function buildAnnouncementMentions(mentionEveryone: boolean): {
  content: string | null;
  allowedMentions: { parse: Array<"everyone" | "users" | "roles"> };
} {
  if (mentionEveryone) {
    return {
      content: MSG_EVERYONE_MENTION,
      allowedMentions: { parse: ["everyone"] },
    };
  }

  return {
    content: null,
    allowedMentions: { parse: [] },
  };
}

export function buildRoyalAfkStatusLine(
  title: RoyalTitle,
  afkEntry: RoyalAfkShape["by_title"][RoyalTitle],
  now: DateTime,
  displayLabel: string = title,
): string {
  const reason = afkEntry.reason || "Away from court";
  const setAt = parseIso(afkEntry.set_at);
  if (!setAt) {
    return `The ${displayLabel} is currently AFK: ${reason}`;
  }
  return `The ${displayLabel} is currently AFK (${formatDuration(now.diff(setAt))}): ${reason}`;
}

export function getRoyalAfkResponse(
  content: string,
  afkShape: RoyalAfkShape,
  now: DateTime,
  mentionedRoyalTitles: RoyalTitle[] = [],
  labels: { emperor: string; empress: string } = {
    emperor: "Emperor",
    empress: "Empress",
  },
): string | null {
  const mentionedTitles: RoyalTitle[] = [
    ...parseRoyalMentions(content, labels),
  ];
  for (const title of mentionedRoyalTitles) {
    if (!mentionedTitles.includes(title)) {
      mentionedTitles.push(title);
    }
  }

  if (mentionedTitles.length === 0) {
    return null;
  }

  const lines = mentionedTitles
    .map((title) => {
      const entry = afkShape.by_title[title];
      if (!entry.active) {
        return null;
      }
      return buildRoyalAfkStatusLine(
        title,
        entry,
        now,
        title === "Emperor" ? labels.emperor : labels.empress,
      );
    })
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    return null;
  }

  return lines.join("\n");
}

export function buildRoyalAfkStatusReport(
  afkShape: RoyalAfkShape,
  now: DateTime,
  labels: { emperor: string; empress: string } = {
    emperor: "Emperor",
    empress: "Empress",
  },
): string {
  const lines: string[] = [];

  for (const title of ROYAL_TITLES) {
    const entry = afkShape.by_title[title];
    if (!entry.active) {
      continue;
    }

    const reason = entry.reason || "Away from court";
    const displayLabel = title === "Emperor" ? labels.emperor : labels.empress;
    const setAt = parseIso(entry.set_at);
    if (setAt) {
      lines.push(
        `**${displayLabel}:** AFK for ${formatDuration(now.diff(setAt))} - ${reason}`,
      );
    } else {
      lines.push(`**${displayLabel}:** AFK - ${reason}`);
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No royal AFK statuses are enabled.";
}

export function randomImperialVerdict(
  randomInt: (maxExclusive: number) => number,
): string {
  return (
    IMPERIAL_VERDICTS[randomInt(IMPERIAL_VERDICTS.length)] ??
    IMPERIAL_VERDICTS[0]
  );
}

export function randomImperialTitle(
  randomInt: (maxExclusive: number) => number,
): string {
  return (
    IMPERIAL_TITLES[randomInt(IMPERIAL_TITLES.length)] ?? IMPERIAL_TITLES[0]
  );
}

export function randomImperialOmen(
  randomInt: (maxExclusive: number) => number,
): string {
  return IMPERIAL_OMENS[randomInt(IMPERIAL_OMENS.length)] ?? IMPERIAL_OMENS[0];
}

export function formatDurationFromDates(
  start: DateTime,
  end: DateTime,
): string {
  return formatDuration(
    Duration.fromMillis(Math.max(end.diff(start).toMillis(), 0)),
  );
}
