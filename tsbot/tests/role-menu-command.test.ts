import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildRoleMenuCommandDefinition } from "../src/discord/role-menu-command.js";

interface CommandOptionJson {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly min_value?: number;
  readonly max_value?: number;
  readonly options?: readonly CommandOptionJson[];
}

function findSubcommand(name: string): CommandOptionJson {
  const command = buildRoleMenuCommandDefinition().toJSON();
  const subcommand = command.options?.find((option) => option.name === name);
  if (!subcommand) throw new Error(`Missing /rolemenu ${name}`);
  return subcommand as CommandOptionJson;
}

function findOption(
  subcommand: CommandOptionJson,
  name: string,
): CommandOptionJson {
  const option = subcommand.options?.find(
    (candidate) => candidate.name === name,
  );
  if (!option) throw new Error(`Missing option ${name}`);
  return option;
}

describe("/rolemenu command definition", () => {
  it.each(["create", "edit"])(
    "offers a bounded optional one-based position on %s",
    (subcommandName) => {
      expect(
        findOption(findSubcommand(subcommandName), "position"),
      ).toMatchObject({
        type: ApplicationCommandOptionType.Integer,
        required: false,
        min_value: 1,
        max_value: 25,
      });
    },
  );
});
