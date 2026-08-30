import type { Guild, GuildMember, Role } from "discord.js";
import { observeLatency } from "../latency.js";

type MemberFetchOptions = {
  readonly cache?: boolean;
  readonly force?: boolean;
};

const memberRequests = new WeakMap<
  Guild,
  Map<string, Promise<GuildMember | null>>
>();
const roleRequests = new WeakMap<Guild, Map<string, Promise<Role | null>>>();
const botMemberRequests = new WeakMap<Guild, Promise<GuildMember | null>>();

/**
 * Coalesces only overlapping member requests. A settled request is removed so
 * every later authorization check still performs its own forced Discord read.
 */
export function fetchGuildMemberCoalesced(
  guild: Guild,
  userId: string,
  options: MemberFetchOptions = { cache: true, force: true },
): Promise<GuildMember | null> {
  let requests = memberRequests.get(guild);
  if (!requests) {
    requests = new Map();
    memberRequests.set(guild, requests);
  }
  const existing = requests.get(userId);
  const request =
    existing ??
    fetchMember(guild, userId, options).finally(() => {
      if (requests?.get(userId) === request) requests.delete(userId);
    });
  if (!existing) requests.set(userId, request);
  return observeLatency(
    "authorization.member.fetch",
    "guild-member",
    () => request,
    { guildId: guild.id, cache: existing ? "coalesced" : "miss" },
  );
}

/** Coalesces only overlapping role reads; role validation remains forced. */
export function fetchGuildRoleCoalesced(
  guild: Guild,
  roleId: string,
): Promise<Role | null> {
  let requests = roleRequests.get(guild);
  if (!requests) {
    requests = new Map();
    roleRequests.set(guild, requests);
  }
  const existing = requests.get(roleId);
  const request =
    existing ??
    fetchRole(guild, roleId).finally(() => {
      if (requests?.get(roleId) === request) requests.delete(roleId);
    });
  if (!existing) requests.set(roleId, request);
  return observeLatency(
    "authorization.role.fetch",
    "guild-role",
    () => request,
    { guildId: guild.id, cache: existing ? "coalesced" : "miss" },
  );
}

/**
 * Uses the already-known bot member when callers permit it, otherwise shares
 * one in-flight fetch. No completed forced fetch is retained as an auth cache.
 */
export function fetchCurrentBotMember(
  guild: Guild,
  options: { readonly force?: boolean } = {},
): Promise<GuildMember | null> {
  if (!options.force && guild.members.me) {
    return observeLatency(
      "authorization.bot-member.fetch",
      "current-bot-member",
      async () => guild.members.me,
      { guildId: guild.id, cache: "hit" },
    );
  }
  const existing = botMemberRequests.get(guild);
  const request =
    existing ??
    fetchBotMember(guild, options.force === true).finally(() => {
      if (botMemberRequests.get(guild) === request) {
        botMemberRequests.delete(guild);
      }
    });
  if (!existing) botMemberRequests.set(guild, request);
  return observeLatency(
    "authorization.bot-member.fetch",
    "current-bot-member",
    () => request,
    { guildId: guild.id, cache: existing ? "coalesced" : "miss" },
  );
}

function fetchMember(
  guild: Guild,
  userId: string,
  options: MemberFetchOptions,
): Promise<GuildMember | null> {
  return guild.members
    .fetch({
      user: userId,
      cache: options.cache ?? true,
      force: options.force ?? true,
    })
    .catch(() => null);
}

function fetchRole(guild: Guild, roleId: string): Promise<Role | null> {
  return guild.roles
    .fetch(roleId, { cache: true, force: true })
    .catch(() => null);
}

function fetchBotMember(
  guild: Guild,
  force: boolean,
): Promise<GuildMember | null> {
  return (
    force
      ? guild.members.fetchMe({ cache: true, force: true })
      : guild.members.fetchMe()
  ).catch(() => null);
}
