import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../src/discord/commands.js";

interface CommandOptionJson {
  readonly name?: string;
  readonly type?: number;
  readonly required?: boolean;
  readonly options?: readonly CommandOptionJson[];
}

interface CommandJson {
  readonly name?: string;
  readonly options?: readonly CommandOptionJson[];
}

describe("Discord command option ordering", () => {
  it("places every required option before optional options", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as CommandJson[];

    for (const command of commands) {
      assertRequiredOptionsComeFirst(
        command.options ?? [],
        `/${command.name ?? "unknown"}`,
      );
    }
  });
});

function assertRequiredOptionsComeFirst(
  options: readonly CommandOptionJson[],
  path: string,
): void {
  let optionalSeen = false;
  for (const option of options) {
    const optionPath = `${path} ${option.name ?? "unknown"}`;
    if (
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      assertRequiredOptionsComeFirst(option.options ?? [], optionPath);
      continue;
    }
    if (option.required === true) {
      expect(
        optionalSeen,
        `${optionPath} is required but follows an optional option`,
      ).toBe(false);
    } else {
      optionalSeen = true;
    }
  }
}
