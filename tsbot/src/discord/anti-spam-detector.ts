import { createHash } from "node:crypto";

export const ANTI_SPAM_RULE_TYPES = ["burst", "duplicate", "mention"] as const;
export type AntiSpamDetectorRuleType = (typeof ANTI_SPAM_RULE_TYPES)[number];

export interface AntiSpamDetectorRule {
  ruleType: AntiSpamDetectorRuleType;
  enabled: boolean;
  threshold: number;
  windowSeconds: number | null;
}

export interface AntiSpamMessageSample {
  guildId: string;
  memberId: string;
  content: string;
  userMentionCount: number;
  roleMentionCount: number;
  createdTimestamp: number;
}

export interface AntiSpamDetection {
  ruleType: AntiSpamDetectorRuleType;
  observedCount: number;
  threshold: number;
  windowSeconds: number | null;
}

interface FingerprintWindow {
  timestamps: number[];
  touchedAt: number;
}

interface MemberWindow {
  burstTimestamps: number[];
  fingerprints: Map<string, FingerprintWindow>;
  touchedAt: number;
}

const MAX_WINDOW_SECONDS = 300;
const MAX_TIMESTAMPS_PER_WINDOW = 100;
const MAX_FINGERPRINTS_PER_MEMBER = 25;
const MAX_MEMBERS_PER_GUILD = 2_000;
export const MAX_ANTI_SPAM_GUILDS = 1_000;

/**
 * Process-local detector windows. They intentionally reset at restart; only
 * enforcement reservations and cooldowns belong in persistent storage.
 */
export class AntiSpamDetector {
  private readonly guilds = new Map<string, Map<string, MemberWindow>>();

  public evaluate(
    sample: AntiSpamMessageSample,
    rules: readonly AntiSpamDetectorRule[],
  ): AntiSpamDetection | null {
    const enabled = new Map(
      rules.filter(isUsableRule).map((rule) => [rule.ruleType, rule] as const),
    );
    if (enabled.size === 0) {
      this.clearGuild(sample.guildId);
      return null;
    }

    const now = normalizeTimestamp(sample.createdTimestamp);
    const guild = this.getGuild(sample.guildId);
    const member = this.getMember(guild, sample.memberId, now);
    this.pruneMember(member, now);

    const detections: AntiSpamDetection[] = [];
    const mentionRule = enabled.get("mention");
    if (mentionRule) {
      const observed = Math.max(
        0,
        Math.trunc(sample.userMentionCount) +
          Math.trunc(sample.roleMentionCount),
      );
      if (observed >= mentionRule.threshold) {
        detections.push(toDetection(mentionRule, observed));
      }
    }

    const duplicateRule = enabled.get("duplicate");
    if (duplicateRule) {
      const fingerprint = fingerprintContent(sample.content);
      if (fingerprint) {
        const cutoff =
          now - normalizeWindowSeconds(duplicateRule.windowSeconds) * 1_000;
        const window = member.fingerprints.get(fingerprint) ?? {
          timestamps: [],
          touchedAt: now,
        };
        window.timestamps = window.timestamps.filter(
          (timestamp) => timestamp >= cutoff,
        );
        window.timestamps.push(now);
        if (window.timestamps.length > MAX_TIMESTAMPS_PER_WINDOW) {
          window.timestamps.splice(
            0,
            window.timestamps.length - MAX_TIMESTAMPS_PER_WINDOW,
          );
        }
        window.touchedAt = now;
        member.fingerprints.delete(fingerprint);
        member.fingerprints.set(fingerprint, window);
        this.trimFingerprints(member);
        if (window.timestamps.length >= duplicateRule.threshold) {
          detections.push(toDetection(duplicateRule, window.timestamps.length));
        }
      }
    }

    const burstRule = enabled.get("burst");
    if (burstRule) {
      const cutoff =
        now - normalizeWindowSeconds(burstRule.windowSeconds) * 1_000;
      member.burstTimestamps = member.burstTimestamps.filter(
        (timestamp) => timestamp >= cutoff,
      );
      member.burstTimestamps.push(now);
      if (member.burstTimestamps.length > MAX_TIMESTAMPS_PER_WINDOW) {
        member.burstTimestamps.splice(
          0,
          member.burstTimestamps.length - MAX_TIMESTAMPS_PER_WINDOW,
        );
      }
      if (member.burstTimestamps.length >= burstRule.threshold) {
        detections.push(toDetection(burstRule, member.burstTimestamps.length));
      }
    }

    // Prefer the most specific rule while still recording every enabled
    // rolling window for this message.
    return detections[0] ?? null;
  }

  public clearGuild(guildId: string): void {
    this.guilds.delete(guildId);
  }

  public clearAll(): void {
    this.guilds.clear();
  }

  public guildCount(): number {
    return this.guilds.size;
  }

  public memberCount(guildId: string): number {
    return this.guilds.get(guildId)?.size ?? 0;
  }

  private getGuild(guildId: string): Map<string, MemberWindow> {
    const existing = this.guilds.get(guildId);
    if (existing) {
      this.guilds.delete(guildId);
      this.guilds.set(guildId, existing);
      return existing;
    }
    while (this.guilds.size >= MAX_ANTI_SPAM_GUILDS) {
      const oldest = this.guilds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.guilds.delete(oldest);
    }
    const created = new Map<string, MemberWindow>();
    this.guilds.set(guildId, created);
    return created;
  }

  private getMember(
    guild: Map<string, MemberWindow>,
    memberId: string,
    now: number,
  ): MemberWindow {
    const existing = guild.get(memberId);
    if (existing) {
      existing.touchedAt = now;
      guild.delete(memberId);
      guild.set(memberId, existing);
      return existing;
    }
    while (guild.size >= MAX_MEMBERS_PER_GUILD) {
      const oldest = guild.keys().next().value as string | undefined;
      if (!oldest) break;
      guild.delete(oldest);
    }
    const created: MemberWindow = {
      burstTimestamps: [],
      fingerprints: new Map(),
      touchedAt: now,
    };
    guild.set(memberId, created);
    return created;
  }

  private pruneMember(member: MemberWindow, now: number): void {
    const oldest = now - MAX_WINDOW_SECONDS * 1_000;
    member.burstTimestamps = member.burstTimestamps.filter(
      (timestamp) => timestamp >= oldest,
    );
    for (const [fingerprint, window] of member.fingerprints) {
      window.timestamps = window.timestamps.filter(
        (timestamp) => timestamp >= oldest,
      );
      if (window.timestamps.length === 0 || window.touchedAt < oldest) {
        member.fingerprints.delete(fingerprint);
      }
    }
  }

  private trimFingerprints(member: MemberWindow): void {
    while (member.fingerprints.size > MAX_FINGERPRINTS_PER_MEMBER) {
      const oldest = member.fingerprints.keys().next().value as
        string | undefined;
      if (!oldest) break;
      member.fingerprints.delete(oldest);
    }
  }
}

export function evaluateSyntheticAntiSpam(options: {
  rule: AntiSpamDetectorRule;
  content?: string;
  messageCount?: number;
  repetitionCount?: number;
  userMentionCount?: number;
  roleMentionCount?: number;
}): AntiSpamDetection | null {
  if (!isUsableRule(options.rule)) return null;
  const observed =
    options.rule.ruleType === "burst"
      ? normalizeSyntheticCount(options.messageCount)
      : options.rule.ruleType === "duplicate"
        ? options.content === undefined || fingerprintContent(options.content)
          ? normalizeSyntheticCount(options.repetitionCount)
          : 0
        : normalizeSyntheticCount(options.userMentionCount) +
          normalizeSyntheticCount(options.roleMentionCount);
  return observed >= options.rule.threshold
    ? toDetection(options.rule, observed)
    : null;
}

function isUsableRule(rule: AntiSpamDetectorRule): boolean {
  if (
    !rule ||
    rule.enabled !== true ||
    !ANTI_SPAM_RULE_TYPES.includes(rule.ruleType) ||
    !Number.isInteger(rule.threshold) ||
    rule.threshold < 2 ||
    rule.threshold > 100
  ) {
    return false;
  }
  return (
    rule.ruleType === "mention" ||
    (Number.isInteger(rule.windowSeconds) &&
      Number(rule.windowSeconds) >= 1 &&
      Number(rule.windowSeconds) <= MAX_WINDOW_SECONDS)
  );
}

function toDetection(
  rule: AntiSpamDetectorRule,
  observedCount: number,
): AntiSpamDetection {
  return {
    ruleType: rule.ruleType,
    observedCount,
    threshold: rule.threshold,
    windowSeconds: rule.ruleType === "mention" ? null : rule.windowSeconds,
  };
}

function normalizeWindowSeconds(value: number | null): number {
  return Math.min(Math.max(Math.trunc(value ?? 1), 1), MAX_WINDOW_SECONDS);
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : Date.now();
}

function normalizeSyntheticCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

function fingerprintContent(value: string): string | null {
  const normalized = String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return null;
  return Buffer.from(
    createHash("sha256").update(normalized.slice(0, 4_000)).digest(),
  ).toString("hex");
}
