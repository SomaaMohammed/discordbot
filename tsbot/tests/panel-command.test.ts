import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildPanelCommandDefinition } from "../src/discord/panel-command.js";
import {
  PANEL_PRESETS,
  RESOURCE_PANEL_LIMITS,
} from "../src/discord/panel-theme.js";

interface CommandOptionJson {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  min_value?: number;
  max_value?: number;
  choices?: Array<{ name: string; value: string }>;
  options?: CommandOptionJson[];
}

function findSubcommand(name: string): CommandOptionJson {
  const command = buildPanelCommandDefinition().toJSON();
  const option = command.options?.find((candidate) => candidate.name === name);
  if (!option) throw new Error(`Missing /panel ${name}`);
  return option as CommandOptionJson;
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

describe("/panel command definition", () => {
  it("is guild-only, delegate-discoverable, and has clear subcommands", () => {
    const command = buildPanelCommandDefinition().toJSON();

    expect(command.name).toBe("panel");
    expect(command.description).toMatch(/Superior server panels/i);
    expect(command.dm_permission).toBe(false);
    expect(command.default_member_permissions).toBeUndefined();
    expect(command.options?.map(({ name }) => name)).toEqual([
      "list",
      "post",
      "help",
      "vote",
      "status",
    ]);
    expect(findSubcommand("list").description).toMatch(/presets/i);
    expect(findSubcommand("status").description).toMatch(/ticket-panel/i);
  });

  it("defines every preset for posting in the current channel", () => {
    const post = findSubcommand("post");
    const preset = findOption(post, "preset");

    expect(preset.type).toBe(ApplicationCommandOptionType.String);
    expect(preset.required).toBe(true);
    expect(preset.choices?.map(({ value }) => value)).toEqual(PANEL_PRESETS);
    expect(preset.choices).toHaveLength(PANEL_PRESETS.length);
    expect(preset.choices?.map(({ value }) => value)).toEqual(
      expect.arrayContaining(["verification", "roles"]),
    );
    expect(post.options?.some(({ name }) => name === "channel")).toBe(false);
  });

  it("exposes bounded resource fields, a role-menu binding, and five link pairs", () => {
    const post = findSubcommand("post");
    expect(post.options).toHaveLength(15);

    expect(findOption(post, "resource_title")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      min_length: 1,
      max_length: RESOURCE_PANEL_LIMITS.title,
    });
    expect(findOption(post, "resource_body")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      min_length: 1,
      max_length: RESOURCE_PANEL_LIMITS.body,
    });
    expect(findOption(post, "role_menu")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      min_length: 1,
      max_length: 32,
    });
    for (let index = 1; index <= RESOURCE_PANEL_LIMITS.links; index += 1) {
      expect(findOption(post, `link_${index}_label`)).toMatchObject({
        type: ApplicationCommandOptionType.String,
        required: false,
        min_length: 1,
        max_length: RESOURCE_PANEL_LIMITS.linkLabel,
      });
      expect(findOption(post, `link_${index}_url`)).toMatchObject({
        type: ApplicationCommandOptionType.String,
        required: false,
        min_length: 1,
        max_length: RESOURCE_PANEL_LIMITS.linkUrl,
      });
    }
  });

  it("provides an explicit safe-replacement flag", () => {
    expect(
      findOption(findSubcommand("post"), "replace_existing"),
    ).toMatchObject({
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    });
  });

  it("registers the complete one-step voting configuration", () => {
    const vote = findSubcommand("vote");

    expect(vote.options?.map(({ name }) => name)).toEqual([
      "question",
      "title",
      "description",
      "poll_type",
      "options",
      "multi_select",
      "duration_minutes",
      "mention_everyone_on_creation",
      "mention_everyone_on_completion",
    ]);
    expect(findOption(vote, "question")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: true,
      min_length: 1,
      max_length: 256,
    });
    expect(findOption(vote, "title")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      min_length: 1,
      max_length: 256,
    });
    expect(findOption(vote, "description")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      min_length: 1,
      max_length: 4_096,
    });
    expect(findOption(vote, "poll_type")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: true,
      choices: [
        { name: "Yes / No", value: "yes-no" },
        { name: "Custom options", value: "custom" },
      ],
    });
    expect(findOption(vote, "options")).toMatchObject({
      type: ApplicationCommandOptionType.String,
      required: false,
      max_length: 1_000,
    });
    for (const name of [
      "multi_select",
      "mention_everyone_on_creation",
      "mention_everyone_on_completion",
    ]) {
      expect(findOption(vote, name)).toMatchObject({
        type: ApplicationCommandOptionType.Boolean,
        required: true,
      });
    }
    expect(findOption(vote, "duration_minutes")).toMatchObject({
      type: ApplicationCommandOptionType.Integer,
      required: true,
      min_value: 0,
      max_value: 20_160,
    });
    expect(findSubcommand("help").description).toMatch(/guide/i);
  });

  it("stays within Discord command, option, choice, and text limits", () => {
    const command = buildPanelCommandDefinition().toJSON();
    const subcommands = command.options as CommandOptionJson[] | undefined;
    expect(command.name.length).toBeLessThanOrEqual(32);
    expect(command.description.length).toBeLessThanOrEqual(100);
    expect(subcommands?.length ?? 0).toBeLessThanOrEqual(25);

    for (const subcommand of subcommands ?? []) {
      expect(subcommand.name.length).toBeLessThanOrEqual(32);
      expect(subcommand.description.length).toBeLessThanOrEqual(100);
      expect(subcommand.options?.length ?? 0).toBeLessThanOrEqual(25);
      for (const option of subcommand.options ?? []) {
        expect(option.name.length).toBeLessThanOrEqual(32);
        expect(option.description.length).toBeLessThanOrEqual(100);
        if ("choices" in option && option.choices) {
          expect(option.choices.length).toBeLessThanOrEqual(25);
          for (const choice of option.choices) {
            expect(choice.name.length).toBeLessThanOrEqual(100);
            expect(String(choice.value).length).toBeLessThanOrEqual(100);
          }
        }
      }
    }
  });
});
