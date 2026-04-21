import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Channel,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type Role,
  type User,
} from "discord.js";
import { DateTime } from "luxon";
import {
  POST_RECORD_LIMIT,
  REPLY_MUTE_MINUTES,
  ROLE_COLOR,
  THREAD_CLOSE_HOURS,
} from "../constants.js";
import {
  buildAnnouncementMentions,
  getPostCloseDeadline,
  randomImperialOmen,
  randomImperialTitle,
  randomImperialVerdict,
  getRoyalAfkResponse,
  isPublicInvictusChatIntent,
  isEmperorLockTrigger,
  isSilenceLockTrigger,
  parsePrivilegedInvictusChatIntent,
  parseReplyMuteMessage,
  shouldAnnounceRoyalPresence,
} from "../parity.js";
import { logError } from "../logging.js";
import { getWeekKey, isoNow } from "../time.js";
import type { BotRuntime } from "../runtime.js";
import type { CourtState, PostRecord, RoyalTitle } from "../types.js";

const ANON_ANSWER_BUTTON_ID = "court:anonymous_answer";
const SILENT_LOCK_SECONDS = 120;
const SILENCE_LOCK_CITIZEN_ROLE_ID = "1461386876475932806";
type RuntimeTargetChannel = TextChannel | NewsChannel | AnyThreadChannel;

let backgroundLoopsStarted = false;

export function wireRuntimeParity(client: Client, runtime: BotRuntime): void {
  client.on("messageCreate", async (message) => {
    await handleMessageCreate(message, runtime);
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    await handleReactionAdd(reaction, user, runtime);
  });

  client.once("ready", () => {
    if (!backgroundLoopsStarted) {
      backgroundLoopsStarted = true;
      startBackgroundLoops(client, runtime);
    }
  });
}

async function handleMessageCreate(
  message: Message,
  runtime: BotRuntime,
): Promise<void> {
  if (message.author.bot || !message.guild) {
    return;
  }

  const member = await resolveMessageMember(message);
  if (!member) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(member.id, "messages_sent"),
  );

  const clearedTitles = clearMemberRoyalAfk(member, runtime);
  if (clearedTitles.length > 0) {
    await sendRuntimeLog(
      message.guild,
      runtime,
      "Royal AFK Auto-Cleared",
      `**By:** ${member.toString()}\n**Titles:** \`${clearedTitles.join(", ")}\`\n**Trigger:** Message activity in ${message.channel.toString()}`,
      String(message.channel.id),
    );
  }

  const inRoyalAlertChannel = isRoyalAlertChannel(
    String(message.channel.id),
    runtime,
  );
  if (inRoyalAlertChannel) {
    await handleRoyalPresenceAnnouncement(message, member, runtime);
  }

  if (
    isSilenceLockTrigger(message.content) ||
    isEmperorLockTrigger(message.content)
  ) {
    if (!getMemberRoyalTitles(member, runtime).includes("Emperor")) {
      return;
    }

    if (message.channel instanceof TextChannel) {
      await lockChannelSilently(
        message.channel,
        member,
        runtime,
        SILENT_LOCK_SECONDS,
      );
    }
    return;
  }

  if (
    await maybeSendRoyalMentionResponse(message, runtime, inRoyalAlertChannel)
  ) {
    return;
  }

  if (await maybeSendPrivilegedInvictusChatResponse(message, member, runtime)) {
    return;
  }

  const reasonText = parseReplyMuteMessage(message.content);
  if (reasonText === null) {
    return;
  }

  if (!isAdmin(member)) {
    return;
  }

  await handleReplyMuteTrigger(message, member, reasonText, runtime);
}

async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  runtime: BotRuntime,
): Promise<void> {
  if (user.bot) {
    return;
  }

  const message = reaction.message.partial
    ? await reaction.message.fetch().catch(() => null)
    : reaction.message;
  if (!message?.guild) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(user.id, "reactions_sent"),
  );

  const author = message.author;
  if (!author || author.bot) {
    return;
  }

  runtime.storage.metricsIncrement(
    runtime.storage.buildUserMetricKey(author.id, "reactions_received"),
  );
}

function startBackgroundLoops(client: Client, runtime: BotRuntime): void {
  const run = (name: string, task: () => Promise<void>): void => {
    void task().catch((error) => {
      logError("runtime-loop", "Background task failed", {
        task: name,
        error,
      });
    });
  };

  run("auto_poster", () => runAutoPoster(client, runtime));
  run("thread_closer", () => runThreadCloser(client, runtime));
  run("weekly_digest", () => runWeeklyDigest(client, runtime));
  run("retention_cleaner", () => runRetentionCleaner(client, runtime));

  setInterval(
    () => run("auto_poster", () => runAutoPoster(client, runtime)),
    60_000,
  );
  setInterval(
    () => run("thread_closer", () => runThreadCloser(client, runtime)),
    10 * 60_000,
  );
  setInterval(
    () => run("weekly_digest", () => runWeeklyDigest(client, runtime)),
    30 * 60_000,
  );
  setInterval(
    () => run("retention_cleaner", () => runRetentionCleaner(client, runtime)),
    24 * 60 * 60_000,
  );
}

async function runAutoPoster(
  client: Client,
  runtime: BotRuntime,
): Promise<void> {
  const state = runtime.storage.getState();
  const now = runtime.now();
  const metrics = runtime.storage.metricsSnapshot();

  if (!shouldRunAutoPosterNow(state, now, metrics.last_successful_auto_post)) {
    return;
  }

  const today = now.toFormat("yyyy-LL-dd");

  const guild = await resolveConfiguredGuild(client, runtime);
  if (!guild) {
    return;
  }

  const channel = await resolveTargetChannel(guild, runtime);
  if (!channel) {
    return;
  }

  try {
    if (state.dry_run_auto_post) {
      const [chosenCategory, question] = runtime.storage.pickQuestion(
        null,
        true,
        runtime.randomInt,
      );
      runtime.storage.updateStateAtomic((mutable) => {
        mutable.last_dry_run_date = today;
      });

      await sendRuntimeLog(
        guild,
        runtime,
        "Court Auto-Post Dry Run",
        `**Channel:** ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Question:** ${question}`,
        channel.id,
      );
      return;
    }

    const [chosenCategory, question] = await postQuestionFromLoop(
      channel,
      runtime,
      {
        category: null,
        randomize: true,
        source: "auto",
        mentionEveryone: true,
      },
    );

    await sendRuntimeLog(
      guild,
      runtime,
      "Court Question Auto-Posted",
      `**Channel:** ${channel.toString()}\n**Category:** \`${chosenCategory}\`\n**Question:** ${question}`,
      channel.id,
    );
  } catch (error) {
    await sendFailureAlert(
      guild,
      runtime,
      "Court Auto-Post Failed",
      asError(error),
      "auto_poster loop",
      channel.id,
    );
  }
}

type AutoPosterState = Pick<
  CourtState,
  "mode" | "hour" | "minute" | "dry_run_auto_post" | "last_dry_run_date"
>;

export function shouldRunAutoPosterNow(
  state: AutoPosterState,
  now: DateTime,
  lastSuccessfulAutoPostIso: string | null,
): boolean {
  if (state.mode !== "auto") {
    return false;
  }

  const today = now.toFormat("yyyy-LL-dd");
  if (state.dry_run_auto_post && state.last_dry_run_date === today) {
    return false;
  }

  const scheduledAt = now.set({
    hour: state.hour,
    minute: state.minute,
    second: 0,
    millisecond: 0,
  });
  if (now < scheduledAt) {
    return false;
  }

  const runtimeZone = now.zoneName ?? "local";
  const lastAutoPostDate = getIsoDateInZone(
    lastSuccessfulAutoPostIso,
    runtimeZone,
  );
  return lastAutoPostDate !== today;
}

function getIsoDateInZone(value: string | null, zone: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) {
    return null;
  }

  const zoned = parsed.setZone(zone);
  const effective = zoned.isValid ? zoned : parsed;
  return effective.toFormat("yyyy-LL-dd");
}

async function runThreadCloser(
  client: Client,
  runtime: BotRuntime,
): Promise<void> {
  const guild = await resolveConfiguredGuild(client, runtime);
  if (!guild) {
    return;
  }

  const now = runtime.now();
  for (const record of runtime.storage.listPostRecords(false)) {
    if (record.closed) {
      continue;
    }

    const deadline = getPostCloseDeadline(record);
    if (!deadline || deadline > now) {
      continue;
    }

    try {
      const closed = await closeCourtPostFromLoop(
        record,
        runtime,
        client,
        "expired",
      );
      if (closed) {
        await sendRuntimeLog(
          guild,
          runtime,
          "Court Inquiry Auto-Closed",
          `**Message ID:** \`${record.message_id}\`\n**Question:** ${record.question}`,
          record.channel_id,
        );
      }
    } catch (error) {
      await sendFailureAlert(
        guild,
        runtime,
        "Court Thread Auto-Close Failed",
        asError(error),
        "thread_closer loop",
        record.channel_id,
      );
    }
  }
}

async function runWeeklyDigest(
  client: Client,
  runtime: BotRuntime,
): Promise<void> {
  const guild = await resolveConfiguredGuild(client, runtime);
  if (!guild) {
    return;
  }

  const now = runtime.now();
  const weekday = now.weekday - 1;
  if (
    weekday !== runtime.config.weeklyDigestWeekday ||
    now.hour !== runtime.config.weeklyDigestHour
  ) {
    return;
  }

  const weekKey = getWeekKey(now);
  const state = runtime.storage.getState();
  if (state.last_weekly_digest_week === weekKey) {
    return;
  }

  const channel = await resolveWeeklyDigestChannel(guild, runtime);
  if (!channel) {
    return;
  }

  try {
    await channel.send({ embeds: [buildWeeklyDigestEmbed(runtime)] });
    runtime.storage.updateStateAtomic((mutable) => {
      mutable.last_weekly_digest_week = weekKey;
    });
  } catch (error) {
    await sendFailureAlert(
      guild,
      runtime,
      "Weekly Digest Failed",
      asError(error),
      "weekly_digest loop",
      channel.id,
    );
  }
}

async function runRetentionCleaner(
  client: Client,
  runtime: BotRuntime,
): Promise<void> {
  const guild = await resolveConfiguredGuild(client, runtime);
  const removed = runtime.storage.purgeExpiredAnswers(
    runtime.config.answerRetentionDays,
  );

  if (!guild || removed <= 0) {
    return;
  }

  await sendRuntimeLog(
    guild,
    runtime,
    "Answer Retention Cleanup",
    `Removed \`${removed}\` answer record(s) older than \`${runtime.config.answerRetentionDays}\` day(s).`,
  );
}

function buildWeeklyDigestEmbed(runtime: BotRuntime): EmbedBuilder {
  const now = runtime.now();
  const metrics = runtime.storage.metricsSnapshot();
  const posts = runtime.storage.listPostRecords(true, POST_RECORD_LIMIT);
  const answersTotal = runtime.storage.countAllAnswerRecords();
  const openPosts = posts.filter((post) => !post.closed);
  const unansweredOpen = openPosts.filter(
    (post) => runtime.storage.countAnswersForQuestion(post.message_id) === 0,
  );
  const postCount = Math.max(posts.length, 1);

  const topCategories = Object.entries(metrics.posts_by_category)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  const topCategoryText =
    topCategories
      .map(([category, count]) => `- \`${category}\`: \`${count}\``)
      .join("\n") || "No data yet.";

  const usageTotal = Object.values(metrics.command_usage).reduce(
    (sum, value) => sum + value,
    0,
  );
  const failureTotal = Object.values(metrics.command_failures).reduce(
    (sum, value) => sum + value,
    0,
  );
  const failureRate = usageTotal > 0 ? (failureTotal / usageTotal) * 100 : 0;

  return new EmbedBuilder()
    .setTitle("Weekly Court Digest")
    .setDescription(`Week \`${getWeekKey(now)}\` performance summary.`)
    .setColor(ROLE_COLOR)
    .setTimestamp(now.toJSDate())
    .addFields(
      {
        name: "Posts & Answers",
        value:
          `**Posts (recent window):** \`${posts.length}\`\n` +
          `**Open Inquiries:** \`${openPosts.length}\`\n` +
          `**Unanswered Open:** \`${unansweredOpen.length}\`\n` +
          `**Answer Records:** \`${answersTotal}\`\n` +
          `**Avg Answers/Post:** \`${(answersTotal / postCount).toFixed(2)}\``,
        inline: false,
      },
      {
        name: "Top Categories",
        value: topCategoryText,
        inline: false,
      },
      {
        name: "Command Reliability",
        value:
          `**Command Invocations:** \`${usageTotal}\`\n` +
          `**Command Failures:** \`${failureTotal}\`\n` +
          `**Failure Rate:** \`${failureRate.toFixed(2)}%\``,
        inline: false,
      },
    );
}

async function postQuestionFromLoop(
  channel: RuntimeTargetChannel,
  runtime: BotRuntime,
  options: {
    category: string | null;
    randomize: boolean;
    source: "auto" | "manual" | "custom";
    mentionEveryone: boolean;
  },
): Promise<[string, string]> {
  const [chosenCategory, question] = runtime.storage.pickQuestion(
    options.category,
    options.randomize,
    runtime.randomInt,
  );
  const embed = buildCourtEmbed(chosenCategory, question, runtime);
  const mentionPayload = buildAnnouncementMentions(options.mentionEveryone);

  const sent = await channel.send({
    ...(mentionPayload.content === null
      ? {}
      : { content: mentionPayload.content }),
    embeds: [embed],
    components: buildAnonymousAnswerComponents(),
    allowedMentions: mentionPayload.allowedMentions,
  });

  const thread = await getOrCreateAnswerThread(sent, question, runtime);
  runtime.storage.upsertPostRow({
    message_id: String(sent.id),
    thread_id: thread?.id ?? null,
    channel_id: String(channel.id),
    category: chosenCategory,
    question,
    posted_at: isoNow(runtime.config.timezoneName),
    close_after_hours: THREAD_CLOSE_HOURS,
    closed: false,
    closed_at: null,
    close_reason: null,
  });

  runtime.storage.registerUsedQuestion(question);
  runtime.storage.recordPostMetric(chosenCategory, options.source);
  runtime.storage.updateStateAtomic((state) => {
    state.last_posted_date = runtime.now().toFormat("yyyy-LL-dd");
  });

  return [chosenCategory, question];
}

async function closeCourtPostFromLoop(
  record: PostRecord,
  runtime: BotRuntime,
  client: Client,
  reason: string,
): Promise<boolean> {
  if (record.closed) {
    return false;
  }

  const thread = await fetchThreadById(client, record.thread_id);
  if (thread) {
    await thread.edit({ archived: true, locked: true }).catch(() => null);
  }

  const message = await getPostMessage(client, record);
  if (message) {
    await message
      .edit({ components: buildClosedAnswerComponents() })
      .catch(() => null);
  }

  runtime.storage.markPostClosed(record.message_id, reason);
  return true;
}

function buildCourtEmbed(
  category: string,
  question: string,
  runtime: BotRuntime,
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("Imperial Court Inquiry")
    .setDescription(
      `*The throne demands an answer.*\n\n**Question:** ${question}`,
    )
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .setFooter({ text: `Category: ${category}` });
}

function buildAnonymousAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ANON_ANSWER_BUTTON_ID)
        .setLabel("Answer Anonymously")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildClosedAnswerComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ANON_ANSWER_BUTTON_ID}:closed`)
        .setLabel("Court Inquiry Closed")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  ];
}

function makeThreadName(question: string): string {
  const cleaned = question
    .split("")
    .filter((character) => /[a-zA-Z0-9\s\-_]/.test(character))
    .join("")
    .trim();
  const normalized = cleaned.split(/\s+/).join("-");
  const name = normalized ? `court-${normalized}` : "court-replies";
  return name.slice(0, 100);
}

async function getOrCreateAnswerThread(
  message: Message,
  question: string,
  runtime: BotRuntime,
): Promise<AnyThreadChannel | null> {
  if (!message.guild) {
    return null;
  }

  const cached = message.guild.channels.cache.get(message.id);
  if (cached?.isThread()) {
    runtime.storage.updatePostThreadId(message.id, cached.id);
    return cached;
  }

  const existingRecord = runtime.storage.getPostRecord(message.id);
  if (existingRecord?.thread_id) {
    const fetched = await fetchChannelById(
      message.client,
      existingRecord.thread_id,
    );
    if (fetched?.isThread()) {
      runtime.storage.updatePostThreadId(message.id, fetched.id);
      return fetched;
    }
  }

  const fetchedByMessageId = await fetchChannelById(message.client, message.id);
  if (fetchedByMessageId?.isThread()) {
    runtime.storage.updatePostThreadId(message.id, fetchedByMessageId.id);
    return fetchedByMessageId;
  }

  const thread = await message
    .startThread({
      name: makeThreadName(question),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    })
    .catch(async () =>
      message.startThread({ name: makeThreadName(question) }).catch(() => null),
    );

  if (!thread) {
    return null;
  }

  runtime.storage.updatePostThreadId(message.id, thread.id);
  await thread
    .send(
      "**Anonymous Court Replies**\n" +
        "- One anonymous answer per person\n" +
        "- Stay on topic\n" +
        "- Anonymous does not mean consequence-free\n" +
        `- This thread will close automatically after ${THREAD_CLOSE_HOURS} hours`,
    )
    .catch(() => null);

  return thread;
}

function isAdmin(member: GuildMember): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.guild.ownerId === member.id
  );
}

function getMemberRoyalTitles(
  member: GuildMember,
  runtime: BotRuntime,
): RoyalTitle[] {
  const titles: RoyalTitle[] = [];

  if (
    runtime.config.emperorRoleIdText &&
    member.roles.cache.has(runtime.config.emperorRoleIdText)
  ) {
    titles.push("Emperor");
  }
  if (
    runtime.config.empressRoleIdText &&
    member.roles.cache.has(runtime.config.empressRoleIdText)
  ) {
    titles.push("Empress");
  }

  return titles;
}

function clearMemberRoyalAfk(
  member: GuildMember,
  runtime: BotRuntime,
): RoyalTitle[] {
  const titles = getMemberRoyalTitles(member, runtime);
  if (titles.length === 0) {
    return [];
  }

  const cleared: RoyalTitle[] = [];
  runtime.storage.updateStateAtomic((state) => {
    for (const title of titles) {
      const entry = state.royal_afk.by_title[title];
      if (entry.active) {
        cleared.push(title);
      }

      state.royal_afk.by_title[title] = {
        active: false,
        reason: "",
        set_at: null,
        set_by_user_id: null,
      };
    }
  });

  return cleared;
}

function isRoyalAlertChannel(channelId: string, runtime: BotRuntime): boolean {
  if (!runtime.config.royalAlertChannelIdText) {
    return false;
  }

  return channelId === runtime.config.royalAlertChannelIdText;
}

async function handleRoyalPresenceAnnouncement(
  message: Message,
  member: GuildMember,
  runtime: BotRuntime,
): Promise<void> {
  const title = getMemberRoyalTitles(member, runtime)[0] ?? null;
  if (!title) {
    return;
  }

  const createdAt = DateTime.fromJSDate(message.createdAt);
  let shouldAnnounce = false;
  runtime.storage.updateStateAtomic((state) => {
    const previousIso = state.royal_presence.last_message_at_by_title[title];
    const previous = previousIso ? DateTime.fromISO(previousIso) : null;
    shouldAnnounce = shouldAnnounceRoyalPresence(
      previous?.isValid ? previous : null,
      createdAt,
    );

    const nowIso = createdAt.toISO();
    state.royal_presence.last_message_at_by_title[title] = nowIso;
    state.royal_presence.last_message_at = nowIso;
    state.royal_presence.last_speaker = title;
  });

  if (shouldAnnounce && isSendableChannel(message.channel)) {
    await message.channel
      .send({
        content: `# The ${title} has spoken`,
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
  }
}

async function maybeSendRoyalMentionResponse(
  message: Message,
  runtime: BotRuntime,
  inRoyalAlertChannel: boolean,
): Promise<boolean> {
  if (!inRoyalAlertChannel) {
    return false;
  }

  const mentionedTitles: RoyalTitle[] = [];
  for (const member of message.mentions.members?.values() ?? []) {
    for (const title of getMemberRoyalTitles(member, runtime)) {
      if (!mentionedTitles.includes(title)) {
        mentionedTitles.push(title);
      }
    }
  }

  const state = runtime.storage.getState();
  const response = getRoyalAfkResponse(
    message.content,
    state.royal_afk,
    runtime.now(),
    mentionedTitles,
  );
  if (!response) {
    return false;
  }

  if (isSendableChannel(message.channel)) {
    await message.channel
      .send({ content: response, allowedMentions: { parse: [] } })
      .catch(() => null);
  }

  return true;
}

type PrivilegedInvictusChatIntent = NonNullable<
  ReturnType<typeof parsePrivilegedInvictusChatIntent>
>;

function canUsePrivilegedInvictusChat(
  member: GuildMember,
  runtime: BotRuntime,
): boolean {
  const isEmpress =
    runtime.config.empressRoleIdText.length > 0 &&
    member.roles.cache.has(runtime.config.empressRoleIdText);
  const isConfiguredUser =
    runtime.config.undefeatedUserIdText.length > 0 &&
    member.id === runtime.config.undefeatedUserIdText;

  return isEmpress || isConfiguredUser;
}

function canUseInvictusIntent(
  intent: PrivilegedInvictusChatIntent,
  member: GuildMember,
  runtime: BotRuntime,
): boolean {
  if (isPublicInvictusChatIntent(intent)) {
    return true;
  }

  return canUsePrivilegedInvictusChat(member, runtime);
}

function buildPrivilegedInvictusChatResponse(
  intent: PrivilegedInvictusChatIntent,
  member: GuildMember,
  runtime: BotRuntime,
  state: CourtState,
): string {
  const memberMention = member.toString();
  const currentTimeText = runtime.now().toFormat("yyyy-LL-dd HH:mm");
  const scheduledHour = String(Math.max(0, Math.min(23, state.hour))).padStart(
    2,
    "0",
  );
  const scheduledMinute = String(
    Math.max(0, Math.min(59, state.minute)),
  ).padStart(2, "0");
  const courtChannelText = runtime.config.courtChannelIdText
    ? `<#${runtime.config.courtChannelIdText}>`
    : "not configured";

  switch (intent) {
    case "greeting": {
      const greetings = [
        `At your command, ${memberMention}.`,
        `${memberMention}, the throne is listening.`,
        `Invictus stands ready for your orders, ${memberMention}.`,
        `Your will, my mandate. Speak, ${memberMention}.`,
      ];
      return (
        greetings[runtime.randomInt(greetings.length)] ??
        `At your command, ${memberMention}.`
      );
    }
    case "help":
      return [
        `Invictus command phrases for ${memberMention}:`,
        "**Public:**",
        "- `hi invictus`",
        "- `invictus help`",
        "- `invictus flip a coin`",
        "- `invictus what time is it`",
        "- `thanks invictus`",
        "- `good night invictus`",
        ...(canUsePrivilegedInvictusChat(member, runtime)
          ? [
              "**Privileged:**",
              "- `invictus status report`",
              "- `invictus what should i do`",
              "- `invictus title me`",
            ]
          : []),
      ].join("\n");
    case "title":
      return `${memberMention}, by decree you are now: **${randomImperialTitle(runtime.randomInt)}**.`;
    case "coinflip":
      return runtime.randomInt(2) === 0
        ? "The coin lands on **heads**."
        : "The coin lands on **tails**.";
    case "time":
      return `Court time is \`${currentTimeText}\`.`;
    case "status":
      return [
        `Status report for ${memberMention}:`,
        `Mode: \`${state.mode}\``,
        `Auto-post schedule: \`${scheduledHour}:${scheduledMinute}\``,
        `Court channel: ${courtChannelText}`,
      ].join("\n");
    case "counsel":
      return [
        `Decree: ${randomImperialVerdict(runtime.randomInt)}`,
        `Omen: ${randomImperialOmen(runtime.randomInt)}`,
      ].join("\n");
    case "thanks":
      return "Always. The court stands with you.";
    case "farewell":
      return "Rest well. Invictus will keep watch.";
    default:
      return "Invictus stands ready.";
  }
}

async function maybeSendPrivilegedInvictusChatResponse(
  message: Message,
  member: GuildMember,
  runtime: BotRuntime,
): Promise<boolean> {
  const intent = parsePrivilegedInvictusChatIntent(message.content);
  if (!intent) {
    return false;
  }

  if (!canUseInvictusIntent(intent, member, runtime)) {
    return false;
  }

  if (!isSendableChannel(message.channel)) {
    return false;
  }

  const state = runtime.storage.getState();
  const response = buildPrivilegedInvictusChatResponse(
    intent,
    member,
    runtime,
    state,
  );

  await message.channel
    .send({ content: response, allowedMentions: { parse: [] } })
    .catch(() => null);
  return true;
}

async function lockChannelSilently(
  channel: TextChannel,
  actor: GuildMember,
  runtime: BotRuntime,
  seconds: number,
): Promise<void> {
  const targetRoleIds = new Set<string>([
    actor.guild.roles.everyone.id,
    SILENCE_LOCK_CITIZEN_ROLE_ID,
  ]);
  const targetRoles = Array.from(targetRoleIds)
    .map((roleId) => actor.guild.roles.cache.get(roleId) ?? null)
    .filter((role): role is Role => role !== null && !role.managed);

  const originalSendFlags = new Map<string, boolean | null>();
  const appliedRoles: Role[] = [];

  for (const role of targetRoles) {
    const overwrite = channel.permissionOverwrites.cache.get(role.id);
    let originalSend: boolean | null = null;
    if (overwrite?.allow.has(PermissionFlagsBits.SendMessages)) {
      originalSend = true;
    } else if (overwrite?.deny.has(PermissionFlagsBits.SendMessages)) {
      originalSend = false;
    }

    originalSendFlags.set(role.id, originalSend);

    const applied = await channel.permissionOverwrites
      .edit(
        role,
        { SendMessages: false },
        { reason: `Silence by ${actor.user.tag}` },
      )
      .then(() => true)
      .catch(() => false);

    if (applied) {
      appliedRoles.push(role);
    }
  }

  if (appliedRoles.length === 0) {
    return;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, seconds) * 1000);
  });

  for (const role of appliedRoles) {
    const original = originalSendFlags.get(role.id) ?? null;
    const sendValue = original ?? null;

    await channel.permissionOverwrites
      .edit(
        role,
        { SendMessages: sendValue },
        { reason: `Silence expired by ${actor.user.tag}` },
      )
      .catch(() => null);
  }
}

async function handleReplyMuteTrigger(
  message: Message,
  actor: GuildMember,
  reasonText: string,
  runtime: BotRuntime,
): Promise<void> {
  const target = await getRepliedMember(message);
  if (!target || !message.guild) {
    return;
  }

  const me =
    message.guild.members.me ??
    (await message.guild.members.fetchMe().catch(() => null));
  if (!me) {
    return;
  }

  const [allowed, whyNot] = canTimeoutTarget(actor, me, target);
  if (!allowed) {
    await sendMuteFailedEmbed(message, target, whyNot);
    return;
  }

  const timeoutDurationMs = REPLY_MUTE_MINUTES * 60_000;
  const modReason = buildTimeoutReason(
    "Muted",
    actor,
    reasonText || "reply command",
  );

  const timeoutSuccess = await target
    .timeout(timeoutDurationMs, modReason)
    .then(() => true)
    .catch(() => false);
  if (!timeoutSuccess) {
    await sendMuteFailedEmbed(message, target, "discord API error");
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Invictus Mute")
    .setDescription(
      `${target.toString()} has been muted for \`${REPLY_MUTE_MINUTES}\` minute(s).`,
    )
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate())
    .addFields(
      { name: "By", value: actor.toString(), inline: true },
      {
        name: "Reason",
        value: reasonText || "No reason provided.",
        inline: true,
      },
    );

  if (isSendableChannel(message.channel)) {
    await message.channel.send({ embeds: [embed] }).catch(() => null);
  }

  await sendRuntimeLog(
    message.guild,
    runtime,
    "Reply Mute Triggered",
    `**By:** ${actor.toString()}\n**Target:** ${target.toString()}\n**Minutes:** \`${REPLY_MUTE_MINUTES}\`\n**Reason:** ${reasonText || "No reason provided."}`,
    String(message.channel.id),
  );
}

async function sendMuteFailedEmbed(
  message: Message,
  target: GuildMember,
  reason: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Mute Failed")
    .setDescription(`Could not mute ${target.toString()}: ${reason}.`)
    .setColor(ROLE_COLOR)
    .setTimestamp(new Date());

  await message
    .reply({ embeds: [embed], allowedMentions: { repliedUser: false } })
    .catch(() => null);
}

async function getRepliedMember(message: Message): Promise<GuildMember | null> {
  const referenceId = message.reference?.messageId;
  if (!referenceId || !message.guild || !message.channel.isTextBased()) {
    return null;
  }

  const targetMessage = await message
    .fetchReference()
    .catch(async () =>
      message.channel.isTextBased()
        ? message.channel.messages.fetch(referenceId).catch(() => null)
        : null,
    );

  if (!targetMessage?.author) {
    return null;
  }

  return message.guild.members.fetch(targetMessage.author.id).catch(() => null);
}

function canTimeoutTarget(
  actor: GuildMember,
  me: GuildMember,
  target: GuildMember,
): [boolean, string] {
  if (target.user.bot) {
    return [false, "target is a bot"];
  }
  if (target.id === me.id) {
    return [false, "target is the bot"];
  }
  if (target.id === actor.guild.ownerId) {
    return [false, "target is the server owner"];
  }
  if (target.id === actor.id) {
    return [false, "target is yourself"];
  }
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return [false, "bot role is not high enough"];
  }

  const actorIsOwner = actor.id === actor.guild.ownerId;
  if (
    !actorIsOwner &&
    actor.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return [false, "your role is not high enough"];
  }

  return [true, ""];
}

function buildTimeoutReason(
  action: string,
  user: GuildMember,
  reason: string | null,
): string {
  const base = `${action} by ${user.user.tag} via /admin`;
  if (!reason) {
    return base;
  }

  return `${base} | ${reason}`;
}

async function resolveMessageMember(
  message: Message,
): Promise<GuildMember | null> {
  if (!message.guild) {
    return null;
  }

  if (message.member) {
    return message.member;
  }

  return message.guild.members.fetch(message.author.id).catch(() => null);
}

async function resolveConfiguredGuild(
  client: Client,
  runtime: BotRuntime,
): Promise<Guild | null> {
  return client.guilds.fetch(runtime.config.testGuildIdText).catch(() => null);
}

async function resolveTargetChannel(
  guild: Guild,
  runtime: BotRuntime,
): Promise<RuntimeTargetChannel | null> {
  const state = runtime.storage.getState();
  const candidates = [
    runtime.config.courtChannelIdText,
    String(state.channel_id ?? "").trim(),
    String(runtime.config.courtChannelId ?? "").trim(),
  ];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const resolved = await getOrFetchRuntimeTargetChannel(guild, candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolveWeeklyDigestChannel(
  guild: Guild,
  runtime: BotRuntime,
): Promise<RuntimeTargetChannel | null> {
  if (runtime.config.weeklyDigestChannelIdText) {
    const channel = await getOrFetchRuntimeTargetChannel(
      guild,
      runtime.config.weeklyDigestChannelIdText,
    );
    if (channel) {
      return channel;
    }
  }

  const logDestination = await resolveLogDestination(guild, runtime);
  return logDestination;
}

async function sendRuntimeLog(
  guild: Guild,
  runtime: BotRuntime,
  title: string,
  description: string,
  fallbackChannelId?: string,
): Promise<boolean> {
  const destination = await resolveLogDestination(
    guild,
    runtime,
    fallbackChannelId,
  );
  if (!destination) {
    return false;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(ROLE_COLOR)
    .setTimestamp(runtime.now().toJSDate());

  const sent = await destination
    .send({ embeds: [embed] })
    .then(() => true)
    .catch(() => false);
  return sent;
}

async function sendFailureAlert(
  guild: Guild | null,
  runtime: BotRuntime,
  title: string,
  error: Error,
  context: string,
  fallbackChannelId?: string,
): Promise<void> {
  logError("runtime-alert", title, {
    context,
    error,
  });
  if (!guild) {
    return;
  }

  const description = `**Context:** ${context}\n**Error Type:** \`${error.name}\`\n**Error:** \`${error.message.slice(0, 1000)}\``;
  await sendRuntimeLog(guild, runtime, title, description, fallbackChannelId);
}

async function resolveLogDestination(
  guild: Guild,
  runtime: BotRuntime,
  fallbackChannelId?: string,
): Promise<RuntimeTargetChannel | null> {
  const state = runtime.storage.getState();
  const candidates = [
    runtime.config.logChannelIdText,
    String(state.log_channel_id ?? "").trim(),
    String(runtime.config.logChannelId ?? "").trim(),
    fallbackChannelId ?? "",
  ];

  for (const candidate of candidates) {
    if (!/^\d+$/.test(candidate) || candidate === "0") {
      continue;
    }

    const fetched = await fetchChannelById(guild.client, candidate);
    if (isRuntimeTargetChannel(fetched)) {
      return fetched;
    }
  }

  return null;
}

async function getOrFetchRuntimeTargetChannel(
  guild: Guild,
  channelId: string,
): Promise<RuntimeTargetChannel | null> {
  const cached = guild.channels.cache.get(channelId);
  if (isRuntimeTargetChannel(cached)) {
    return cached;
  }

  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  return isRuntimeTargetChannel(fetched) ? fetched : null;
}

async function fetchChannelById(
  client: Client,
  channelId: string,
): Promise<Channel | null> {
  if (!/^\d+$/.test(channelId)) {
    return null;
  }

  const cached = client.channels.cache.get(channelId);
  if (cached) {
    return cached;
  }

  return client.channels.fetch(channelId).catch(() => null);
}

async function fetchThreadById(
  client: Client,
  threadId: string | null | undefined,
): Promise<AnyThreadChannel | null> {
  if (!threadId) {
    return null;
  }

  const fetched = await fetchChannelById(client, threadId);
  return fetched?.isThread() ? fetched : null;
}

async function getPostMessage(
  client: Client,
  record: PostRecord,
): Promise<Message | null> {
  const channel = await fetchChannelById(client, record.channel_id);
  if (!channel?.isTextBased()) {
    return null;
  }

  return channel.messages.fetch(record.message_id).catch(() => null);
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return new Error(`${error}`);
  }

  if (error === null || error === undefined) {
    return new Error("Unknown error");
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown non-serializable error");
  }
}

function isSendableChannel(
  channel: unknown,
): channel is { send: (payload: unknown) => Promise<unknown> } {
  return typeof (channel as { send?: unknown } | null)?.send === "function";
}

function isRuntimeTargetChannel(
  channel: unknown,
): channel is RuntimeTargetChannel {
  if (channel instanceof TextChannel || channel instanceof NewsChannel) {
    return true;
  }

  if (!channel || typeof channel !== "object") {
    return false;
  }

  const maybeThreadChannel = channel as { isThread?: () => boolean };
  return (
    typeof maybeThreadChannel.isThread === "function" &&
    maybeThreadChannel.isThread()
  );
}
