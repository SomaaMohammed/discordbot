import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../src/discord/commands.js";

type JsonOption = {
  name?: string;
  type?: number;
  options?: JsonOption[];
  channel_types?: number[];
  required?: boolean;
  min_length?: number;
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
      "config",
      "data",
      "operator",
      "help",
      "channel",
      "timeout",
      "activity",
      "panel",
      "ticket",
      "suggestion",
      "application",
      "moderation",
      "report",
      "appeal",
      "automod",
      "onboarding",
      "rolemenu",
      "access",
      "pingrole",
      "restrictedping",
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

  it("keeps non-panel target channels while panels always use the current channel", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];

    const persistentTextTargets: Array<[string, string, string]> = [
      ["config", "log", "channel"],
    ];
    for (const [
      commandName,
      subcommandName,
      optionName,
    ] of persistentTextTargets) {
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
      ["channel", "announce", "channel"],
    ];

    for (const [commandName, subcommandName, optionName] of transientTargets) {
      const command = findCommand(commands, commandName);
      const subcommand = findSubcommand(command, subcommandName);
      const option = findOption(subcommand, optionName);

      expect(option.type).toBe(7);
      expect(option.channel_types).toBeUndefined();
    }

    const panel = findCommand(commands, "panel");
    expect(
      findSubcommand(panel, "post").options?.some(
        ({ name }) => name === "channel",
      ),
    ).toBe(false);
    for (const subcommandName of ["dmpanel", "role-button", "role-buttons"]) {
      expect(
        findSubcommand(panel, subcommandName).options?.some(
          ({ name }) => name === "channel",
        ),
      ).toBe(false);
    }
    for (const [commandName, subcommandName] of [
      ["ticket", "panel"],
      ["suggestion", "panel"],
      ["application", "panel"],
      ["onboarding", "panel"],
      ["rolemenu", "post"],
      ["rolemenu", "recover"],
    ] as const) {
      expect(
        findSubcommand(
          findCommand(commands, commandName),
          subcommandName,
        ).options?.some(({ name }) => name === "channel"),
      ).toBe(false);
    }
  });

  it("requires bounded inline text on /channel announce", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];

    const channel = findCommand(commands, "channel");
    const say = findSubcommand(channel, "announce");
    const message = findOption(say, "message");

    expect(message.type).toBe(3);
    expect(message.required).toBe(true);
  });

  it("bounds panel embed and button text to Discord limits", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];
    const panel = findCommand(commands, "panel");

    for (const name of ["dmpanel", "role-button", "role-buttons"]) {
      const panel = findSubcommand(findCommand(commands, "panel"), name);
      expect(findOption(panel, "title").max_length).toBe(256);
      expect(findOption(panel, "description").max_length).toBe(4_096);
      if (name !== "role-buttons") {
        expect(findOption(panel, "button_label").max_length).toBe(80);
      }
    }
  });

  it("exposes bounded onboarding and persistent role-menu options", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];
    const onboarding = findCommand(commands, "onboarding");
    const roleMenu = findCommand(commands, "rolemenu");

    expect(onboarding.options?.map(({ name }) => name)).toEqual([
      "status",
      "configure",
      "welcome",
      "farewell",
      "rules",
      "verification",
      "autorole",
      "panel",
      "member",
      "recover",
      "disable",
    ]);
    for (const name of ["welcome", "farewell", "rules"]) {
      const subcommand = findSubcommand(onboarding, name);
      expect(findOption(subcommand, "title").max_length).toBe(256);
      expect(findOption(subcommand, "body").max_length).toBe(4_096);
    }

    expect(roleMenu.options?.map(({ name }) => name)).toEqual([
      "list",
      "create",
      "edit",
      "option",
      "post",
      "status",
      "enable",
      "disable",
      "archive",
      "recover",
    ]);
    const slug = findOption(findSubcommand(roleMenu, "create"), "slug");
    expect(slug).toMatchObject({
      type: 3,
      required: true,
      min_length: 2,
      max_length: 32,
    });
  });

  it("does not register the removed legacy family or old fun copies", () => {
    const commands = buildCommandDefinitions().map((command) =>
      command.toJSON(),
    ) as JsonCommand[];
    const funSubcommands =
      findCommand(commands, "fun").options?.map(({ name }) => name) ?? [];

    expect(commands.map(({ name }) => name)).not.toContain("superior");
    expect(funSubcommands).toEqual(["battle"]);
    expect(
      findCommand(commands, "activity").options?.map(({ name }) => name),
    ).toEqual(["stats", "leaderboard", "backfill", "backfill-status"]);
    expect(
      findCommand(commands, "channel").options?.map(({ name }) => name),
    ).toEqual([
      "announce",
      "purge",
      "purge-member",
      "lock",
      "unlock",
      "slowmode",
    ]);
    expect(
      findCommand(commands, "timeout").options?.map(({ name }) => name),
    ).toEqual([
      "set",
      "remove",
      "set-many",
      "remove-many",
      "set-all",
      "remove-all",
    ]);
  });
});
