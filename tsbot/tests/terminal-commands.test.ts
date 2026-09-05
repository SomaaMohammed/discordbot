import { describe, expect, it } from "vitest";
import { parseTerminalCommandLine } from "../src/terminal-commands.js";

const GUILD = "123456789012345678";
const MEMBER = "234567890123456789";
const ACTOR = "345678901234567890";

describe("terminal timeout commands", () => {
  it("parses the untimeout command and quoted reason", () => {
    expect(
      parseTerminalCommandLine(
        `untimeout --guild ${GUILD} --member ${MEMBER} --actor ${ACTOR} --reason "manual review completed"`,
      ),
    ).toEqual({
      kind: "untimeout",
      guildId: GUILD,
      memberId: MEMBER,
      actorId: ACTOR,
      reason: "manual review completed",
    });
  });

  it("accepts unmute as an alias", () => {
    expect(
      parseTerminalCommandLine(
        `unmute --guild=${GUILD} --member=${MEMBER} --actor=${ACTOR} --reason=restored`,
      ),
    ).toMatchObject({ kind: "untimeout", reason: "restored" });
  });

  it("requires the explicit actor and reason", () => {
    expect(() =>
      parseTerminalCommandLine(`untimeout --guild ${GUILD} --member ${MEMBER}`),
    ).toThrow(/--actor/);
    expect(() =>
      parseTerminalCommandLine(
        `untimeout --guild ${GUILD} --member ${MEMBER} --actor ${ACTOR}`,
      ),
    ).toThrow(/--reason/);
  });
});
