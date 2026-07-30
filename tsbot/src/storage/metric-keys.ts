import { assertDiscordSnowflake } from "../guild-settings.js";
import { USER_ACTIVITY_METRICS, type UserActivityMetric } from "../types.js";

const USER_ACTIVITY_METRIC_SET = new Set<string>(USER_ACTIVITY_METRICS);
const COMMAND_METRIC_PATTERN =
  /^command_(?:usage|failures)\.(?:setup|superior|panel|ticket|utility|fun|greetings)\.[a-z0-9][a-z0-9._-]*$/;
const USER_METRIC_PATTERN =
  /^user_stats\.(\d{17,20})\.(messages_sent|reactions_sent|reactions_received|battles_played|battles_won)$/;

export function isActiveMetricKey(key: string): boolean {
  return COMMAND_METRIC_PATTERN.test(key) || USER_METRIC_PATTERN.test(key);
}

export function assertActiveMetricKey(key: string): string {
  const normalized = String(key).trim();
  if (!isActiveMetricKey(normalized)) {
    throw new TypeError(`Unsupported active metric key: ${normalized}`);
  }
  return normalized;
}

export function assertUserActivityMetric(metric: string): UserActivityMetric {
  if (!USER_ACTIVITY_METRIC_SET.has(metric)) {
    throw new TypeError(`Unsupported user activity metric: ${metric}`);
  }
  return metric as UserActivityMetric;
}

export function buildUserMetricKey(
  userId: string,
  metric: UserActivityMetric,
): string {
  return `user_stats.${assertDiscordSnowflake(userId, "user ID")}.${assertUserActivityMetric(metric)}`;
}

export function commandMetricKey(commandName: string, failure = false): string {
  const normalized = String(commandName).trim().toLowerCase();
  const key = `command_${failure ? "failures" : "usage"}.${normalized}`;
  return assertActiveMetricKey(key);
}
