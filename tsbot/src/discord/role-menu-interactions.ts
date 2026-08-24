import {
  MessageFlags,
  escapeMarkdown,
  type GuildMember,
  type Role,
  type StringSelectMenuInteraction,
} from "discord.js";
import { classifyError } from "../errors.js";
import type { GuildRuntime } from "../runtime.js";
import { logDomainOutcome } from "./domain-outcomes.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import {
  ROLE_MENU_CUSTOM_ID_PREFIX,
  parseRoleMenuCustomId,
  type RoleMenuOptionView,
  type RoleMenuPostView,
  type RoleMenuView,
} from "./role-menu-components.js";
import {
  assignableRoleSafetyIssue,
  prerequisiteRoleSafetyIssue,
} from "./role-policy.js";

interface RoleMenuOperationView {
  readonly operationId: string;
  readonly state: "pending" | "completed" | "partial" | "failed" | "no-change";
}

interface RoleMenuInteractionRepository {
  getRoleMenuById(menuId: string): RoleMenuView | null;
  getRoleMenuPostById(postId: string): RoleMenuPostView | null;
  findRoleMenuPostByMessage(
    channelId: string,
    messageId: string,
  ): RoleMenuPostView | null;
  listRoleMenuOptions(menuId: string): RoleMenuOptionView[];
  reserveRoleMenuOperation(input: {
    operationId?: string;
    interactionId: string;
    menuId: string;
    memberId: string;
    definitionVersion: number;
    selectionKey: string;
    plannedAdds?: readonly string[];
    plannedRemovals?: readonly string[];
  }): { status: "reserved" | "duplicate"; operation: RoleMenuOperationView };
  completeRoleMenuOperation(
    operationId: string,
    input: {
      state: "completed" | "partial" | "failed" | "no-change";
      addedRoleIds: readonly string[];
      removedRoleIds: readonly string[];
      failedRoleIds: readonly string[];
      skippedRoleIds: readonly string[];
      failureCode?: string | null;
    },
  ): RoleMenuOperationView;
  recordCommandMetric(name: string, success?: boolean): void;
}

interface RoleMenuMutationGuard {
  readonly guildId: string;
  readonly menuId: string;
  readonly definitionVersion: number;
  readonly bindingsVerifiedAt: string;
  readonly updatedAt: string;
}

const roleMenuInteractionQueue = new KeyedSerialQueue();

export function roleMenuInteractionQueueSize(): number {
  return roleMenuInteractionQueue.size;
}

export function runRoleMenuMemberSerial<T>(
  guildId: string,
  menuId: string,
  memberId: string,
  task: () => Promise<T>,
): Promise<T> {
  return roleMenuInteractionQueue.run(`${guildId}:${menuId}:${memberId}`, task);
}

export async function handleRoleMenuSelect(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(ROLE_MENU_CUSTOM_ID_PREFIX)) {
    return false;
  }
  const parsed = parseRoleMenuCustomId(interaction.customId);
  if (!parsed) {
    await replyPrivate(interaction, staleMenuMessage());
    return true;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  try {
    await runRoleMenuMemberSerial(
      runtime.guildId,
      parsed.menuId,
      interaction.user.id,
      () => applyRoleMenuSelection(interaction, runtime, parsed),
    );
  } catch (error) {
    const failureCode = classifyError(error).category;
    logDomainOutcome(
      "panel",
      "role-menu-select",
      runtime.guildId,
      `failed-${failureCode}`,
      { recordId: parsed.menuId },
    );
    await replyPrivate(
      interaction,
      "Superior could not safely finish that role-menu selection. No later role changes were attempted; ask an administrator to inspect the recorded operation and run role-menu recovery.",
    ).catch(() => undefined);
  }
  return true;
}

async function applyRoleMenuSelection(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
  parsed: ReturnType<typeof parseRoleMenuCustomId> & object,
): Promise<void> {
  const guild = interaction.guild;
  if (
    !guild ||
    !interaction.guildId ||
    guild.id !== interaction.guildId ||
    guild.id !== runtime.guildId ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(interaction, staleMenuMessage());
    return;
  }
  const repository =
    runtime.storage as unknown as RoleMenuInteractionRepository;
  const binding = loadCurrentBinding(repository, interaction, parsed);
  if (!binding) {
    await replyPrivate(interaction, staleMenuMessage());
    return;
  }
  const selectedOptionIds = [...new Set(interaction.values)];
  if (
    selectedOptionIds.length !== interaction.values.length ||
    selectedOptionIds.some((value) => !/^[A-Za-z0-9_-]{8,24}$/u.test(value))
  ) {
    await replyPrivate(
      interaction,
      "That role selection payload is invalid. No roles were changed.",
    );
    return;
  }
  const optionById = new Map(
    binding.options.map((option) => [option.optionId, option]),
  );
  if (selectedOptionIds.some((optionId) => !optionById.has(optionId))) {
    await replyPrivate(interaction, staleMenuMessage());
    return;
  }
  const selectionIssue = validateSelectionCount(
    binding.menu,
    selectedOptionIds.length,
  );
  if (selectionIssue) {
    await replyPrivate(interaction, selectionIssue);
    return;
  }

  const [member, botMember] = await Promise.all([
    guild.members
      .fetch({ user: interaction.user.id, cache: true, force: true })
      .catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  if (
    !member ||
    member.guild.id !== runtime.guildId ||
    member.id !== interaction.user.id
  ) {
    await replyPrivate(
      interaction,
      "Superior could not verify your current server membership. No roles were changed.",
    );
    return;
  }
  if (member.user.bot) {
    await replyPrivate(interaction, "Bots cannot use self-service role menus.");
    return;
  }
  if (!botMember || botMember.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Superior could not verify its current server role. No roles were changed.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, staleMenuMessage());
    return;
  }

  const roles = await fetchOptionRoles(
    guild,
    binding.options,
    botMember,
    runtime.guildId,
  );
  if (!roles.valid) {
    await replyPrivate(interaction, roles.message);
    return;
  }
  if (binding.menu.requiredRoleId) {
    const prerequisite = await guild.roles
      .fetch(binding.menu.requiredRoleId, { cache: true, force: true })
      .catch(() => null);
    if (!prerequisite) {
      await replyPrivate(
        interaction,
        "This menu's prerequisite role was deleted or is unavailable. Ask an administrator to repair the menu.",
      );
      return;
    }
    const prerequisiteIssue = prerequisiteRoleSafetyIssue(
      prerequisite,
      runtime.guildId,
    );
    if (prerequisiteIssue) {
      await replyPrivate(interaction, prerequisiteIssue);
      return;
    }
    if (!member.roles.cache.has(prerequisite.id)) {
      await replyPrivate(
        interaction,
        `You need **${escapeMarkdown(prerequisite.name)}** to use this role menu.`,
      );
      return;
    }
  }

  const desiredRoleIds = new Set(
    selectedOptionIds.map((optionId) => optionById.get(optionId)!.roleId),
  );
  const currentMenuRoleIds = new Set(
    binding.options
      .map((option) => option.roleId)
      .filter((roleId) => member.roles.cache.has(roleId)),
  );
  const additions = [...desiredRoleIds].filter(
    (roleId) => !currentMenuRoleIds.has(roleId),
  );
  const removals = [...currentMenuRoleIds].filter(
    (roleId) => !desiredRoleIds.has(roleId),
  );
  const reservation = repository.reserveRoleMenuOperation({
    interactionId: interaction.id,
    menuId: binding.menu.menuId,
    memberId: member.id,
    definitionVersion: binding.menu.definitionVersion,
    selectionKey: selectedOptionIds.slice().sort().join(","),
    plannedAdds: additions,
    plannedRemovals: removals,
  });
  if (reservation.status === "duplicate") {
    await replyPrivate(
      interaction,
      reservation.operation.state === "completed" ||
        reservation.operation.state === "no-change"
        ? "This role-menu interaction was already processed. Your confirmed roles were not changed again."
        : "This role-menu interaction was already recorded with incomplete work. Ask an administrator to run role-menu recovery.",
    );
    return;
  }
  if (additions.length === 0 && removals.length === 0) {
    repository.completeRoleMenuOperation(reservation.operation.operationId, {
      state: "no-change",
      addedRoleIds: [],
      removedRoleIds: [],
      failedRoleIds: [],
      skippedRoleIds: [],
    });
    repository.recordCommandMetric("rolemenu.select");
    await replyPrivate(
      interaction,
      "Your selected role-menu state was already current. No roles were changed.",
    );
    return;
  }

  await executeMutationPlan(
    interaction,
    runtime,
    repository,
    reservation.operation.operationId,
    binding.menu,
    member,
    roles.roles,
    additions,
    removals,
  );
}

function loadCurrentBinding(
  repository: RoleMenuInteractionRepository,
  interaction: StringSelectMenuInteraction,
  parsed: ReturnType<typeof parseRoleMenuCustomId> & object,
): {
  menu: RoleMenuView;
  post: RoleMenuPostView;
  options: RoleMenuOptionView[];
} | null {
  const menu = repository.getRoleMenuById(parsed.menuId);
  const post = repository.getRoleMenuPostById(parsed.postId);
  const messageBinding = repository.findRoleMenuPostByMessage(
    interaction.channelId,
    interaction.message.id,
  );
  if (
    !menu ||
    !post ||
    !messageBinding ||
    menu.guildId !== interaction.guildId ||
    post.guildId !== interaction.guildId ||
    messageBinding.guildId !== interaction.guildId ||
    post.postId !== messageBinding.postId ||
    post.menuId !== menu.menuId ||
    post.channelId !== interaction.channelId ||
    post.messageId !== interaction.message.id ||
    post.definitionVersion !== parsed.definitionVersion ||
    menu.definitionVersion !== parsed.definitionVersion ||
    post.state !== "active" ||
    menu.state !== "enabled" ||
    !post.bindingsVerifiedAt ||
    !menu.bindingsVerifiedAt ||
    interaction.message.author?.id !== interaction.client.user?.id
  ) {
    return null;
  }
  const options = repository.listRoleMenuOptions(menu.menuId);
  if (
    options.length < 1 ||
    options.length > 25 ||
    options.some(
      (option) =>
        option.guildId !== menu.guildId || option.menuId !== menu.menuId,
    )
  ) {
    return null;
  }
  return { menu, post, options };
}

async function fetchOptionRoles(
  guild: NonNullable<StringSelectMenuInteraction["guild"]>,
  options: readonly RoleMenuOptionView[],
  botMember: GuildMember,
  guildId: string,
): Promise<
  | { valid: true; roles: ReadonlyMap<string, Role> }
  | { valid: false; message: string }
> {
  const roles = new Map<string, Role>();
  for (const option of [...options].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  )) {
    const role = await guild.roles
      .fetch(option.roleId, { cache: true, force: true })
      .catch(() => null);
    if (!role) {
      return {
        valid: false,
        message:
          "A role in this menu was deleted or is unavailable. Ask an administrator to repair the menu.",
      };
    }
    const issue = assignableRoleSafetyIssue(role, { guildId, botMember });
    if (issue) return { valid: false, message: issue };
    roles.set(role.id, role);
  }
  return { valid: true, roles };
}

async function executeMutationPlan(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
  repository: RoleMenuInteractionRepository,
  operationId: string,
  menu: RoleMenuView,
  member: GuildMember,
  roles: ReadonlyMap<string, Role>,
  additions: readonly string[],
  removals: readonly string[],
): Promise<void> {
  // Capture primitive values before the first Discord mutation. Repository
  // reads return fresh objects in production, but a primitive snapshot also
  // keeps this guard correct for alternate repository implementations.
  const mutationGuard: RoleMenuMutationGuard = {
    guildId: menu.guildId,
    menuId: menu.menuId,
    definitionVersion: menu.definitionVersion,
    bindingsVerifiedAt: menu.bindingsVerifiedAt!,
    updatedAt: menu.updatedAt,
  };
  const added: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let failureCode: string | null = null;
  let attemptedCount = 0;
  let additionsBlocked = false;

  for (let index = 0; index < additions.length; index += 1) {
    const roleId = additions[index]!;
    const planFailure = currentMutationPlanFailure(
      runtime,
      repository,
      mutationGuard,
    );
    if (planFailure) {
      failureCode = planFailure;
      skipped.push(...additions.slice(index), ...removals);
      additionsBlocked = true;
      break;
    }
    const role = roles.get(roleId);
    if (!role) {
      failureCode = "role-unavailable";
      skipped.push(...additions.slice(index), ...removals);
      additionsBlocked = true;
      break;
    }
    attemptedCount += 1;
    try {
      await member.roles.add(role, `Superior role menu ${menu.menuId}`);
      added.push(roleId);
    } catch (error) {
      failureCode = classifyError(error).category;
      failed.push(roleId);
      skipped.push(...additions.slice(index + 1), ...removals);
      additionsBlocked = true;
      break;
    }
  }

  // A failed addition never causes removal of a prior menu role.
  if (!additionsBlocked) {
    for (let index = 0; index < removals.length; index += 1) {
      const roleId = removals[index]!;
      const planFailure = currentMutationPlanFailure(
        runtime,
        repository,
        mutationGuard,
      );
      if (planFailure) {
        failureCode ??= planFailure;
        skipped.push(...removals.slice(index));
        break;
      }
      const role = roles.get(roleId);
      if (!role) {
        failureCode ??= "role-unavailable";
        skipped.push(roleId);
        continue;
      }
      attemptedCount += 1;
      try {
        await member.roles.remove(role, `Superior role menu ${menu.menuId}`);
        removed.push(roleId);
      } catch (error) {
        failureCode ??= classifyError(error).category;
        failed.push(roleId);
      }
    }
  }

  const succeeded = added.length + removed.length;
  const incomplete = failed.length + skipped.length;
  const state =
    incomplete === 0 ? "completed" : succeeded > 0 ? "partial" : "failed";
  repository.completeRoleMenuOperation(operationId, {
    state,
    addedRoleIds: added,
    removedRoleIds: removed,
    failedRoleIds: failed,
    skippedRoleIds: skipped,
    failureCode,
  });
  repository.recordCommandMetric("rolemenu.select", incomplete === 0);
  logDomainOutcome(
    "panel",
    "role-menu-select",
    runtime.guildId,
    incomplete === 0 ? "completed" : state,
    {
      recordId: menu.menuId,
      attemptedCount,
      succeededCount: succeeded,
      failedCount: failed.length,
      totalCount: additions.length + removals.length,
    },
  );

  const addedLabels = roleLabels(added, roles);
  const removedLabels = roleLabels(removed, roles);
  const lines = [
    incomplete === 0
      ? "Your role-menu selection was applied."
      : succeeded > 0
        ? "Discord applied only part of the requested role changes. The confirmed outcome was recorded for recovery."
        : attemptedCount === 0
          ? "No Discord role changes were attempted. Your prior menu roles were preserved."
          : "Discord did not apply the requested role changes. Your prior menu roles were preserved.",
    `Attempted: ${attemptedCount} · confirmed: ${succeeded} · failed: ${failed.length} · skipped: ${skipped.length}.`,
    addedLabels ? `Added: ${addedLabels}` : null,
    removedLabels ? `Removed: ${removedLabels}` : null,
    incomplete > 0
      ? `Incomplete: ${incomplete} role change${incomplete === 1 ? "" : "s"}. An authorized administrator can run \`/rolemenu recover\`.`
      : null,
  ].filter((line): line is string => line !== null);
  await replyPrivate(interaction, lines.join("\n").slice(0, 2_000));
}

/**
 * Re-read the authoritative menu immediately before every Discord role write.
 * A configuration command uses a different serialization key than a member
 * selection, so runtime generation alone cannot prove that a reserved plan is
 * still authorized while an earlier role write is in flight.
 */
function currentMutationPlanFailure(
  runtime: GuildRuntime,
  repository: RoleMenuInteractionRepository,
  expected: RoleMenuMutationGuard,
): "runtime-changed" | "menu-changed" | null {
  if (!runtime.isCurrent()) return "runtime-changed";
  const current = repository.getRoleMenuById(expected.menuId);
  if (
    !current ||
    current.guildId !== expected.guildId ||
    current.menuId !== expected.menuId ||
    current.state !== "enabled" ||
    current.definitionVersion !== expected.definitionVersion ||
    current.bindingsVerifiedAt !== expected.bindingsVerifiedAt ||
    current.updatedAt !== expected.updatedAt
  ) {
    return "menu-changed";
  }
  return null;
}

function validateSelectionCount(
  menu: RoleMenuView,
  count: number,
): string | null {
  if (menu.mode === "exclusive" && count > 1) {
    return "This menu allows at most one selected role. No roles were changed.";
  }
  if (count < menu.minSelections || count > menu.maxSelections) {
    return `Choose between ${menu.minSelections} and ${menu.maxSelections} roles. No roles were changed.`;
  }
  return null;
}

function roleLabels(
  roleIds: readonly string[],
  roles: ReadonlyMap<string, Role>,
): string {
  return roleIds
    .map((roleId) => roles.get(roleId))
    .filter((role): role is Role => Boolean(role))
    .map((role) => `**${escapeMarkdown(role.name)}**`)
    .join(", ");
}

function staleMenuMessage(): string {
  return "This role menu is disabled, outdated, copied, or no longer bound to this message. Ask an administrator to refresh it.";
}

async function replyPrivate(
  interaction: StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
