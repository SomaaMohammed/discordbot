import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type BotRuntime } from "../src/runtime.js";
import { GuildSettingsConflictError } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const roots: string[] = [];
const runtimes: BotRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTestRuntime(): BotRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-runtime-"));
  roots.push(root);
  const runtime = createRuntime({
    discordToken: "synthetic-token",
    botVersion: "5.0.0-test",
    dbFile: path.join(root, "superior.db"),
    commandRegistrationMode: "global",
    devGuildIds: [],
    operatorIds: [],
  });
  runtimes.push(runtime);
  return runtime;
}

function approveAndEnable(runtime: BotRuntime, guildId: string): void {
  runtime.storage.ensureGuild(guildId, `Guild ${guildId}`);
}

describe("runtime tenant isolation", () => {
  it("keeps settings and metrics scoped to one guild", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    approveAndEnable(runtime, GUILD_B);
    const a = await runtime.forGuild(GUILD_A);
    const b = await runtime.forGuild(GUILD_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    a!.storage.recordCommandMetric("utility.ping");
    expect(a!.storage.metricsGet("command_usage.utility.ping", "0")).toBe("1");
    expect(b!.storage.metricsGet("command_usage.utility.ping", "0")).toBe("0");
  });

  it("invalidates only existing snapshots for the selected guild", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    approveAndEnable(runtime, GUILD_B);
    const oldA = await runtime.forGuild(GUILD_A);
    const oldB = await runtime.forGuild(GUILD_B);
    runtime.invalidateGuild(GUILD_A);

    expect(oldA?.isCurrent()).toBe(false);
    expect(oldB?.isCurrent()).toBe(true);
    const refreshedA = await runtime.forGuild(GUILD_A);
    expect(refreshedA?.isCurrent()).toBe(true);
    expect(refreshedA).not.toBe(oldA);
  });

  it("reuses the same runtime instance until its guild is invalidated", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);

    const first = await runtime.forGuild(GUILD_A);
    const second = await runtime.forGuild(GUILD_A);

    expect(second).toBe(first);
    runtime.invalidateGuild(GUILD_A);
    expect(await runtime.forGuild(GUILD_A)).not.toBe(first);
  });

  it("coalesces concurrent runtime loads for one guild", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    const load = vi.spyOn(runtime.storage, "getGuildEnableExpectation");

    const loaded = await Promise.all([
      runtime.forGuild(GUILD_A),
      runtime.forGuild(GUILD_A),
      runtime.forGuild(GUILD_A),
    ]);

    expect(loaded[0]).not.toBeNull();
    expect(loaded[1]).toBe(loaded[0]);
    expect(loaded[2]).toBe(loaded[0]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("invalidates the cached runtime after a settings write", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    const first = await runtime.forGuild(GUILD_A);

    await first!.saveSettings({
      ...first!.settings,
      timezone: "Europe/London",
    });
    const refreshed = await runtime.forGuild(GUILD_A);

    expect(refreshed).not.toBe(first);
    expect(refreshed?.settings.timezone).toBe("Europe/London");
  });

  it("invalidates only the mutated guild after a scoped configuration write", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    approveAndEnable(runtime, GUILD_B);
    const firstA = await runtime.forGuild(GUILD_A);
    const firstB = await runtime.forGuild(GUILD_B);

    firstA!.storage.upsertSuggestionConfiguration({
      suggestionChannelId: "333333333333333333",
      reviewerRoleId: "444444444444444444",
    });

    expect(firstA!.isCurrent()).toBe(false);
    expect(firstB!.isCurrent()).toBe(true);
    expect(await runtime.forGuild(GUILD_A)).not.toBe(firstA);
    expect(await runtime.forGuild(GUILD_B)).toBe(firstB);
  });

  it("detects optimistic settings conflicts instead of overwriting", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    const first = await runtime.forGuild(GUILD_A);
    runtime.invalidateGuild(GUILD_A);
    const second = await runtime.forGuild(GUILD_A);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await first!.saveSettings({ ...first!.settings, timezone: "Asia/Amman" });
    await expect(
      second!.saveSettings({ ...second!.settings, timezone: "Europe/London" }),
    ).rejects.toBeInstanceOf(GuildSettingsConflictError);
  });

  it("rejects malformed guild IDs before touching storage", async () => {
    const runtime = createTestRuntime();
    await expect(runtime.forGuild("not-a-snowflake")).resolves.toBeNull();
  });
});
