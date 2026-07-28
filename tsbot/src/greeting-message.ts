import { escapeMarkdown } from "discord.js";

export const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;

const MAX_DISCORD_SNOWFLAKE = "9".repeat(20);

export function renderGreetingMessage(
  template: string,
  userId: string,
): string {
  return escapeMarkdown(template).replaceAll("{user}", `<@${userId}>`);
}

export function isGreetingTemplateWithinDiscordLimit(
  template: string,
): boolean {
  return (
    renderGreetingMessage(template, MAX_DISCORD_SNOWFLAKE).length <=
    DISCORD_MESSAGE_CONTENT_LIMIT
  );
}

export function truncateDiscordContent(
  content: string,
  limit = DISCORD_MESSAGE_CONTENT_LIMIT,
): string {
  if (content.length <= limit) return content;
  if (limit <= 0) return "";
  if (limit === 1) return "…";

  let prefix = content.slice(0, limit - 1);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}…`;
}
