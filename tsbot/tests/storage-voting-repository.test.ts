import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
const CHANNEL_A = "333333333333333333";
const CHANNEL_B = "444444444444444444";
const CREATOR = "555555555555555555";
const VOTER_A = "666666666666666666";
const VOTER_B = "777777777777777777";
const roots: string[] = [];
const openStores: BotStorage[] = [];

afterEach(() => {
  for (const storage of openStores.splice(0)) storage.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("persistent voting-panel storage", () => {
  it("persists panels, voter selections, and due work across a restart", () => {
    const dbFile = makeDatabase();
    const storage = openStorage(dbFile, GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    const created = guild.createVotingPanel(
      votingInput({
        voteId: "vote_restart",
        deadlineAt: "2026-01-01T00:00:00+03:00",
      }),
    );
    expect(created.deadlineAt).toBe("2025-12-31T21:00:00.000Z");
    expect(
      guild.selectVotingPanelOption("vote_restart", VOTER_A, "option_yes"),
    ).toMatchObject({
      status: "changed",
      optionIds: ["option_yes"],
    });
    storage.close();

    const reopened = openStorage(dbFile, GUILD_A);
    const afterRestart = reopened.forGuild(GUILD_A);
    expect(afterRestart.getVotingPanel("vote_restart")).toMatchObject({
      voteId: "vote_restart",
      status: "active",
      totalVoters: 1,
      options: [
        { optionId: "option_yes", label: "Yes", voteCount: 1 },
        { optionId: "option_no", label: "No", voteCount: 0 },
      ],
    });
    expect(
      afterRestart.listDueVotingPanels("2025-12-31T21:00:00.000Z"),
    ).toHaveLength(1);
    expect(
      afterRestart.transitionVotingPanel(
        "vote_restart",
        "completed",
        CREATOR,
        "2026-01-01T00:00:00.000Z",
      ),
    ).toMatchObject({ status: "transitioned", panel: { status: "completed" } });
    expect(afterRestart.countActiveVotingPanels(CHANNEL_A)).toBe(0);
    reopened.close();
  });

  it("replaces single selections and atomically toggles multi-select choices", () => {
    const storage = openStorage(makeDatabase(), GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.createVotingPanel(votingInput({ voteId: "vote_single" }));
    expect(
      guild.selectVotingPanelOption("vote_single", VOTER_A, "option_yes"),
    ).toMatchObject({ status: "changed", optionIds: ["option_yes"] });
    expect(
      guild.selectVotingPanelOption("vote_single", VOTER_A, "option_no"),
    ).toMatchObject({ status: "changed", optionIds: ["option_no"] });
    expect(guild.getVotingPanelSelection("vote_single", VOTER_A)).toEqual([
      "option_no",
    ]);

    guild.createVotingPanel(
      votingInput({
        voteId: "vote_multi",
        channelId: CHANNEL_B,
        pollType: "custom",
        multiSelect: true,
        options: [
          { optionId: "option_red", label: "Red" },
          { optionId: "option_blue", label: "Blue" },
          { optionId: "option_green", label: "Green" },
        ],
      }),
    );
    guild.toggleVotingPanelOption("vote_multi", VOTER_A, "option_red");
    guild.toggleVotingPanelOption("vote_multi", VOTER_A, "option_blue");
    expect(guild.getVotingPanelSelection("vote_multi", VOTER_A)).toEqual([
      "option_red",
      "option_blue",
    ]);
    guild.toggleVotingPanelOption("vote_multi", VOTER_A, "option_red");
    expect(guild.getVotingPanelSelection("vote_multi", VOTER_A)).toEqual([
      "option_blue",
    ]);
    guild.toggleVotingPanelOption("vote_multi", VOTER_A, "option_blue");
    expect(guild.getVotingPanelSelection("vote_multi", VOTER_A)).toEqual([]);
    storage.close();
  });

  it("groups current voter identities by their selected options", () => {
    const storage = openStorage(makeDatabase(), GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    guild.createVotingPanel(
      votingInput({
        voteId: "vote_voters",
        pollType: "custom",
        multiSelect: true,
        options: [
          { optionId: "option_alpha", label: "Alpha" },
          { optionId: "option_beta", label: "Beta" },
        ],
      }),
    );
    guild.toggleVotingPanelOption("vote_voters", VOTER_A, "option_alpha");
    guild.toggleVotingPanelOption("vote_voters", VOTER_A, "option_beta");
    guild.toggleVotingPanelOption("vote_voters", VOTER_B, "option_beta");
    expect(guild.listVotingPanelVoters("vote_voters")).toEqual([
      expect.objectContaining({
        voterId: VOTER_A,
        optionIds: ["option_alpha", "option_beta"],
      }),
      expect.objectContaining({ voterId: VOTER_B, optionIds: ["option_beta"] }),
    ]);
    expect(guild.getVotingPanel("vote_voters")).toMatchObject({
      totalVoters: 2,
      options: [
        { optionId: "option_alpha", voteCount: 1 },
        { optionId: "option_beta", voteCount: 2 },
      ],
    });
    storage.close();
  });

  it("enforces five active votes per channel and releases the slot on cancellation", () => {
    const storage = openStorage(makeDatabase(), GUILD_A);
    const guild = storage.forGuild(GUILD_A);
    for (let index = 1; index <= 5; index += 1) {
      guild.createVotingPanel(
        votingInput({
          voteId: `vote_limit_${index}`,
          messageId: `88888888888888888${index}`,
        }),
      );
    }
    expect(() =>
      guild.createVotingPanel(votingInput({ voteId: "vote_limit_six" })),
    ).toThrow(/at most 5 active voting panels/i);
    guild.transitionVotingPanel(
      "vote_limit_1",
      "cancelled",
      CREATOR,
      "2026-01-01T00:00:00.000Z",
    );
    expect(() =>
      guild.createVotingPanel(votingInput({ voteId: "vote_limit_six" })),
    ).not.toThrow();
    storage.close();
  });

  it("isolates vote records by guild and keeps terminal transitions idempotent", () => {
    const storage = openStorage(makeDatabase(), GUILD_A, GUILD_B);
    const left = storage.forGuild(GUILD_A);
    const right = storage.forGuild(GUILD_B);
    left.createVotingPanel(votingInput({ voteId: "vote_shared" }));
    right.createVotingPanel(votingInput({ voteId: "vote_shared" }));
    expect(right.getVotingPanel("vote_shared")?.guildId).toBe(GUILD_B);
    expect(
      left.transitionVotingPanel(
        "vote_shared",
        "completed",
        CREATOR,
        "2026-01-01T00:00:00.000Z",
      ).status,
    ).toBe("transitioned");
    expect(
      left.transitionVotingPanel(
        "vote_shared",
        "completed",
        CREATOR,
        "2026-01-01T00:01:00.000Z",
      ).status,
    ).toBe("already-transitioned");
    expect(
      left.transitionVotingPanel(
        "vote_shared",
        "cancelled",
        CREATOR,
        "2026-01-01T00:01:00.000Z",
      ).status,
    ).toBe("conflict");
    storage.close();
  });
});

function votingInput(overrides: Record<string, unknown> = {}) {
  return {
    voteId: "vote_default",
    channelId: CHANNEL_A,
    messageId: "888888888888888888",
    creatorId: CREATOR,
    question: "Should the council approve this proposal?",
    title: "Council vote",
    description: "Vote once the proposal has been reviewed.",
    pollType: "yes-no" as const,
    multiSelect: false,
    options: [
      { optionId: "option_yes", label: "Yes" },
      { optionId: "option_no", label: "No" },
    ],
    mentionEveryoneOnCreation: false,
    mentionEveryoneOnCompletion: false,
    ...overrides,
  };
}

function makeDatabase(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-voting-store-"));
  roots.push(root);
  return path.join(root, "votes.db");
}

function openStorage(dbFile: string, ...guildIds: string[]): BotStorage {
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  for (const guildId of guildIds) storage.ensureGuild(guildId);
  openStores.push(storage);
  return storage;
}
