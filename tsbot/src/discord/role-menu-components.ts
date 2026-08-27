import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  escapeMarkdown,
  type MessageMentionOptions,
} from "discord.js";
import { safeUnicodeEmoji } from "../unicode-emoji.js";
import {
  createSuperiorEmbed,
  setPanelInstructionFooter,
} from "./panel-theme.js";

export const ROLE_MENU_CUSTOM_ID_PREFIX = "superior:rolemenu:";
export const ROLE_MENU_LIMITS = Object.freeze({
  menusPerGuild: 25,
  optionsPerMenu: 25,
  slug: 32,
  title: 256,
  description: 1_000,
  optionLabel: 100,
  optionDescription: 100,
});

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{8,24}$/u;

export type RoleMenuSelectionMode = "toggle" | "exclusive" | "limited";
export type RoleMenuState = "disabled" | "enabled" | "archived";
export type RoleMenuPostState = "active" | "missing" | "stale";

export interface RoleMenuView {
  readonly guildId: string;
  readonly menuId: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly state: RoleMenuState;
  readonly mode: RoleMenuSelectionMode;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly requiredRoleId: string | null;
  readonly definitionVersion: number;
  readonly bindingsVerifiedAt: string | null;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleMenuOptionView {
  readonly guildId: string;
  readonly menuId: string;
  readonly optionId: string;
  readonly roleId: string;
  readonly label: string;
  readonly description: string | null;
  readonly emoji: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoleMenuPostView {
  readonly guildId: string;
  readonly postId: string;
  readonly menuId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly definitionVersion: number;
  readonly bindingsVerifiedAt: string | null;
  readonly state: RoleMenuPostState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedRoleMenuCustomId {
  readonly menuId: string;
  readonly postId: string;
  readonly definitionVersion: number;
}

export interface RoleMenuPanelPayload {
  readonly embeds: readonly ReturnType<typeof createSuperiorEmbed>[];
  readonly components: readonly ActionRowBuilder<StringSelectMenuBuilder>[];
  readonly allowedMentions: Readonly<MessageMentionOptions>;
}

export function createRoleMenuCustomId(
  menuId: string,
  postId: string,
  definitionVersion: number,
): string {
  if (!OPAQUE_ID_PATTERN.test(menuId) || !OPAQUE_ID_PATTERN.test(postId)) {
    throw new TypeError("Role-menu IDs must be opaque URL-safe identifiers.");
  }
  if (
    !Number.isInteger(definitionVersion) ||
    definitionVersion < 1 ||
    definitionVersion > 2_147_483_647
  ) {
    throw new RangeError("Role-menu definition version is invalid.");
  }
  const customId = `${ROLE_MENU_CUSTOM_ID_PREFIX}${menuId}:${postId}:${definitionVersion}`;
  if (customId.length > 100) {
    throw new RangeError(
      "Role-menu control exceeds Discord's custom ID limit.",
    );
  }
  return customId;
}

export function parseRoleMenuCustomId(
  customId: string,
): ParsedRoleMenuCustomId | null {
  if (!customId.startsWith(ROLE_MENU_CUSTOM_ID_PREFIX)) return null;
  const value = customId.slice(ROLE_MENU_CUSTOM_ID_PREFIX.length);
  const match = value.match(
    /^([A-Za-z0-9_-]{8,24}):([A-Za-z0-9_-]{8,24}):([1-9]\d{0,9})$/u,
  );
  if (!match) return null;
  const definitionVersion = Number(match[3]);
  if (
    !Number.isInteger(definitionVersion) ||
    definitionVersion > 2_147_483_647
  ) {
    return null;
  }
  return {
    menuId: match[1]!,
    postId: match[2]!,
    definitionVersion,
  };
}

export function buildRoleMenuPanelPayload(
  menu: RoleMenuView,
  options: readonly RoleMenuOptionView[],
  postId: string,
): RoleMenuPanelPayload {
  validateRenderableRoleMenu(menu, options);
  const customId = createRoleMenuCustomId(
    menu.menuId,
    postId,
    menu.definitionVersion,
  );
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(selectionPlaceholder(menu.mode))
    .setMinValues(menu.minSelections)
    .setMaxValues(
      menu.mode === "exclusive"
        ? 1
        : Math.min(menu.maxSelections, options.length),
    )
    .addOptions(
      [...options]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((option) => {
          const builder = new StringSelectMenuOptionBuilder()
            .setValue(option.optionId)
            .setLabel(option.label);
          if (option.description) builder.setDescription(option.description);
          const emoji = safeUnicodeEmoji(option.emoji);
          if (emoji) builder.setEmoji(emoji);
          return builder;
        }),
    );
  const embed = createSuperiorEmbed()
    .setTitle(escapeMarkdown(menu.title))
    .setDescription(escapeMarkdown(menu.description))
    .addFields({
      name: "Selection",
      value: selectionExplanation(menu),
    });
  if (menu.requiredRoleId) {
    embed.addFields({
      name: "Required role",
      value: `<@&${menu.requiredRoleId}>`,
    });
  }
  setPanelInstructionFooter(
    embed,
    "Choose your roles from the menu to save your selection.",
  );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    ],
    allowedMentions: Object.freeze({ parse: Object.freeze([]) }),
  };
}

export function validateRenderableRoleMenu(
  menu: RoleMenuView,
  options: readonly RoleMenuOptionView[],
): void {
  if (!OPAQUE_ID_PATTERN.test(menu.menuId)) {
    throw new TypeError("Role-menu ID is invalid.");
  }
  if (menu.state !== "enabled" || !menu.bindingsVerifiedAt) {
    throw new TypeError(
      "Only an enabled and freshly verified menu can be posted.",
    );
  }
  if (menu.title.length < 1 || menu.title.length > ROLE_MENU_LIMITS.title) {
    throw new RangeError("Role-menu title is outside Discord limits.");
  }
  if (escapeMarkdown(menu.title).length > ROLE_MENU_LIMITS.title) {
    throw new RangeError(
      "Role-menu title exceeds Discord's limit after safe Markdown escaping.",
    );
  }
  if (
    menu.description.length < 1 ||
    menu.description.length > ROLE_MENU_LIMITS.description
  ) {
    throw new RangeError("Role-menu description is outside Discord limits.");
  }
  if (options.length < 1 || options.length > ROLE_MENU_LIMITS.optionsPerMenu) {
    throw new RangeError("Role menus require between 1 and 25 options.");
  }
  if (
    !Number.isInteger(menu.minSelections) ||
    !Number.isInteger(menu.maxSelections) ||
    menu.minSelections < 0 ||
    menu.maxSelections < 1 ||
    menu.minSelections > menu.maxSelections ||
    menu.minSelections > options.length ||
    menu.maxSelections > 25 ||
    (menu.mode === "exclusive" && menu.maxSelections !== 1)
  ) {
    throw new RangeError("Role-menu selection limits are inconsistent.");
  }
  const optionIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const option of options) {
    if (
      option.guildId !== menu.guildId ||
      option.menuId !== menu.menuId ||
      !OPAQUE_ID_PATTERN.test(option.optionId)
    ) {
      throw new TypeError("Role-menu option identity is invalid.");
    }
    if (optionIds.has(option.optionId) || roleIds.has(option.roleId)) {
      throw new TypeError("Role-menu options must have unique IDs and roles.");
    }
    if (
      option.label.length < 1 ||
      option.label.length > ROLE_MENU_LIMITS.optionLabel ||
      (option.description !== null &&
        (option.description.length < 1 ||
          option.description.length > ROLE_MENU_LIMITS.optionDescription))
    ) {
      throw new RangeError("Role-menu option text is outside Discord limits.");
    }
    optionIds.add(option.optionId);
    roleIds.add(option.roleId);
  }
}

function selectionPlaceholder(mode: RoleMenuSelectionMode): string {
  switch (mode) {
    case "toggle":
      return "Choose the roles you want to keep";
    case "exclusive":
      return "Choose one role";
    case "limited":
      return "Choose roles within this menu's limit";
  }
}

function selectionExplanation(menu: RoleMenuView): string {
  switch (menu.mode) {
    case "toggle":
      return `Choose ${menu.minSelections}-${menu.maxSelections} roles. Your selection becomes your desired set for this menu.`;
    case "exclusive":
      return menu.minSelections === 0
        ? "Choose at most one role, or clear your selection."
        : "Choose exactly one role.";
    case "limited":
      return `Choose between ${menu.minSelections} and ${menu.maxSelections} roles.`;
  }
}
