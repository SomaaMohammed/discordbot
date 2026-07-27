import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { __canTimeoutTargetForTests } from "../src/discord/runtime-parity.js";

const ACTOR_ID = "111111111111111111";
const BOT_ID = "222222222222222222";
const TARGET_ID = "333333333333333333";

function fixtures(options: {
  moderateMembers: boolean;
  moderatable: boolean;
}): { actor: GuildMember; me: GuildMember; target: GuildMember } {
  const guild = { ownerId: "999999999999999999" };
  const highest = { comparePositionTo: vi.fn(() => 1) };
  const actor = {
    id: ACTOR_ID,
    guild,
    roles: { highest },
  } as unknown as GuildMember;
  const me = {
    id: BOT_ID,
    guild,
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.ModerateMembers &&
          options.moderateMembers,
      ),
    },
    roles: { highest },
  } as unknown as GuildMember;
  const target = {
    id: TARGET_ID,
    guild,
    user: { bot: false },
    roles: { highest: {} },
    moderatable: options.moderatable,
  } as unknown as GuildMember;
  return { actor, me, target };
}

describe("Invictus reply moderation eligibility", () => {
  it("requires the bot's Moderate Members permission", () => {
    const { actor, me, target } = fixtures({
      moderateMembers: false,
      moderatable: true,
    });

    expect(__canTimeoutTargetForTests(actor, me, target)).toEqual([
      false,
      "bot lacks Moderate Members permission",
    ]);
  });

  it("rejects a target Discord reports as non-moderatable", () => {
    const { actor, me, target } = fixtures({
      moderateMembers: true,
      moderatable: false,
    });

    expect(__canTimeoutTargetForTests(actor, me, target)).toEqual([
      false,
      "target is not moderatable by the bot",
    ]);
  });
});
