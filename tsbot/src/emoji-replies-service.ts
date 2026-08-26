import fs from "node:fs";
import path from "node:path";
import type { Message } from "discord.js";
import { logError, logInfo, logWarn } from "./logging.js";
import {
  loadEmojiRepliesConfig,
  resolveEmojiRepliesConfigPath,
  type EmojiRepliesConfig,
} from "./emoji-replies-config.js";

const SAFE_ALLOWED_MENTIONS = Object.freeze({
  parse: [] as never[],
  repliedUser: false,
});

export interface EmojiReplyServiceOptions {
  readonly randomInt?: (maxExclusive: number) => number;
  readonly applicationRoot?: string;
}

interface ReplyContext {
  readonly generation: number;
  readonly guildId: string;
  readonly memberId: string;
  readonly message: Message;
}

/** Applies file-configured Unicode reactions and replies to selected members. */
export class EmojiReplyService {
  private configuration: EmojiRepliesConfig | null;
  private readonly randomInt: (maxExclusive: number) => number;
  private readonly applicationRoot: string | null;
  private readonly filePath: string | null;
  private readonly replySkips = new Map<string, number>();
  private readonly replyChains = new Map<string, Promise<void>>();
  private fileWatcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private lastFileSignature: string | null = null;
  private configurationGeneration = 0;
  private closed = false;

  public constructor(
    configuration: EmojiRepliesConfig | null = null,
    options: EmojiReplyServiceOptions = {},
  ) {
    this.configuration = configuration;
    this.randomInt =
      options.randomInt ??
      ((maxExclusive) => Math.floor(Math.random() * Math.max(maxExclusive, 1)));
    this.applicationRoot = options.applicationRoot
      ? path.resolve(options.applicationRoot)
      : null;
    this.filePath = this.applicationRoot
      ? resolveEmojiRepliesConfigPath(this.applicationRoot)
      : null;
  }

  public get currentConfiguration(): EmojiRepliesConfig | null {
    return this.configuration;
  }

  public async processMessage(message: Message): Promise<void> {
    if (this.closed) return;
    this.refreshConfigurationIfChanged();
    const configuration = this.configuration;
    if (
      !configuration ||
      message.author?.bot ||
      Boolean(message.webhookId) ||
      !isSnowflake(message.guildId) ||
      !message.guild ||
      message.guild.id !== message.guildId ||
      (message.channel as { readonly guildId?: string | null }).guildId !==
        message.guildId
    ) {
      return;
    }

    const guildId = message.guildId;
    const memberId = message.author.id;
    const memberConfiguration =
      configuration.servers[guildId]?.members[memberId];
    if (
      !memberConfiguration ||
      (memberConfiguration.reactionEmojis.length === 0 &&
        memberConfiguration.replyEmojis.length === 0)
    ) {
      return;
    }

    const reactionWork = configuration.reactionsEnabled
      ? memberConfiguration.reactionEmojis.map((emoji, index) =>
          this.addReaction(message, guildId, memberId, emoji, index),
        )
      : [];
    const replyWork =
      configuration.repliesEnabled && memberConfiguration.replyEmojis.length > 0
        ? this.enqueueReply({
            generation: this.configurationGeneration,
            guildId,
            memberId,
            message,
          })
        : Promise.resolve();

    await Promise.all([Promise.all(reactionWork), replyWork]);
  }

  /** Force a synchronous disk reload; invalid data leaves the active config unchanged. */
  public reload(): void {
    if (this.closed || !this.filePath) return;
    this.reloadFromDisk(true);
    this.ensureFileWatcher();
  }

  public close(): void {
    this.closed = true;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }

  public startFromDisk(): void {
    if (!this.filePath || this.closed) return;
    this.reloadFromDisk(true);
    this.ensureFileWatcher();
  }

  private enqueueReply(context: ReplyContext): Promise<void> {
    const key = `${context.guildId}:${context.memberId}`;
    const previous = this.replyChains.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (
          context.generation !== this.configurationGeneration ||
          !this.isMemberReplyConfigured(context.guildId, context.memberId)
        ) {
          return;
        }
        const remainingSkips = this.replySkips.get(key) ?? 0;
        if (remainingSkips > 0) {
          this.replySkips.set(key, remainingSkips - 1);
          return;
        }

        const sent = await this.sendReply(
          context.message,
          context.guildId,
          context.memberId,
        );
        if (!sent) {
          this.replySkips.delete(key);
          return;
        }
        this.replySkips.set(key, clampDelay(this.randomInt(5) + 1));
      })
      .catch((error) => {
        logError("emoji-replies", "Configured emoji reply processing failed", {
          guildId: context.guildId,
          memberId: context.memberId,
          messageId: context.message.id,
          error,
        });
      });
    this.replyChains.set(key, current);
    void current.then(
      () => this.removeReplyChain(key, current),
      () => this.removeReplyChain(key, current),
    );
    return current;
  }

  private removeReplyChain(key: string, chain: Promise<void>): void {
    if (this.replyChains.get(key) === chain) {
      this.replyChains.delete(key);
    }
  }

  private isMemberReplyConfigured(guildId: string, memberId: string): boolean {
    const configuration = this.configuration;
    return Boolean(
      configuration?.repliesEnabled &&
      configuration.servers[guildId]?.members[memberId]?.replyEmojis.length,
    );
  }

  private async addReaction(
    message: Message,
    guildId: string,
    memberId: string,
    emoji: string,
    reactionIndex: number,
  ): Promise<void> {
    try {
      await message.react(emoji);
    } catch (error) {
      logError("emoji-replies", "Could not add configured reaction", {
        guildId,
        memberId,
        messageId: message.id,
        reactionIndex,
        error,
      });
    }
  }

  private async sendReply(
    message: Message,
    guildId: string,
    memberId: string,
  ): Promise<boolean> {
    const memberConfiguration =
      this.configuration?.servers[guildId]?.members[memberId];
    if (!memberConfiguration) return false;
    try {
      await message.reply({
        content: memberConfiguration.replyEmojis.join(""),
        allowedMentions: SAFE_ALLOWED_MENTIONS,
      });
      return true;
    } catch (error) {
      logError("emoji-replies", "Could not send configured emoji reply", {
        guildId,
        memberId,
        messageId: message.id,
        error,
      });
      return false;
    }
  }

  private refreshConfigurationIfChanged(): void {
    if (!this.filePath || this.closed) return;
    const signature = fileSignature(this.filePath);
    if (signature === this.lastFileSignature) return;
    this.reloadFromDisk(false);
    this.ensureFileWatcher();
  }

  private reloadFromDisk(force: boolean): void {
    if (!this.filePath || this.closed) return;
    const signature = fileSignature(this.filePath);
    if (!force && signature === this.lastFileSignature) return;
    this.lastFileSignature = signature;
    const loaded = loadEmojiRepliesConfig(this.applicationRoot!);
    if (loaded.status === "missing") {
      if (this.configuration !== null) {
        this.configuration = null;
        this.resetReplyState();
      }
      return;
    }
    if (loaded.status === "invalid") {
      logError(
        "emoji-replies",
        "Emoji reply configuration is invalid; keeping the last valid configuration",
        {
          issueCount: loaded.issues.length,
          issue: loaded.issues[0] ?? "unknown validation error",
        },
      );
      return;
    }

    this.configuration = loaded.config;
    this.resetReplyState();
    const memberCount = Object.values(loaded.config.servers).reduce(
      (total, server) => total + Object.keys(server.members).length,
      0,
    );
    logInfo("emoji-replies", "Emoji reply configuration loaded", {
      reactionsEnabled: loaded.config.reactionsEnabled,
      repliesEnabled: loaded.config.repliesEnabled,
      serverCount: Object.keys(loaded.config.servers).length,
      memberCount,
    });
  }

  private resetReplyState(): void {
    this.configurationGeneration += 1;
    this.replySkips.clear();
    this.replyChains.clear();
  }

  private ensureFileWatcher(): void {
    if (
      !this.applicationRoot ||
      this.fileWatcher ||
      this.closed ||
      !fs.existsSync(this.filePath!)
    ) {
      return;
    }
    try {
      const watcher = fs.watch(this.applicationRoot, (_event, filename) => {
        if (
          filename &&
          path.basename(filename.toString()) !== path.basename(this.filePath!)
        ) {
          return;
        }
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.refreshConfigurationIfChanged();
        }, 50);
        this.reloadTimer.unref?.();
      });
      watcher.on("error", (error) => {
        logWarn("emoji-replies", "Emoji reply configuration watcher failed", {
          error,
        });
      });
      this.fileWatcher = watcher;
    } catch (error) {
      logWarn("emoji-replies", "Could not watch emoji reply configuration", {
        error,
      });
    }
  }
}

export function createEmojiReplyService(
  applicationRoot: string,
  options: Omit<EmojiReplyServiceOptions, "applicationRoot"> = {},
): EmojiReplyService {
  const service = new EmojiReplyService(null, {
    ...options,
    applicationRoot,
  });
  service.startFromDisk();
  return service;
}

function fileSignature(filePath: string): string {
  try {
    const stats = fs.statSync(filePath);
    return `file:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "missing";
    }
    return "unreadable";
  }
}

function isSnowflake(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

function clampDelay(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, Math.floor(value)));
}
