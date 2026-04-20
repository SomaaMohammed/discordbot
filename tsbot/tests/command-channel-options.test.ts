import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../src/discord/commands.js";

type JsonOption = {
  name?: string;
  type?: number;
  options?: JsonOption[];
  channel_types?: number[];
};

type JsonCommand = {
  name?: string;
  options?: JsonOption[];
};

function findCommand(
  commands: JsonCommand[],
  commandName: string,
): JsonCommand {
  const command = commands.find((item) => item.name === commandName);
  if (!command) {
    throw new Error(`Missing command: ${commandName}`);
  }
  return command;
}

function findSubcommand(
  command: JsonCommand,
  subcommandName: string,
): JsonOption {
  const subcommand = command.options?.find(
    (item) => item.name === subcommandName,
  );
  if (!subcommand) {
    throw new Error(`Missing subcommand: ${subcommandName}`);
  }
  return subcommand;
}

function findOption(subcommand: JsonOption, optionName: string): JsonOption {
  const option = subcommand.options?.find((item) => item.name === optionName);
  if (!option) {
    throw new Error(`Missing option: ${optionName}`);
  }
  return option;
}

describe("channel option compatibility", () => {
  it("does not restrict channel option types on channel-taking commands", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];

    const targets: Array<[string, string, string]> = [
      ["court", "channel", "channel"],
      ["court", "logchannel", "channel"],
      ["invictus", "dmpanel", "channel"],
      ["invictus", "say", "channel"],
      ["invictus", "rolepanel", "channel"],
      ["invictus", "rolepanelmulti", "channel"],
    ];

    for (const [commandName, subcommandName, optionName] of targets) {
      const command = findCommand(commands, commandName);
      const subcommand = findSubcommand(command, subcommandName);
      const option = findOption(subcommand, optionName);

      expect(option.type).toBe(7);
      expect(option.channel_types).toBeUndefined();
    }
  });
});
