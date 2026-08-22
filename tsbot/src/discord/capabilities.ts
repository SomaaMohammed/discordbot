import {
  GUILD_CAPABILITIES,
  type GuildCapability,
  type RoleCapabilityGrant,
} from "../types.js";

export { GUILD_CAPABILITIES };
export type { GuildCapability, RoleCapabilityGrant };

export const CAPABILITY_DESCRIPTIONS: Readonly<
  Record<GuildCapability, string>
> = Object.freeze({
  "panels.manage": "Post and refresh Superior panels",
  "tickets.configure": "Configure ticket departments and launchers",
  "tickets.manage": "Manage and recover ticket contents",
  "suggestions.configure": "Configure the suggestion service",
  "suggestions.review": "Review and decide suggestions",
  "applications.configure": "Configure staff application forms",
  "applications.review": "Review and decide staff applications",
  "moderation.configure": "Configure moderation and safety services",
  "moderation.manage": "Manage moderation cases and member sanctions",
  "reports.review": "Review and decide private member reports",
  "appeals.review": "Review and decide case appeals",
});

export const CAPABILITY_CHOICES = GUILD_CAPABILITIES.map((capability) => ({
  name: capability,
  value: capability,
}));

export function isGuildCapability(value: unknown): value is GuildCapability {
  return (
    typeof value === "string" &&
    (GUILD_CAPABILITIES as readonly string[]).includes(value)
  );
}
