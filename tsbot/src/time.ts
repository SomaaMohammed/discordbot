import { DateTime, Duration } from "luxon";

export function getNow(timezoneName: string): DateTime {
  const candidate = DateTime.now().setZone(timezoneName);
  if (candidate.isValid) {
    return candidate;
  }
  return DateTime.local();
}

export function isoNow(timezoneName: string): string {
  return getNow(timezoneName).toISO() ?? new Date().toISOString();
}

export function parseIso(value: string | null | undefined): DateTime | null {
  if (!value) {
    return null;
  }
  const parsed = DateTime.fromISO(value);
  return parsed.isValid ? parsed : null;
}

export function formatDuration(duration: Duration): string {
  const totalSeconds = Math.max(Math.floor(duration.as("seconds")), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function getWeekKey(now: DateTime): string {
  return `${now.weekYear}-W${String(now.weekNumber).padStart(2, "0")}`;
}
