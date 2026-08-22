import {
  PermissionFlagsBits,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import {
  authorizeConfiguredRoleOrCapability,
  type CapabilityGrantReader,
} from "./authorization.js";

export type ContentDestinationBoundary =
  | "content-authorized"
  | "isolated"
  | "visible-without-authority"
  | "unverifiable";

/**
 * Prevents a configuration-only delegate from routing future private content
 * into a channel they can already read unless they also hold the workflow's
 * configured-role or delegated content authority.
 */
export async function inspectContentDestinationBoundary(options: {
  guild: Guild;
  userId: string;
  capability:
    | "tickets.manage"
    | "applications.review"
    | "reports.review"
    | "appeals.review";
  configuredRoleId: string | null;
  grants: CapabilityGrantReader;
  channel: GuildTextBasedChannel;
}): Promise<ContentDestinationBoundary> {
  if (options.channel.guild.id !== options.guild.id) return "unverifiable";
  const decision = await authorizeConfiguredRoleOrCapability({
    guild: options.guild,
    userId: options.userId,
    capability: options.capability,
    configuredRoleId: options.configuredRoleId,
    configuredRoleReason:
      options.capability === "tickets.manage"
        ? "support-role"
        : "reviewer-role",
    grants: options.grants,
  });
  if (decision.allowed) return "content-authorized";
  if (!decision.member) return "unverifiable";
  const permissions = options.channel.permissionsFor(decision.member);
  if (!permissions) return "unverifiable";
  return permissions.has(PermissionFlagsBits.ViewChannel)
    ? "visible-without-authority"
    : "isolated";
}
