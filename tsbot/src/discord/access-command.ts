import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { CAPABILITY_CHOICES } from "./capabilities.js";

export const ACCESS_GRANT_PAGE_SIZE = 10;

export function buildAccessCommandDefinition(): SlashCommandSubcommandsOnlyBuilder {
  return new SlashCommandBuilder()
    .setName("access")
    .setDescription("Manage narrowly delegated Superior capabilities")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("grant")
        .setDescription("Grant one Superior capability to a server role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Server role receiving the capability")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("capability")
            .setDescription("Narrow capability to grant")
            .setRequired(true)
            .addChoices(...CAPABILITY_CHOICES),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("revoke")
        .setDescription("Revoke one Superior capability from a server role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Server role losing the capability")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("capability")
            .setDescription("Narrow capability to revoke")
            .setRequired(true)
            .addChoices(...CAPABILITY_CHOICES),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List active delegated role grants")
        .addIntegerOption((option) =>
          option
            .setName("page")
            .setDescription("Result page")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(1_000),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show Superior capabilities granted to one role")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Server role to inspect")
            .setRequired(true),
        ),
    );
}
