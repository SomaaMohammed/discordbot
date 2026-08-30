import type { Collection, Guild, GuildMember, Role } from "discord.js";
import { observeLatency } from "../latency.js";

export type GuildFetchOptions = {
  readonly cache?: boolean;
  readonly force?: boolean;
  readonly input?: "id" | "object";
};

type FetchCacheStatus = "miss" | "coalesced";
type RequestResult<T> = {
  readonly request: Promise<T>;
  readonly cache: FetchCacheStatus;
};

const memberRequests = new WeakMap<Guild, Map<string, Promise<GuildMember>>>();
const roleRequests = new WeakMap<Guild, Map<string, Promise<Role | null>>>();
const botMemberRequests = new WeakMap<
  Guild,
  Map<"forced" | "normal", Promise<GuildMember>>
>();

/**
 * Coalesces only overlapping member requests. A settled request is removed so
 * every later authorization check still performs its own forced Discord read.
 */
export function fetchGuildMemberCoalesced(
  guild: Guild,
  userId: string,
  options: GuildFetchOptions = { cache: true, force: true },
): Promise<GuildMember | null> {
  const { request, cache } = getMemberRequest(guild, userId, options);
  return observeLatency(
    "authorization.member.fetch",
    "guild-member",
    () => request.catch(() => null),
    { guildId: guild.id, cache },
  );
}

/** Preserves Discord errors for recovery paths that distinguish missing members. */
export function fetchGuildMemberCoalescedOrThrow(
  guild: Guild,
  userId: string,
  options: GuildFetchOptions = { cache: true, force: true },
): Promise<GuildMember> {
  const { request, cache } = getMemberRequest(guild, userId, options);
  return observeLatency(
    "authorization.member.fetch",
    "guild-member",
    () => request,
    { guildId: guild.id, cache },
  );
}

function getMemberRequest(
  guild: Guild,
  userId: string,
  options: GuildFetchOptions,
): RequestResult<GuildMember> {
  let requests = memberRequests.get(guild);
  if (!requests) {
    requests = new Map();
    memberRequests.set(guild, requests);
  }
  const requestKey = `${userId}:${options.force === true ? "forced" : "normal"}:${options.input ?? "object"}`;
  const existing = requests.get(requestKey);
  if (existing) return { request: existing, cache: "coalesced" };
  const request = fetchMember(guild, userId, options).finally(() => {
    if (requests?.get(requestKey) === request) requests.delete(requestKey);
  });
  requests.set(requestKey, request);
  return { request, cache: "miss" };
}

/** Coalesces only overlapping role reads; callers choose fresh or cache-safe reads. */
export function fetchGuildRoleCoalesced(
  guild: Guild,
  roleId: string,
  options: GuildFetchOptions = { cache: true, force: true },
): Promise<Role | null> {
  const { request, cache } = getRoleRequest(guild, roleId, options);
  return observeLatency(
    "authorization.role.fetch",
    "guild-role",
    () => request.catch(() => null),
    { guildId: guild.id, cache },
  );
}

/** Preserves Discord errors for role recovery paths that inspect error codes. */
export function fetchGuildRoleCoalescedOrThrow(
  guild: Guild,
  roleId: string,
  options: GuildFetchOptions = { cache: true, force: true },
): Promise<Role | null> {
  const { request, cache } = getRoleRequest(guild, roleId, options);
  return observeLatency(
    "authorization.role.fetch",
    "guild-role",
    () => request,
    { guildId: guild.id, cache },
  );
}

function getRoleRequest(
  guild: Guild,
  roleId: string,
  options: GuildFetchOptions,
): RequestResult<Role | null> {
  let requests = roleRequests.get(guild);
  if (!requests) {
    requests = new Map();
    roleRequests.set(guild, requests);
  }
  const requestKey = `${roleId}:${options.force === true ? "forced" : "normal"}`;
  const existing = requests.get(requestKey);
  if (existing) return { request: existing, cache: "coalesced" };
  const request = fetchRole(guild, roleId, options).finally(() => {
    if (requests?.get(requestKey) === request) requests.delete(requestKey);
  });
  requests.set(requestKey, request);
  return { request, cache: "miss" };
}

/** Measures a bulk member read without introducing a completed member cache. */
export function fetchGuildMembers(
  guild: Guild,
): Promise<Collection<string, GuildMember> | null> {
  return observeLatency(
    "authorization.member.fetch",
    "guild-members",
    () => guild.members.fetch(),
    { guildId: guild.id, cache: "miss" },
  ).catch(() => null);
}

/** Measures a bulk role read without introducing a completed role cache. */
export function fetchGuildRoles(
  guild: Guild,
): Promise<Collection<string, Role> | null> {
  return observeLatency(
    "authorization.role.fetch",
    "guild-roles",
    () => guild.roles.fetch(),
    { guildId: guild.id, cache: "miss" },
  ).catch(() => null);
}

/**
 * Uses the already-known bot member when callers permit it, otherwise shares
 * one in-flight fetch. Forced and non-forced requests never share a promise.
 * No completed forced fetch is retained as an auth cache.
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
  let requests = botMemberRequests.get(guild);
  if (!requests) {
    requests = new Map();
    botMemberRequests.set(guild, requests);
  }
  const requestKey = options.force === true ? "forced" : "normal";
  const existing = requests.get(requestKey);
  const request =
    existing ??
    fetchBotMember(guild, options.force === true).finally(() => {
      if (requests?.get(requestKey) === request) requests.delete(requestKey);
    });
  if (!existing) requests.set(requestKey, request);
  return observeLatency(
    "authorization.bot-member.fetch",
    "current-bot-member",
    () => request.catch(() => null),
    { guildId: guild.id, cache: existing ? "coalesced" : "miss" },
  );
}

function fetchMember(
  guild: Guild,
  userId: string,
  options: GuildFetchOptions,
): Promise<GuildMember> {
  return options.input === "id"
    ? guild.members.fetch(userId)
    : guild.members.fetch({
        user: userId,
        cache: options.cache ?? true,
        force: options.force ?? true,
      });
}

function fetchRole(
  guild: Guild,
  roleId: string,
  options: GuildFetchOptions,
): Promise<Role | null> {
  return guild.roles.fetch(roleId, {
    cache: options.cache ?? true,
    force: options.force ?? true,
  });
}

function fetchBotMember(guild: Guild, force: boolean): Promise<GuildMember> {
  return force
    ? guild.members.fetchMe({ cache: true, force: true })
    : guild.members.fetchMe();
}
