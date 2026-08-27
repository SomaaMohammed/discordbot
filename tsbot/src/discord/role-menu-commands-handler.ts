import {
  ChannelType,
  MessageFlags,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type Role,
} from "discord.js";
import { classifyError } from "../errors.js";
import type { GuildRuntime } from "../runtime.js";
import { createOpaqueStorageId } from "../storage/operational-repository.js";
import type {
  RoleMenu,
  RoleMenuMode,
  RoleMenuOperation,
  RoleMenuOption,
  RoleMenuPost,
  RoleMenuUpdateInput,
} from "../types.js";
import { authorizeCapability } from "./authorization.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import { canPostThemedPanel } from "./ticket-permissions.js";
import {
  buildRoleMenuPanelPayload,
  createRoleMenuCustomId,
  validateRenderableRoleMenu,
} from "./role-menu-components.js";
import { runRoleMenuMemberSerial } from "./role-menu-interactions.js";
import {
  assignableRoleSafetyIssue,
  prerequisiteRoleSafetyIssue,
} from "./role-policy.js";

const commandQueue = new KeyedSerialQueue();

export async function handleRoleMenuCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expectedActor: GuildMember,
): Promise<void> {
  await commandQueue.run(runtime.guildId, async () => {
    const actor = await refreshActor(interaction, runtime, expectedActor);
    if (!actor) return;
    try {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand();
      if (group === "option") {
        await handleOptionCommand(interaction, runtime, actor, subcommand);
        return;
      }
      switch (subcommand) {
        case "list":
          await listMenus(interaction, runtime);
          return;
        case "create":
          await createMenu(interaction, runtime, actor);
          return;
        case "edit":
          await editMenu(interaction, runtime, actor);
          return;
        case "post":
          await postMenu(interaction, runtime, actor, false);
          return;
        case "status":
          await showStatus(interaction, runtime, actor);
          return;
        case "enable":
          await changeMenuState(interaction, runtime, actor, "enabled");
          return;
        case "disable":
          await changeMenuState(interaction, runtime, actor, "disabled");
          return;
        case "archive":
          await changeMenuState(interaction, runtime, actor, "archived");
          return;
        case "recover":
          await recoverMenu(interaction, runtime, actor);
          return;
        default:
          await replyPrivate(
            interaction,
            "Choose a supported role-menu action.",
          );
      }
    } catch (error) {
      runtime.storage.recordCommandMetric("rolemenu.command", false);
      await replyPrivate(interaction, safeError(error));
    }
  });
}

async function listMenus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const page = interaction.options.getInteger("page", false) ?? 1;
  const menus = runtime.storage.listRoleMenus({
    limit: 10,
    offset: (page - 1) * 10,
  });
  const lines = menus.map(
    (menu) =>
      `• \`${menu.slug}\` — position ${menu.sortOrder + 1}, ${menu.state}, ${menu.mode}, ${runtime.storage.countRoleMenuOptions(menu.menuId)} option(s), definition ${menu.definitionVersion}`,
  );
  await replyPrivate(
    interaction,
    lines.length > 0
      ? [`**Role menus — page ${page}**`, ...lines].join("\n")
      : `No role menus were found on page ${page}.`,
  );
  runtime.storage.recordCommandMetric("rolemenu.list");
}

async function createMenu(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const mode = interaction.options.getString("mode", true) as RoleMenuMode;
  const title = interaction.options.getString("title", true);
  validateSafeRoleMenuTitle(title);
  const requiredRole = interaction.options.getRole("required_role", false);
  const requiredRoleId = requiredRole
    ? await validatePrerequisite(interaction.guild!, requiredRole.id)
    : null;
  const position = interaction.options.getInteger("position", false);
  const menu = runtime.storage.createRoleMenu({
    slug: interaction.options.getString("slug", true),
    title,
    description: interaction.options.getString("description", true),
    mode,
    minSelections: interaction.options.getInteger("minimum", false) ?? 0,
    maxSelections:
      interaction.options.getInteger("maximum", false) ??
      (mode === "exclusive" ? 1 : 1),
    ...(position === null ? {} : { sortOrder: position - 1 }),
    requiredRoleId,
    actorId: actor.id,
  });
  await replyPrivate(
    interaction,
    `Created disabled role menu \`${menu.slug}\` at position ${menu.sortOrder + 1} (ID \`${menu.menuId}\`). Add options, then run \`/rolemenu enable\`.`,
  );
  runtime.storage.recordCommandMetric("rolemenu.create");
}

async function editMenu(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  const selectedRequiredRole = interaction.options.getRole(
    "required_role",
    false,
  );
  const clearRequiredRole =
    interaction.options.getBoolean("clear_required_role", false) ?? false;
  if (selectedRequiredRole && clearRequiredRole)
    throw new TypeError("Choose a prerequisite role or clear it, not both.");
  const input: RoleMenuUpdateInput = {
    actorId: actor.id,
    expectedDefinitionVersion: menu.definitionVersion,
  };
  const title = interaction.options.getString("title", false);
  if (title !== null) validateSafeRoleMenuTitle(title);
  assignDefined(input, "title", title);
  assignDefined(
    input,
    "description",
    interaction.options.getString("description", false),
  );
  assignDefined(
    input,
    "mode",
    interaction.options.getString("mode", false) as RoleMenuMode | null,
  );
  assignDefined(
    input,
    "minSelections",
    interaction.options.getInteger("minimum", false),
  );
  assignDefined(
    input,
    "maxSelections",
    interaction.options.getInteger("maximum", false),
  );
  const position = interaction.options.getInteger("position", false);
  assignDefined(input, "sortOrder", position === null ? null : position - 1);
  if (selectedRequiredRole)
    input.requiredRoleId = await validatePrerequisite(
      interaction.guild!,
      selectedRequiredRole.id,
    );
  else if (clearRequiredRole) input.requiredRoleId = null;
  const updated = runtime.storage.updateRoleMenu(menu.menuId, input);
  if (!updated) throw new Error("That role menu no longer exists.");
  const definitionChanged =
    updated.definitionVersion !== menu.definitionVersion;
  const orderChanged = updated.sortOrder !== menu.sortOrder;
  await replyPrivate(
    interaction,
    definitionChanged
      ? `Updated \`${updated.slug}\` at position ${updated.sortOrder + 1} and definition ${updated.definitionVersion}. Definition changes disable the menu and make old controls stale until resources are verified again.`
      : orderChanged
        ? `Moved \`${updated.slug}\` to position ${updated.sortOrder + 1}. Its definition remains ${updated.definitionVersion}, and published-control validity is unchanged.`
        : `No role-menu definition or position change was applied to \`${updated.slug}\` (position ${updated.sortOrder + 1}, definition ${updated.definitionVersion}).`,
  );
  runtime.storage.recordCommandMetric("rolemenu.edit");
}

async function handleOptionCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  action: string,
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  switch (action) {
    case "add": {
      const role = await selectedSafeAssignableRole(interaction, actor);
      const position = interaction.options.getInteger("position", false);
      const option = runtime.storage.createRoleMenuOption(menu.menuId, {
        roleId: role.id,
        label: interaction.options.getString("label", true),
        description: interaction.options.getString("description", false),
        emoji: interaction.options.getString("emoji", false),
        ...(position === null ? {} : { sortOrder: position - 1 }),
        actorId: actor.id,
      });
      await replyPrivate(
        interaction,
        `Added option \`${option.optionId}\` for <@&${option.roleId}>. The menu remains disabled until its full definition is verified.`,
      );
      runtime.storage.recordCommandMetric("rolemenu.option.add");
      return;
    }
    case "edit": {
      const optionId = interaction.options.getString("option_id", true);
      const selectedRole = interaction.options.getRole("role", false);
      const clearDescription =
        interaction.options.getBoolean("clear_description", false) ?? false;
      const clearEmoji =
        interaction.options.getBoolean("clear_emoji", false) ?? false;
      const description = interaction.options.getString("description", false);
      const emoji = interaction.options.getString("emoji", false);
      if (clearDescription && description !== null)
        throw new TypeError("Provide a description or clear it, not both.");
      if (clearEmoji && emoji !== null)
        throw new TypeError("Provide an emoji or clear it, not both.");
      const updated = runtime.storage.updateRoleMenuOption(
        menu.menuId,
        optionId,
        {
          ...(selectedRole
            ? {
                roleId: (
                  await fetchSafeAssignableRole(
                    interaction.guild!,
                    selectedRole.id,
                    actor,
                  )
                ).id,
              }
            : {}),
          ...(interaction.options.getString("label", false) === null
            ? {}
            : { label: interaction.options.getString("label", true) }),
          ...(description !== null || clearDescription
            ? { description: clearDescription ? null : description }
            : {}),
          ...(emoji !== null || clearEmoji
            ? { emoji: clearEmoji ? null : emoji }
            : {}),
          actorId: actor.id,
        },
      );
      if (!updated) throw new Error("That menu option no longer exists.");
      await replyPrivate(
        interaction,
        `Updated option \`${updated.optionId}\`; published controls are now stale.`,
      );
      runtime.storage.recordCommandMetric("rolemenu.option.edit");
      return;
    }
    case "remove": {
      const optionId = interaction.options.getString("option_id", true);
      if (
        !runtime.storage.removeRoleMenuOption(menu.menuId, optionId, actor.id)
      )
        throw new Error("That menu option no longer exists.");
      await replyPrivate(
        interaction,
        "Removed the option from the definition. Superior did not strip that role from any member.",
      );
      runtime.storage.recordCommandMetric("rolemenu.option.remove");
      return;
    }
    case "move": {
      const optionId = interaction.options.getString("option_id", true);
      const moved = runtime.storage.moveRoleMenuOption(
        menu.menuId,
        optionId,
        interaction.options.getInteger("position", true) - 1,
        actor.id,
      );
      if (!moved) throw new Error("That menu option no longer exists.");
      await replyPrivate(
        interaction,
        `Moved option \`${moved.optionId}\`; published controls are now stale.`,
      );
      runtime.storage.recordCommandMetric("rolemenu.option.move");
      return;
    }
    default:
      throw new TypeError("Choose a supported role-menu option action.");
  }
}

async function changeMenuState(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  state: "enabled" | "disabled" | "archived",
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  const verifiedAt = state === "enabled" ? new Date().toISOString() : null;
  if (state === "enabled")
    await validateMenuResources(interaction.guild!, runtime, actor, menu);
  const updated = runtime.storage.setRoleMenuState(
    menu.menuId,
    state,
    actor.id,
    verifiedAt,
  );
  if (!updated) throw new Error("That role menu no longer exists.");
  await replyPrivate(
    interaction,
    state === "enabled"
      ? `Enabled \`${updated.slug}\` after freshly verifying every referenced role. Repost stale definitions before members use them.`
      : state === "disabled"
        ? `Disabled \`${updated.slug}\`. Existing member roles were not changed.`
        : `Archived \`${updated.slug}\`. History was preserved and the menu cannot be reposted or re-enabled.`,
  );
  runtime.storage.recordCommandMetric(`rolemenu.${state}`);
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  const options = runtime.storage.listRoleMenuOptions(menu.menuId);
  const posts = runtime.storage.listRoleMenuPosts({
    menuId: menu.menuId,
    limit: 100,
  });
  const issues = await inspectMenuResources(
    interaction.guild!,
    actor,
    menu,
    options,
  );
  const activePosts = posts.filter((post) => post.state === "active");
  let livePosts = 0;
  let stalePosts = posts.filter((post) => post.state === "stale").length;
  let missingPosts = posts.filter((post) => post.state === "missing").length;
  for (const post of activePosts) {
    const health = await inspectRoleMenuPostHealth(
      interaction.guild!,
      interaction.client.user?.id,
      runtime,
      menu,
      post,
    );
    if (health === "healthy") livePosts += 1;
    else if (health === "stale") stalePosts += 1;
    else missingPosts += 1;
  }
  const incomplete = listUnresolvedMenuOperations(runtime, menu.menuId).slice(
    0,
    25,
  );
  await replyPrivate(
    interaction,
    [
      `**Role menu \`${escapeMarkdown(menu.slug)}\`**`,
      `Position: **${menu.sortOrder + 1}** · state: **${menu.state}** · mode: **${menu.mode}** · definition: **${menu.definitionVersion}**`,
      `Selections: ${menu.minSelections}-${menu.maxSelections} · options: ${options.length}/25`,
      `Post bindings: ${livePosts} live, ${stalePosts} stale, ${missingPosts} missing (${activePosts.length} active checked)`,
      `Incomplete recorded selections: ${incomplete.length}${incomplete.length === 25 ? "+" : ""}`,
      issues.length === 0
        ? "Resources: healthy"
        : `Resources need attention:\n${issues.map((issue) => `• ${issue}`).join("\n")}`,
      ...options
        .slice(0, 25)
        .map(
          (option) =>
            `• \`${option.optionId}\` → <@&${option.roleId}> — ${escapeMarkdown(option.label)}`,
        ),
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric(
    "rolemenu.status",
    issues.length === 0 && stalePosts === 0 && missingPosts === 0,
  );
}

async function postMenu(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  recovery: boolean,
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  if (menu.state !== "enabled" || !menu.bindingsVerifiedAt)
    throw new Error("Enable and freshly verify this menu before posting it.");
  const options = await validateMenuResources(
    interaction.guild!,
    runtime,
    actor,
    menu,
  );
  const channel = await currentTextChannel(interaction);
  const botMember = await interaction
    .guild!.members.fetchMe({ cache: true, force: true })
    .catch(() => null);
  if (!channel || !botMember || !canPostThemedPanel(channel, botMember))
    throw new Error(
      "Superior needs View Channel, Send Messages, Read Message History, and Embed Links in that text channel.",
    );
  const postId = createOpaqueStorageId();
  const payload = buildRoleMenuPanelPayload(menu, options, postId);
  validateRenderableRoleMenu(menu, options);
  if (!(await stillAuthorized(interaction.guild!, runtime, actor.id)))
    throw new Error(
      "Your role-menu authority changed before the message could be posted.",
    );
  const message = await channel.send(payload);
  if (!runtime.isCurrent()) {
    await message.delete().catch(() => undefined);
    throw new Error(
      "This server changed while the menu was being posted; no binding was retained.",
    );
  }
  try {
    runtime.storage.createRoleMenuPost({
      postId,
      menuId: menu.menuId,
      channelId: channel.id,
      messageId: message.id,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: new Date().toISOString(),
      state: "active",
    });
  } catch (error) {
    await message.delete().catch(() => undefined);
    throw error;
  }
  await replyPrivate(
    interaction,
    `${recovery ? "Recovered" : "Posted"} \`${menu.slug}\` in <#${channel.id}> with definition ${menu.definitionVersion}.`,
  );
  runtime.storage.recordCommandMetric(
    recovery ? "rolemenu.recover" : "rolemenu.post",
  );
}

async function recoverMenu(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  const menu = requireMenu(
    runtime,
    interaction.options.getString("slug", true),
  );
  if (menu.state !== "enabled")
    throw new Error(
      "This menu is disabled or archived. Verify and enable it before recovery.",
    );
  const options = await validateMenuResources(
    interaction.guild!,
    runtime,
    actor,
    menu,
  );
  const selectedMember = interaction.options.getUser("member", false);
  if (selectedMember) {
    await runRoleMenuMemberSerial(
      runtime.guildId,
      menu.menuId,
      selectedMember.id,
      () =>
        recoverMemberSelection(
          interaction,
          runtime,
          actor,
          menu,
          options,
          selectedMember.id,
        ),
    );
    return;
  }
  const posts = runtime.storage.listRoleMenuPosts({
    menuId: menu.menuId,
    limit: 100,
  });
  let healthy = 0;
  let newlyMissing = 0;
  let newlyStale = 0;
  for (const post of posts.filter(
    (candidate) => candidate.state === "active",
  )) {
    const health = await inspectRoleMenuPostHealth(
      interaction.guild!,
      interaction.client.user?.id,
      runtime,
      menu,
      post,
    );
    if (health === "healthy") {
      healthy += 1;
    } else if (
      runtime.storage.setRoleMenuPostState(post.postId, health, null)
    ) {
      if (health === "stale") newlyStale += 1;
      else newlyMissing += 1;
    }
  }
  if (healthy === 0) {
    await postMenu(interaction, runtime, actor, true);
    return;
  }
  await replyPrivate(
    interaction,
    `Checked every bounded active binding: ${healthy} live, ${newlyStale} newly stale, and ${newlyMissing} newly missing. Partial member selections remain recorded; the member can submit the current menu again, which safely recalculates only this menu's roles.`,
  );
  runtime.storage.recordCommandMetric("rolemenu.recover");
}

async function recoverMemberSelection(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
  menu: RoleMenu,
  options: readonly RoleMenuOption[],
  memberId: string,
): Promise<void> {
  const member = await interaction
    .guild!.members.fetch({ user: memberId, cache: true, force: true })
    .catch(() => null);
  if (!member || member.guild.id !== runtime.guildId)
    throw new Error("That member is no longer available in this server.");
  if (member.user.bot)
    throw new TypeError("Bots cannot use or recover self-service role menus.");

  if (menu.requiredRoleId) {
    const prerequisite = await interaction
      .guild!.roles.fetch(menu.requiredRoleId, {
        cache: true,
        force: true,
      })
      .catch(() => null);
    if (
      !prerequisite ||
      prerequisiteRoleSafetyIssue(prerequisite, runtime.guildId)
    ) {
      throw new Error(
        "The role-menu prerequisite is missing or unsafe; no member roles were changed.",
      );
    }
    if (!member.roles.cache.has(prerequisite.id))
      throw new Error(
        "That member no longer holds the role-menu prerequisite; no roles were changed.",
      );
  }

  const unresolved = listUnresolvedMenuOperations(
    runtime,
    menu.menuId,
    member.id,
  );
  if (unresolved.length === 0) {
    await replyPrivate(
      interaction,
      "No unresolved role-menu selection is recorded for that member.",
    );
    runtime.storage.recordCommandMetric("rolemenu.recover.member");
    return;
  }
  const source = unresolved[0]!;
  if (source.definitionVersion !== menu.definitionVersion) {
    throw new Error(
      "The incomplete selection belongs to an older menu definition. Its exact outcome was preserved, but applying old choices is unsafe; ask the member to use the current panel.",
    );
  }

  const optionRoleIds = new Set(options.map(({ roleId }) => roleId));
  if (source.items.some(({ roleId }) => !optionRoleIds.has(roleId))) {
    throw new Error(
      "The incomplete selection references a role outside the current menu definition; no roles were changed.",
    );
  }
  const roles = new Map<string, Role>();
  for (const option of options) {
    const role = await fetchSafeAssignableRole(
      interaction.guild!,
      option.roleId,
      actor,
    );
    roles.set(role.id, role);
  }
  if (!(await stillAuthorized(interaction.guild!, runtime, actor.id)))
    throw new Error(
      "Your role-menu authority changed before recovery could mutate roles.",
    );

  const additions = source.items
    .filter(
      (item) => item.action === "add" && !member.roles.cache.has(item.roleId),
    )
    .map(({ roleId }) => roleId);
  const removals = source.items
    .filter(
      (item) => item.action === "remove" && member.roles.cache.has(item.roleId),
    )
    .map(({ roleId }) => roleId);
  const reservation = runtime.storage.reserveRoleMenuOperation({
    interactionId: interaction.id,
    menuId: menu.menuId,
    memberId: member.id,
    definitionVersion: menu.definitionVersion,
    selectionKey: recoverySelectionKey(source.operationId),
    plannedAdds: additions,
    plannedRemovals: removals,
  });
  if (reservation.status === "duplicate") {
    await replyPrivate(
      interaction,
      "This bounded recovery command was already processed; Superior did not repeat role mutations.",
    );
    return;
  }
  if (additions.length === 0 && removals.length === 0) {
    runtime.storage.completeRoleMenuOperation(
      reservation.operation.operationId,
      {
        state: "no-change",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
      },
    );
    await replyPrivate(
      interaction,
      "The member's recorded role-menu target is already satisfied. Recovery was recorded without repeating a Discord role change.",
    );
    runtime.storage.recordCommandMetric("rolemenu.recover.member");
    return;
  }

  const added: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  let failureCode: string | null = null;
  let attemptedCount = 0;
  let additionsBlocked = false;
  for (let index = 0; index < additions.length; index += 1) {
    const roleId = additions[index]!;
    if (!runtime.isCurrent()) {
      failureCode = "runtime-changed";
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
      await member.roles.add(
        role,
        `Superior role-menu recovery ${menu.menuId}`,
      );
      added.push(roleId);
    } catch (error) {
      failureCode = classifyError(error).category;
      failed.push(roleId);
      skipped.push(...additions.slice(index + 1), ...removals);
      additionsBlocked = true;
      break;
    }
  }
  if (!additionsBlocked) {
    for (let index = 0; index < removals.length; index += 1) {
      const roleId = removals[index]!;
      if (!runtime.isCurrent()) {
        failureCode ??= "runtime-changed";
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
        await member.roles.remove(
          role,
          `Superior role-menu recovery ${menu.menuId}`,
        );
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
  runtime.storage.completeRoleMenuOperation(reservation.operation.operationId, {
    state,
    addedRoleIds: added,
    removedRoleIds: removed,
    failedRoleIds: failed,
    skippedRoleIds: skipped,
    failureCode,
  });
  runtime.storage.recordCommandMetric(
    "rolemenu.recover.member",
    incomplete === 0,
  );
  await replyPrivate(
    interaction,
    incomplete === 0
      ? `Recovered the member's role-menu selection. Attempted: ${attemptedCount} · confirmed: ${succeeded} · failed: 0 · skipped: 0.`
      : `Role-menu recovery remains incomplete. Attempted: ${attemptedCount} · confirmed: ${succeeded} · failed: ${failed.length} · skipped: ${skipped.length}. The exact outcome remains safely recoverable.`,
  );
}

function listUnresolvedMenuOperations(
  runtime: GuildRuntime,
  menuId: string,
  memberId?: string,
): RoleMenuOperation[] {
  const operations = runtime.storage.listRoleMenuOperations({
    menuId,
    ...(memberId ? { memberId } : {}),
    limit: 100,
  });
  const recovered = new Set(
    operations
      .filter(
        (operation) =>
          (operation.state === "completed" ||
            operation.state === "no-change") &&
          operation.selectionKey.startsWith("recovery:"),
      )
      .map((operation) => operation.selectionKey.slice("recovery:".length)),
  );
  const latestNormalByMember = new Map<string, RoleMenuOperation>();
  for (const operation of operations) {
    if (
      !operation.selectionKey.startsWith("recovery:") &&
      !latestNormalByMember.has(operation.memberId)
    ) {
      latestNormalByMember.set(operation.memberId, operation);
    }
  }
  return [...latestNormalByMember.values()].filter(
    (operation) =>
      (operation.state === "reserved" ||
        operation.state === "partial" ||
        operation.state === "failed") &&
      !recovered.has(operation.operationId),
  );
}

type RoleMenuPostHealth = "healthy" | "stale" | "missing";

async function inspectRoleMenuPostHealth(
  guild: Guild,
  clientUserId: string | undefined,
  runtime: GuildRuntime,
  menu: RoleMenu,
  post: RoleMenuPost,
): Promise<RoleMenuPostHealth> {
  if (
    post.state !== "active" ||
    post.guildId !== runtime.guildId ||
    post.menuId !== menu.menuId ||
    post.definitionVersion !== menu.definitionVersion ||
    !isParseableTimestamp(post.bindingsVerifiedAt) ||
    !isParseableTimestamp(menu.bindingsVerifiedAt)
  ) {
    return "stale";
  }
  const channel = await fetchTextChannel(guild, post.channelId);
  if (!channel) return "missing";
  const message = await channel.messages
    .fetch(post.messageId)
    .catch(() => null);
  if (
    !message ||
    !clientUserId ||
    message.id !== post.messageId ||
    message.channelId !== post.channelId ||
    message.guildId !== runtime.guildId ||
    message.author.id !== clientUserId ||
    !message.author.bot
  ) {
    return "missing";
  }
  const expectedCustomId = createRoleMenuCustomId(
    menu.menuId,
    post.postId,
    menu.definitionVersion,
  );
  return messageHasCustomId(message, expectedCustomId) ? "healthy" : "stale";
}

function messageHasCustomId(message: Message, customId: string): boolean {
  return componentTreeHasCustomId(message.components, customId);
}

function componentTreeHasCustomId(value: unknown, customId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => componentTreeHasCustomId(item, customId));
  }
  if (!value || typeof value !== "object") return false;
  const component = value as {
    readonly customId?: unknown;
    readonly components?: unknown;
  };
  return (
    component.customId === customId ||
    componentTreeHasCustomId(component.components, customId)
  );
}

function isParseableTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function recoverySelectionKey(operationId: string): string {
  return `recovery:${operationId}`;
}

async function validateMenuResources(
  guild: Guild,
  runtime: GuildRuntime,
  actor: GuildMember,
  menu: RoleMenu,
): Promise<RoleMenuOption[]> {
  const options = runtime.storage.listRoleMenuOptions(menu.menuId);
  const issues = await inspectMenuResources(guild, actor, menu, options);
  if (issues.length > 0)
    throw new Error(`Role-menu resources need attention: ${issues.join(" ")}`);
  validateRenderableBounds(menu, options);
  return options;
}

async function inspectMenuResources(
  guild: Guild,
  actor: GuildMember,
  menu: RoleMenu,
  options: readonly RoleMenuOption[],
): Promise<string[]> {
  const botMember = await guild.members
    .fetchMe({ cache: true, force: true })
    .catch(() => null);
  if (!botMember)
    return ["Superior could not verify its current server membership."];
  const issues: string[] = [];
  for (const option of [...options].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const role = await guild.roles
      .fetch(option.roleId, { cache: true, force: true })
      .catch(() => null);
    if (!role)
      issues.push(`Option ${option.optionId} references a missing role.`);
    else {
      const issue = assignableRoleSafetyIssue(role, {
        guildId: guild.id,
        botMember,
        actor,
      });
      if (issue) issues.push(`Option ${option.optionId}: ${issue}`);
    }
  }
  if (menu.requiredRoleId) {
    const role = await guild.roles
      .fetch(menu.requiredRoleId, { cache: true, force: true })
      .catch(() => null);
    if (!role) issues.push("The prerequisite role is missing.");
    else {
      const issue = prerequisiteRoleSafetyIssue(role, guild.id);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function validateRenderableBounds(
  menu: RoleMenu,
  options: readonly RoleMenuOption[],
): void {
  if (options.length < 1 || options.length > 25)
    throw new RangeError("A role menu needs between 1 and 25 options.");
  if (
    menu.minSelections > options.length ||
    menu.maxSelections > options.length
  )
    throw new RangeError(
      "Selection limits cannot exceed the current option count.",
    );
  validateSafeRoleMenuTitle(menu.title);
}

function validateSafeRoleMenuTitle(title: string): void {
  if (escapeMarkdown(title).length > 256) {
    throw new RangeError(
      "The role-menu title exceeds Discord's 256-character limit after safe Markdown escaping.",
    );
  }
}

async function selectedSafeAssignableRole(
  interaction: ChatInputCommandInteraction,
  actor: GuildMember,
): Promise<Role> {
  const selected = interaction.options.getRole("role", true);
  return fetchSafeAssignableRole(interaction.guild!, selected.id, actor);
}

async function fetchSafeAssignableRole(
  guild: Guild,
  roleId: string,
  actor: GuildMember,
): Promise<Role> {
  const [role, botMember] = await Promise.all([
    guild.roles.fetch(roleId, { cache: true, force: true }).catch(() => null),
    guild.members.fetchMe({ cache: true, force: true }).catch(() => null),
  ]);
  if (!role || !botMember)
    throw new Error("Superior could not freshly verify that role.");
  const issue = assignableRoleSafetyIssue(role, {
    guildId: guild.id,
    botMember,
    actor,
  });
  if (issue) throw new TypeError(issue);
  return role;
}

async function validatePrerequisite(
  guild: Guild,
  roleId: string,
): Promise<string> {
  const role = await guild.roles
    .fetch(roleId, { cache: true, force: true })
    .catch(() => null);
  if (!role)
    throw new Error("The prerequisite role is missing or unavailable.");
  const issue = prerequisiteRoleSafetyIssue(role, guild.id);
  if (issue) throw new TypeError(issue);
  return role.id;
}

async function currentTextChannel(
  interaction: ChatInputCommandInteraction,
): Promise<GuildTextBasedChannel | null> {
  const channelId = interaction.channelId;
  if (!channelId) return null;
  return fetchTextChannel(interaction.guild!, channelId);
}

async function fetchTextChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildTextBasedChannel | null> {
  const channel = await guild.channels
    .fetch(channelId, { cache: true, force: true })
    .catch(() => null);
  return channel &&
    channel.guild.id === guild.id &&
    (channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement)
    ? channel
    : null;
}

async function refreshActor(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  expected: GuildMember,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    expected.id !== interaction.user.id
  )
    return null;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability: "roles.configure",
    grants: runtime.storage,
  });
  if (!decision.allowed || !runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "Your current role-menu authority could not be verified.",
    );
    return null;
  }
  return decision.member;
}

async function stillAuthorized(
  guild: Guild,
  runtime: GuildRuntime,
  actorId: string,
): Promise<boolean> {
  const decision = await authorizeCapability({
    guild,
    userId: actorId,
    capability: "roles.configure",
    grants: runtime.storage,
  });
  return decision.allowed && runtime.isCurrent();
}

function requireMenu(runtime: GuildRuntime, slug: string): RoleMenu {
  const menu = runtime.storage.getRoleMenuBySlug(slug);
  if (!menu) throw new Error("That role menu was not found in this server.");
  return menu;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null,
): void {
  if (value !== null) target[key] = value;
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_800)
    : "Superior could not safely complete that role-menu operation.";
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  const payload = {
    content: content.slice(0, 2_000),
    allowedMentions: { parse: [] as never[] },
  };
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply(payload);
  } else if (interaction.replied) {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}
