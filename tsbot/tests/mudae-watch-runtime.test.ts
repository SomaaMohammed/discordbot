import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_VERSION } from "../src/constants.js";
import { PRIVATE_MUDAE_WATCH_FILENAME } from "../src/mudae-watch-config.js";
import { createRuntime, type BotRuntime } from "../src/runtime.js";

const RECIPIENT_ID = "111111111111111111";
const MUDAE_BOT_ID = "222222222222222222";
const GUILD_ID = "333333333333333333";
const CHANNEL_ID = "444444444444444444";
const SERIES = "Private synthetic series";

const roots: string[] = [];
const runtimes: BotRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "superior-watch-runtime-"),
  );
  roots.push(root);
  return root;
}

function startRuntime(root: string): BotRuntime {
  const runtime = createRuntime(
    {
      discordToken: "synthetic-token",
      botVersion: `${PACKAGE_VERSION}-test`,
      dbFile: path.join(root, "superior.db"),
      commandRegistrationMode: "global",
      devGuildIds: [],
    },
    root,
  );
  runtimes.push(runtime);
  return runtime;
}

function validConfiguration(enabled = true): object {
  return {
    enabled,
    recipientUserId: RECIPIENT_ID,
    mudaeBotUserId: MUDAE_BOT_ID,
    locations: [{ guildId: GUILD_ID, channelIds: [CHANNEL_ID] }],
    series: [SERIES],
  };
}

describe("private watcher runtime loading", () => {
  it("quietly disables the watcher when the private file is missing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const runtime = startRuntime(temporaryRoot());

    expect(runtime.privateMudaeWatcher).toBeNull();
    const watcherLines = [
      ...log.mock.calls,
      ...warn.mock.calls,
      ...error.mock.calls,
    ]
      .flat()
      .map(String)
      .filter((line) => line.includes("[private-mudae-watch]"));
    expect(watcherLines).toEqual([]);
  });

  it("loads a valid private file and logs only bounded counts", () => {
    const root = temporaryRoot();
    fs.writeFileSync(
      path.join(root, PRIVATE_MUDAE_WATCH_FILENAME),
      JSON.stringify(validConfiguration()),
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = startRuntime(root);

    expect(runtime.privateMudaeWatcher?.enabled).toBe(true);
    expect(
      runtime.privateMudaeWatcher?.isConfiguredLocation(GUILD_ID, CHANNEL_ID),
    ).toBe(true);
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("Private watcher configuration loaded");
    expect(output).toContain("guildCount=1");
    expect(output).toContain("channelCount=1");
    expect(output).toContain("seriesCount=1");
    expect(output).not.toMatch(
      new RegExp(
        `${RECIPIENT_ID}|${MUDAE_BOT_ID}|${GUILD_ID}|${CHANNEL_ID}`,
        "u",
      ),
    );
    expect(output).not.toContain(SERIES);
  });

  it("fails safely and redacts malformed private configuration", () => {
    const root = temporaryRoot();
    fs.writeFileSync(
      path.join(root, PRIVATE_MUDAE_WATCH_FILENAME),
      JSON.stringify({ ...validConfiguration(), [RECIPIENT_ID]: SERIES }),
      "utf8",
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const runtime = startRuntime(root);

    expect(runtime.privateMudaeWatcher).toBeNull();
    const output = JSON.stringify(error.mock.calls);
    expect(output).toContain(
      "Private watcher configuration is invalid; watcher disabled",
    );
    expect(output).toContain("issueCount=1");
    expect(output).not.toContain(RECIPIENT_ID);
    expect(output).not.toContain(SERIES);
  });

  it("loads an explicitly disabled private configuration without monitoring", () => {
    const root = temporaryRoot();
    fs.writeFileSync(
      path.join(root, PRIVATE_MUDAE_WATCH_FILENAME),
      JSON.stringify(validConfiguration(false)),
      "utf8",
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const runtime = startRuntime(root);

    expect(runtime.privateMudaeWatcher?.enabled).toBe(false);
  });
});
