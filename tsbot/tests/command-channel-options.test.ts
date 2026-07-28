import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../src/discord/commands.js";

type JsonOption = {
  name?: string;
  type?: number;
  options?: JsonOption[];
  channel_types?: number[];
  required?: boolean;
  max_length?: number;
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

describe("public command surface", () => {
  it("registers only the active command families", () => {
    const commandNames = buildCommandDefinitions().map(
      (command) => command.toJSON().name,
    );

    expect(commandNames).toEqual([
      "setup",
      "superior",
      "utility",
      "fun",
      "greetings",
    ]);
  });

  it("marks every slash command unavailable in DMs", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    );

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.dm_permission === false)).toBe(
      true,
    );
  });

  it("restricts persisted bindings while leaving transient targets flexible", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];

    const persistentTargets: Array<[string, string, string]> = [
      ["setup", "channel", "channel"],
    ];
    for (const [commandName, subcommandName, optionName] of persistentTargets) {
      const command = findCommand(commands, commandName);
      const subcommand = findSubcommand(command, subcommandName);
      const option = findOption(subcommand, optionName);

      expect(option.type).toBe(7);
      expect(option.channel_types).toEqual([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ]);
    }

    const transientTargets: Array<[string, string, string]> = [
      ["superior", "dmpanel", "channel"],
      ["superior", "say", "channel"],
      ["superior", "rolepanel", "channel"],
      ["superior", "rolepanelmulti", "channel"],
    ];

    for (const [commandName, subcommandName, optionName] of transientTargets) {
      const command = findCommand(commands, commandName);
      const subcommand = findSubcommand(command, subcommandName);
      const option = findOption(subcommand, optionName);

      expect(option.type).toBe(7);
      expect(option.channel_types).toBeUndefined();
    }
  });

  it("requires bounded inline text on /superior say", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];

    const superior = findCommand(commands, "superior");
    const say = findSubcommand(superior, "say");
    const message = findOption(say, "message");

    expect(message.type).toBe(3);
    expect(message.required).toBe(true);
  });

  it("bounds panel embed and button text to Discord limits", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];
    const superior = findCommand(commands, "superior");

    for (const name of ["dmpanel", "rolepanel", "rolepanelmulti"]) {
      const panel = findSubcommand(superior, name);
      expect(findOption(panel, "title").max_length).toBe(256);
      expect(findOption(panel, "description").max_length).toBe(4_096);
      if (name !== "rolepanelmulti") {
        expect(findOption(panel, "button_label").max_length).toBe(80);
      }
    }
  });

  it("does not register removed compatibility subcommands", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];
    const superiorSubcommands =
      findCommand(commands, "superior").options?.map(({ name }) => name) ?? [];
    const funSubcommands =
      findCommand(commands, "fun").options?.map(({ name }) => name) ?? [];

    expect(superiorSubcommands).toHaveLength(18);
    expect(superiorSubcommands).toEqual(
      expect.arrayContaining(["purge", "purgeuser", "backfillstats", "help"]),
    );
    expect(funSubcommands).toEqual(["battle", "stats", "leaderboard"]);
  });
});
