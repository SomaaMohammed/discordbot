import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect((await runtime.forGuild(GUILD_A))?.isCurrent()).toBe(true);
  });

  it("detects optimistic settings conflicts instead of overwriting", async () => {
    const runtime = createTestRuntime();
    approveAndEnable(runtime, GUILD_A);
    const first = await runtime.forGuild(GUILD_A);
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
