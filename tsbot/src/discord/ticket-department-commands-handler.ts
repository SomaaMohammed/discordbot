import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Role,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  FormFieldType,
  TicketConfiguration,
  TicketDepartment,
  TicketDepartmentDeleteResult,
  TicketDepartmentField,
  TicketDepartmentFieldInput,
  TicketDepartmentInput,
  TicketDepartmentUpdate,
} from "../types.js";
import { normalizeUnicodeEmoji } from "../unicode-emoji.js";
import {
  fetchAndValidateRole,
  type CapabilityGrantReader,
} from "./authorization.js";
import { inspectContentDestinationBoundary } from "./content-destination-boundary.js";
import {
  normalizeMultilineText,
  normalizeSingleLine,
  normalizeSlug,
} from "./forms.js";
import { isConfiguredDepartment } from "./phase2-permissions.js";
import {
  inspectTicketConfigurationResources,
  type TicketManagementGrantReader,
} from "./ticket-permissions.js";

const MAX_DEPARTMENTS = 10;
const MAX_FIELDS = 5;
const DEPARTMENT_PAGE_SIZE = 10;

export interface TicketDepartmentStorage
  extends TicketManagementGrantReader, CapabilityGrantReader {
  createTicketDepartment(input: TicketDepartmentInput): TicketDepartment;
  updateTicketDepartment(
    departmentId: string,
    update: TicketDepartmentUpdate,
  ): TicketDepartment | null;
  setTicketDepartmentEnabled(
    departmentId: string,
    enabled: boolean,
  ): TicketDepartment | null;
  deleteTicketDepartment(departmentId: string): TicketDepartmentDeleteResult;
  getTicketDepartment(departmentId: string): TicketDepartment | null;
  getTicketDepartmentBySlug(slug: string): TicketDepartment | null;
  listTicketDepartments(options?: {
    enabled?: boolean;
    limit?: number;
    offset?: number;
  }): TicketDepartment[];
  countTicketDepartments(): number;
  hasActiveTicketsForDepartment(departmentId: string): boolean;
  upsertTicketDepartmentField(
    departmentId: string,
    input: TicketDepartmentFieldInput,
  ): TicketDepartmentField;
  removeTicketDepartmentField(departmentId: string, fieldId: string): boolean;
  reorderTicketDepartmentFields(
    departmentId: string,
    fieldIds: readonly string[],
  ): TicketDepartmentField[];
  getTicketDepartmentField(
    departmentId: string,
    fieldId: string,
  ): TicketDepartmentField | null;
  listTicketDepartmentFields(departmentId: string): TicketDepartmentField[];
}

type BindingSelection = {
  category?: CategoryChannel;
  logChannel?: GuildTextBasedChannel;
  supportRole?: Role;
};

type ResourceResult<T> =
  { valid: true; value: T } | { valid: false; message: string };

export async function handleTicketDepartmentCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  actor: GuildMember,
): Promise<void> {
  await deferPrivate(interaction);
  const guild = interaction.guild;
  if (
    !guild ||
    !interaction.guildId ||
    guild.id !== interaction.guildId ||
    guild.id !== runtime.guildId
  ) {
    await replyPrivate(
      interaction,
      "Ticket departments can only be configured inside this server.",
    );
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const storage = runtime.storage as unknown as TicketDepartmentStorage;
  try {
    if (group === "department") {
      switch (subcommand) {
        case "list":
          await listDepartments(interaction, runtime, storage);
          return;
        case "create":
          await createDepartment(interaction, runtime, storage, actor);
          return;
        case "edit":
          await editDepartment(interaction, runtime, storage, actor);
          return;
        case "enable":
          await enableDepartment(interaction, runtime, storage, actor);
          return;
        case "disable":
          await disableDepartment(interaction, runtime, storage);
          return;
        case "delete":
          await deleteDepartment(interaction, runtime, storage);
          return;
        case "health":
          await showDepartmentHealth(interaction, runtime, storage);
          return;
        default:
          break;
      }
    }
    if (group === "field") {
      switch (subcommand) {
        case "add":
          await addField(interaction, runtime, storage);
          return;
        case "edit":
          await editField(interaction, runtime, storage);
          return;
        case "remove":
          await removeField(interaction, runtime, storage);
          return;
        case "move":
          await moveField(interaction, runtime, storage);
          return;
        default:
          break;
      }
    }
    await replyPrivate(
      interaction,
      "Choose a supported ticket department operation.",
    );
  } catch (error) {
    await replyPrivate(interaction, commandErrorMessage(error));
    runtime.storage.recordCommandMetric(
      `ticket.${group ?? "department"}`,
      false,
    );
  }
}

async function listDepartments(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const page = interaction.options.getInteger("page", false) ?? 1;
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    await replyPrivate(
      interaction,
      "Department page must be between 1 and 100.",
    );
    return;
  }
  const total = Math.min(storage.countTicketDepartments(), MAX_DEPARTMENTS);
  const departments = storage
    .listTicketDepartments({
      limit: DEPARTMENT_PAGE_SIZE,
      offset: (page - 1) * DEPARTMENT_PAGE_SIZE,
    })
    .filter((department) => department.guildId === runtime.guildId)
    .slice(0, DEPARTMENT_PAGE_SIZE);
  if (departments.length === 0) {
    await replyPrivate(
      interaction,
      page === 1
        ? "No ticket departments are configured."
        : `No ticket departments were found on page ${page}.`,
    );
    return;
  }
  const lines = departments.map((department) => {
    const fields = safeDepartmentFields(storage, department, runtime.guildId);
    const form =
      fields.length === 0
        ? "default form"
        : `${fields.length} custom field${fields.length === 1 ? "" : "s"}`;
    return `- ${department.enabled ? "Enabled" : "Disabled"} - **${escapeMarkdown(department.displayName)}** (\`${department.slug}\`, order ${department.sortOrder}, ${form})`;
  });
  await replyPrivate(
    interaction,
    [
      `**Ticket departments - page ${page}**`,
      `Configured: ${total}/${MAX_DEPARTMENTS}`,
      ...lines,
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("ticket.department.list");
}

async function createDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
  actor: GuildMember,
): Promise<void> {
  if (storage.countTicketDepartments() >= MAX_DEPARTMENTS) {
    await replyPrivate(
      interaction,
      `This server already has the maximum of ${MAX_DEPARTMENTS} ticket departments.`,
    );
    return;
  }
  const slug = readDepartmentSlug(interaction);
  if (storage.getTicketDepartmentBySlug(slug)) {
    await replyPrivate(
      interaction,
      `A ticket department already uses the slug \`${slug}\`.`,
    );
    return;
  }
  const bindings = await readBindingSelection(interaction, runtime, true);
  if (!bindings.valid) {
    await replyPrivate(interaction, bindings.message);
    return;
  }
  if (
    bindings.value.supportRole &&
    cannotAssignSupportRole(
      actor,
      interaction.guild!,
      bindings.value.supportRole.id,
      null,
    )
  ) {
    await replyPrivate(interaction, supportRoleSelfEscalationMessage());
    return;
  }
  if (
    !(await allowTicketContentDestination(
      interaction,
      runtime,
      bindings.value.logChannel!,
      bindings.value.supportRole!.id,
    ))
  ) {
    return;
  }
  const displayName = normalizeSingleLine(
    interaction.options.getString("name", true),
    "Department name",
    80,
  );
  const description = normalizeMultilineText(
    interaction.options.getString("description", true),
    "Department description",
    1,
    1_000,
  );
  const emoji = normalizeEmoji(
    interaction.options.getString("emoji", false),
    false,
  );
  const requestedOrder = interaction.options.getInteger("sort_order", false);
  const sortOrder = normalizeDepartmentOrder(
    requestedOrder ?? Math.min(storage.countTicketDepartments(), 9),
  );
  if (!(await ensureCurrent(interaction, runtime))) return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after department configuration was verified. No department was created.",
    );
    return;
  }

  const created = storage.createTicketDepartment({
    slug,
    displayName,
    description,
    emoji: emoji ?? null,
    categoryId: bindings.value.category!.id,
    logChannelId: bindings.value.logChannel!.id,
    supportRoleId: bindings.value.supportRole!.id,
    enabled: false,
    sortOrder,
    bindingsVerifiedAt: null,
  });
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Created **${escapeMarkdown(created.displayName)}** (\`${created.slug}\`) in a disabled state. Review \`/ticket department health\`, then enable it when ready.`,
  );
  runtime.storage.recordCommandMetric("ticket.department.create");
}

async function editDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
  actor: GuildMember,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const rawName = interaction.options.getString("name", false);
  const rawDescription = interaction.options.getString("description", false);
  const rawEmoji = interaction.options.getString("emoji", false);
  const rawOrder = interaction.options.getInteger("sort_order", false);
  const bindings = await readBindingSelection(interaction, runtime, false);
  if (!bindings.valid) {
    await replyPrivate(interaction, bindings.message);
    return;
  }
  if (
    bindings.value.supportRole &&
    cannotAssignSupportRole(
      actor,
      interaction.guild!,
      bindings.value.supportRole.id,
      department.supportRoleId,
    )
  ) {
    await replyPrivate(interaction, supportRoleSelfEscalationMessage());
    return;
  }
  if (
    bindings.value.logChannel &&
    bindings.value.logChannel.id !== department.logChannelId &&
    !(await allowTicketContentDestination(
      interaction,
      runtime,
      bindings.value.logChannel,
      bindings.value.supportRole?.id ?? department.supportRoleId,
    ))
  ) {
    return;
  }

  const update: TicketDepartmentUpdate = {};
  if (rawName !== null) {
    update.displayName = normalizeSingleLine(rawName, "Department name", 80);
  }
  if (rawDescription !== null) {
    update.description = normalizeMultilineText(
      rawDescription,
      "Department description",
      1,
      1_000,
    );
  }
  if (rawEmoji !== null) update.emoji = normalizeEmoji(rawEmoji, true) ?? null;
  if (rawOrder !== null) update.sortOrder = normalizeDepartmentOrder(rawOrder);
  if (bindings.value.category) {
    update.categoryId = bindings.value.category.id;
  }
  if (bindings.value.logChannel) {
    update.logChannelId = bindings.value.logChannel.id;
  }
  if (bindings.value.supportRole) {
    update.supportRoleId = bindings.value.supportRole.id;
  }
  const bindingsChanged =
    (update.categoryId !== undefined &&
      update.categoryId !== department.categoryId) ||
    (update.logChannelId !== undefined &&
      update.logChannelId !== department.logChannelId) ||
    (update.supportRoleId !== undefined &&
      update.supportRoleId !== department.supportRoleId);
  if (bindingsChanged) {
    update.enabled = false;
    update.bindingsVerifiedAt = null;
  }
  if (Object.keys(update).length === 0) {
    await replyPrivate(
      interaction,
      "Choose at least one department setting to edit.",
    );
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (
    bindingsChanged &&
    storage.hasActiveTicketsForDepartment(department.departmentId)
  ) {
    await replyPrivate(
      interaction,
      "Close or recover every active ticket in this department before changing its category, log channel, or support role.",
    );
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the department was verified. No department settings were saved.",
    );
    return;
  }

  const saved = storage.updateTicketDepartment(department.departmentId, update);
  if (!saved || saved.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That ticket department changed or was deleted before it could be saved.",
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    bindingsChanged
      ? `Updated **${escapeMarkdown(saved.displayName)}** and disabled it because its Discord routing changed. Review its health before enabling it again.`
      : `Updated **${escapeMarkdown(saved.displayName)}** (\`${saved.slug}\`).`,
  );
  runtime.storage.recordCommandMetric("ticket.department.edit");
}

async function enableDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
  actor: GuildMember,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  if (!isConfiguredDepartment(department)) {
    await replyPrivate(
      interaction,
      "That department needs a category, log channel, and support role before it can be enabled.",
    );
    return;
  }
  const fields = safeDepartmentFields(storage, department, runtime.guildId);
  if (fields.length > MAX_FIELDS) {
    await replyPrivate(
      interaction,
      `That department exceeds the ${MAX_FIELDS}-field form limit and cannot be enabled.`,
    );
    return;
  }
  if (
    cannotAssignSupportRole(
      actor,
      interaction.guild!,
      department.supportRoleId,
      department.bindingsVerifiedAt === null ? null : department.supportRoleId,
    )
  ) {
    await replyPrivate(interaction, supportRoleSelfEscalationMessage());
    return;
  }
  const resources = await inspectTicketConfigurationResources(
    interaction.guild!,
    departmentConfiguration(department),
    runtime.storage,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Department health needs attention before enabling: ${resources.issues.join(" ")}`,
    );
    return;
  }
  if (
    !resources.logChannel ||
    !resources.supportRole ||
    !(await allowTicketContentDestination(
      interaction,
      runtime,
      resources.logChannel,
      resources.supportRole.id,
    ))
  ) {
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after department bindings were verified. The department was not enabled.",
    );
    return;
  }

  const verified = storage.updateTicketDepartment(department.departmentId, {
    bindingsVerifiedAt: nowIso(runtime),
  });
  if (!verified) {
    await replyPrivate(
      interaction,
      "That ticket department was deleted before verification could be recorded.",
    );
    return;
  }
  const enabled = department.enabled
    ? verified
    : storage.setTicketDepartmentEnabled(department.departmentId, true);
  if (!enabled || enabled.guildId !== runtime.guildId) {
    runtime.invalidate();
    await replyPrivate(
      interaction,
      "Verification was recorded, but the department remained disabled. Review it and try again.",
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    department.enabled
      ? `**${escapeMarkdown(enabled.displayName)}** was already enabled; its Discord bindings and permissions were verified again.`
      : `Enabled **${escapeMarkdown(enabled.displayName)}**. New tickets can now use this department.`,
  );
  runtime.storage.recordCommandMetric("ticket.department.enable");
}

async function disableDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  if (!department.enabled) {
    await replyPrivate(
      interaction,
      `**${escapeMarkdown(department.displayName)}** is already disabled.`,
    );
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the department was verified. It was not disabled.",
    );
    return;
  }
  const disabled = storage.setTicketDepartmentEnabled(
    department.departmentId,
    false,
  );
  if (!disabled || disabled.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That ticket department changed or was deleted before it could be disabled.",
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Disabled **${escapeMarkdown(disabled.displayName)}**. Existing tickets and records were preserved.`,
  );
  runtime.storage.recordCommandMetric("ticket.department.disable");
}

async function deleteDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  if (department.enabled) {
    await replyPrivate(
      interaction,
      "Disable that ticket department before deleting it.",
    );
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the department was verified. It was not deleted.",
    );
    return;
  }
  const result = storage.deleteTicketDepartment(department.departmentId);
  if (result.status === "in-use") {
    await replyPrivate(
      interaction,
      "That department has ticket records and cannot be deleted. Keep it disabled for historical routing and recovery.",
    );
    return;
  }
  if (result.status === "not-found") {
    await replyPrivate(
      interaction,
      "That ticket department was already deleted.",
    );
    return;
  }
  if (!result.department) {
    await replyPrivate(
      interaction,
      "That ticket department was already deleted.",
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Deleted the unused department **${escapeMarkdown(result.department.displayName)}**.`,
  );
  runtime.storage.recordCommandMetric("ticket.department.delete");
}

async function showDepartmentHealth(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const fields = safeDepartmentFields(storage, department, runtime.guildId);
  const issues: string[] = [];
  if (!isConfiguredDepartment(department)) {
    if (!department.categoryId)
      issues.push("The ticket category is not configured.");
    if (!department.logChannelId)
      issues.push("The ticket log channel is not configured.");
    if (!department.supportRoleId)
      issues.push("The ticket support role is not configured.");
  } else {
    const resources = await inspectTicketConfigurationResources(
      interaction.guild!,
      departmentConfiguration(department),
      runtime.storage,
    );
    issues.push(...resources.issues);
  }
  if (fields.length > MAX_FIELDS) {
    issues.push(`The department has more than ${MAX_FIELDS} form fields.`);
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  const fieldSummary =
    fields.length === 0
      ? "Default subject and details form"
      : `${fields.length} custom field${fields.length === 1 ? "" : "s"}`;
  await replyPrivate(
    interaction,
    [
      `**Ticket department health: ${escapeMarkdown(department.displayName)}**`,
      `Slug: \`${department.slug}\``,
      `State: **${department.enabled ? "enabled" : "disabled"}**`,
      `Form: ${fieldSummary}`,
      `Bindings last verified: ${department.bindingsVerifiedAt ? `\`${department.bindingsVerifiedAt}\`` : "not recorded"}`,
      issues.length === 0
        ? "Routing resources and Superior permissions are ready."
        : `Needs attention:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    ]
      .join("\n")
      .slice(0, 2_000),
  );
  runtime.storage.recordCommandMetric("ticket.department.health");
}

async function addField(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const fieldId = readFieldId(interaction);
  const fields = safeDepartmentFields(storage, department, runtime.guildId);
  if (fields.length >= MAX_FIELDS) {
    await replyPrivate(
      interaction,
      `That department already has the maximum of ${MAX_FIELDS} custom fields.`,
    );
    return;
  }
  if (
    fields.some((field) => field.fieldId === fieldId) ||
    storage.getTicketDepartmentField(department.departmentId, fieldId)
  ) {
    await replyPrivate(
      interaction,
      `A field already uses the key \`${fieldId}\` in that department.`,
    );
    return;
  }
  const position = readPosition(interaction, true);
  if (position > fields.length) {
    await replyPrivate(
      interaction,
      `A new field position must be between 0 and ${fields.length}.`,
    );
    return;
  }
  const input = readFieldInput(interaction, null, fieldId);
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the field was verified. No field was added.",
    );
    return;
  }

  let created: TicketDepartmentField | null = null;
  try {
    created = storage.upsertTicketDepartmentField(
      department.departmentId,
      input,
    );
    const order = orderedFieldIds(fields);
    order.splice(position, 0, created.fieldId);
    storage.reorderTicketDepartmentFields(department.departmentId, order);
  } catch (error) {
    if (created) {
      storage.removeTicketDepartmentField(
        department.departmentId,
        created.fieldId,
      );
    }
    throw error;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Added **${escapeMarkdown(created.label)}** (\`${created.fieldId}\`) to **${escapeMarkdown(department.displayName)}** at position ${position}.`,
  );
  runtime.storage.recordCommandMetric("ticket.field.add");
}

async function editField(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const fieldId = readFieldId(interaction);
  const field = storage.getTicketDepartmentField(
    department.departmentId,
    fieldId,
  );
  if (!isDepartmentField(field, department, runtime.guildId)) {
    await replyPrivate(
      interaction,
      `Field \`${fieldId}\` was not found in that department.`,
    );
    return;
  }
  const fields = safeDepartmentFields(storage, department, runtime.guildId);
  const rawPosition = interaction.options.getInteger("position", false);
  const hasMetadataEdit = hasAnyFieldEditOption(interaction);
  if (!hasMetadataEdit && rawPosition === null) {
    await replyPrivate(
      interaction,
      "Choose at least one field setting to edit.",
    );
    return;
  }
  const position =
    rawPosition === null ? null : normalizeFieldPosition(rawPosition);
  if (position !== null && position >= fields.length) {
    await replyPrivate(
      interaction,
      `An existing field position must be between 0 and ${Math.max(0, fields.length - 1)}.`,
    );
    return;
  }
  const currentIndex = fields.findIndex(
    (candidate) => candidate.fieldId === fieldId,
  );
  if (currentIndex < 0) {
    await replyPrivate(
      interaction,
      "That field changed while its order was being inspected. Please try again.",
    );
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the field was verified. No field changes were saved.",
    );
    return;
  }

  let saved = field;
  if (hasMetadataEdit) {
    saved = storage.upsertTicketDepartmentField(
      department.departmentId,
      readFieldInput(interaction, field, field.fieldId),
    );
  }
  if (position !== null && position !== currentIndex) {
    const order = orderedFieldIds(fields).filter((id) => id !== field.fieldId);
    order.splice(position, 0, field.fieldId);
    storage.reorderTicketDepartmentFields(department.departmentId, order);
  }
  if (!hasMetadataEdit && position === currentIndex) {
    await replyPrivate(
      interaction,
      `Field \`${field.fieldId}\` is already at position ${currentIndex}.`,
    );
    return;
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Updated **${escapeMarkdown(saved.label)}** (\`${saved.fieldId}\`) in **${escapeMarkdown(department.displayName)}**.`,
  );
  runtime.storage.recordCommandMetric("ticket.field.edit");
}

async function removeField(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const fieldId = readFieldId(interaction);
  const field = storage.getTicketDepartmentField(
    department.departmentId,
    fieldId,
  );
  if (!isDepartmentField(field, department, runtime.guildId)) {
    await replyPrivate(
      interaction,
      `Field \`${fieldId}\` was not found in that department.`,
    );
    return;
  }
  const remaining = safeDepartmentFields(storage, department, runtime.guildId)
    .filter((candidate) => candidate.fieldId !== field.fieldId)
    .sort(compareFields);
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the field was verified. No field was removed.",
    );
    return;
  }
  if (
    !storage.removeTicketDepartmentField(department.departmentId, field.fieldId)
  ) {
    await replyPrivate(
      interaction,
      "That field was already removed before the change could be saved.",
    );
    return;
  }
  if (remaining.length > 0) {
    storage.reorderTicketDepartmentFields(
      department.departmentId,
      remaining.map((candidate) => candidate.fieldId),
    );
  }
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Removed **${escapeMarkdown(field.label)}** (\`${field.fieldId}\`) from **${escapeMarkdown(department.displayName)}**.`,
  );
  runtime.storage.recordCommandMetric("ticket.field.remove");
}

async function moveField(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<void> {
  const department = await findDepartment(interaction, runtime, storage);
  if (!department) return;
  const fieldId = readFieldId(interaction);
  const fields = safeDepartmentFields(storage, department, runtime.guildId);
  const currentIndex = fields.findIndex((field) => field.fieldId === fieldId);
  if (currentIndex < 0) {
    await replyPrivate(
      interaction,
      `Field \`${fieldId}\` was not found in that department.`,
    );
    return;
  }
  const position = readPosition(interaction, true);
  if (position >= fields.length) {
    await replyPrivate(
      interaction,
      `An existing field position must be between 0 and ${Math.max(0, fields.length - 1)}.`,
    );
    return;
  }
  if (position === currentIndex) {
    await replyPrivate(
      interaction,
      `Field \`${fieldId}\` is already at position ${position}.`,
    );
    return;
  }
  if (!(await ensureUnchanged(interaction, runtime, storage, department)))
    return;
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the field was verified. No field was moved.",
    );
    return;
  }
  const order = orderedFieldIds(fields).filter((id) => id !== fieldId);
  order.splice(position, 0, fieldId);
  storage.reorderTicketDepartmentFields(department.departmentId, order);
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `Moved field \`${fieldId}\` to position ${position} in **${escapeMarkdown(department.displayName)}**.`,
  );
  runtime.storage.recordCommandMetric("ticket.field.move");
}

async function findDepartment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
): Promise<TicketDepartment | null> {
  const slug = readDepartmentSlug(interaction);
  const department = storage.getTicketDepartmentBySlug(slug);
  if (department?.guildId === runtime.guildId) return department;
  await replyPrivate(
    interaction,
    `Ticket department \`${slug}\` was not found in this server.`,
  );
  return null;
}

async function readBindingSelection(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  required: boolean,
): Promise<ResourceResult<BindingSelection>> {
  const guild = interaction.guild!;
  const rawCategory = interaction.options.getChannel("category", required);
  const rawLogChannel = interaction.options.getChannel("log_channel", required);
  const rawSupportRole = interaction.options.getRole("support_role", required);
  if (required && (!rawCategory || !rawLogChannel || !rawSupportRole)) {
    return {
      valid: false,
      message:
        "Choose a category, log channel, and support role from this server.",
    };
  }
  const [category, logChannel, supportRole] = await Promise.all([
    rawCategory
      ? fetchCategory(guild, rawCategory)
      : Promise.resolve({ valid: true, value: undefined } as const),
    rawLogChannel
      ? fetchLogChannel(guild, rawLogChannel)
      : Promise.resolve({ valid: true, value: undefined } as const),
    rawSupportRole
      ? fetchSupportRole(guild, rawSupportRole)
      : Promise.resolve({ valid: true, value: undefined } as const),
  ]);
  if (!category.valid) return category;
  if (!logChannel.valid) return logChannel;
  if (!supportRole.valid) return supportRole;
  if (!runtime.isCurrent()) {
    return {
      valid: false,
      message:
        "This server changed while Discord resources were being verified. Please try again.",
    };
  }
  const value: BindingSelection = {};
  if (category.value) value.category = category.value;
  if (logChannel.value) value.logChannel = logChannel.value;
  if (supportRole.value) value.supportRole = supportRole.value;
  return { valid: true, value };
}

async function fetchCategory(
  guild: Guild,
  selected: { id: string },
): Promise<ResourceResult<CategoryChannel>> {
  if (!belongsToGuild(selected, guild.id)) {
    return { valid: false, message: "Choose a category from this server." };
  }
  const channel = await fetchFreshChannel(guild, selected.id);
  if (
    !channel ||
    channel.guild.id !== guild.id ||
    channel.type !== ChannelType.GuildCategory
  ) {
    return {
      valid: false,
      message:
        "That category was deleted, changed type, or could not be freshly verified.",
    };
  }
  return { valid: true, value: channel };
}

async function fetchLogChannel(
  guild: Guild,
  selected: { id: string },
): Promise<ResourceResult<GuildTextBasedChannel>> {
  if (!belongsToGuild(selected, guild.id)) {
    return {
      valid: false,
      message: "Choose a text or announcement log channel from this server.",
    };
  }
  const channel = await fetchFreshChannel(guild, selected.id);
  if (
    !channel ||
    channel.guild.id !== guild.id ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement) ||
    channel.isDMBased()
  ) {
    return {
      valid: false,
      message:
        "That log channel was deleted, changed type, or could not be freshly verified.",
    };
  }
  return { valid: true, value: channel };
}

async function fetchSupportRole(
  guild: Guild,
  selected: { id: string },
): Promise<ResourceResult<Role>> {
  if (!belongsToGuild(selected, guild.id)) {
    return {
      valid: false,
      message: "Choose a support role from this server.",
    };
  }
  const role = await fetchAndValidateRole(guild, selected.id);
  if (!role.valid) {
    const message =
      role.reason === "role-everyone"
        ? "The server-wide everyone role cannot be a ticket support role."
        : role.reason === "role-managed"
          ? "Managed or integration roles cannot be ticket support roles."
          : role.reason === "role-mismatch"
            ? "Choose a support role from this server."
            : "That support role was deleted or could not be freshly verified.";
    return { valid: false, message };
  }
  return { valid: true, value: role.role };
}

async function fetchFreshChannel(
  guild: Guild,
  channelId: string,
): Promise<GuildBasedChannel | null> {
  return guild.channels
    .fetch(channelId, { cache: true, force: true })
    .catch(() => null);
}

function belongsToGuild(value: object, guildId: string): boolean {
  return (
    "guild" in value &&
    (value as { guild?: { id?: unknown } }).guild?.id === guildId
  );
}

function cannotAssignSupportRole(
  actor: GuildMember,
  guild: Guild,
  selectedRoleId: string,
  currentRoleId: string | null,
): boolean {
  if (selectedRoleId === currentRoleId) return false;
  if (actor.guild.id !== guild.id) return true;
  if (actor.id === guild.ownerId) return false;
  if (actor.permissions.has(PermissionFlagsBits.Administrator)) return false;
  return actor.roles.cache.has(selectedRoleId);
}

async function allowTicketContentDestination(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  logChannel: GuildTextBasedChannel,
  supportRoleId: string | null,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const boundary = await inspectContentDestinationBoundary({
    guild,
    userId: interaction.user.id,
    capability: "tickets.manage",
    configuredRoleId: supportRoleId,
    grants: runtime.storage,
    channel: logChannel,
  });
  if (!runtime.isCurrent() || boundary === "unverifiable") {
    await replyPrivate(
      interaction,
      "Superior could not verify the current ticket-content boundary. No routing was changed; try again.",
    );
    return false;
  }
  if (boundary === "visible-without-authority") {
    await replyPrivate(
      interaction,
      "A configuration-only delegate cannot route ticket transcripts to a log channel they can read without ticket-management or support-role authority. Ask the server owner or an Administrator to choose that destination.",
    );
    return false;
  }
  return true;
}

function supportRoleSelfEscalationMessage(): string {
  return "A `tickets.configure` delegate cannot select a support role they currently hold because that would also grant ticket-content access. Ask the server owner or an Administrator to make this access change.";
}

function readDepartmentSlug(interaction: ChatInputCommandInteraction): string {
  return normalizeSlug(
    interaction.options.getString("department", true),
    "Department slug",
    32,
  );
}

function readFieldId(interaction: ChatInputCommandInteraction): string {
  const fieldId = interaction.options.getString("field", true).trim();
  if (
    fieldId.length < 8 ||
    fieldId.length > 24 ||
    !/^[A-Za-z0-9_-]+$/u.test(fieldId)
  ) {
    throw new TypeError(
      "Field keys must contain 8-24 letters, numbers, underscores, or hyphens.",
    );
  }
  return fieldId;
}

function readFieldInput(
  interaction: ChatInputCommandInteraction,
  current: TicketDepartmentField | null,
  fieldId: string,
): TicketDepartmentFieldInput {
  const rawLabel = interaction.options.getString("label", false);
  const rawDescription = interaction.options.getString("description", false);
  const rawPlaceholder = interaction.options.getString("placeholder", false);
  const rawType = interaction.options.getString("type", false);
  const rawRequired = interaction.options.getBoolean("required", false);
  const rawMinimum = interaction.options.getInteger("min_length", false);
  const rawMaximum = interaction.options.getInteger("max_length", false);
  if (!current && (rawLabel === null || rawType === null)) {
    throw new TypeError("New fields require a label and text-input type.");
  }
  const fieldType = normalizeFieldType(rawType ?? current?.fieldType);
  const required = rawRequired ?? current?.required ?? true;
  const minLength =
    rawMinimum ??
    (rawRequired === false
      ? 0
      : rawRequired === true && (current?.minLength ?? 0) === 0
        ? 1
        : (current?.minLength ?? (required ? 1 : 0)));
  const maxLength =
    rawMaximum ?? current?.maxLength ?? (fieldType === "short" ? 400 : 2_000);
  validateFieldLengths(required, minLength, maxLength);
  return {
    fieldId,
    label:
      rawLabel === null
        ? current!.label
        : normalizeSingleLine(rawLabel, "Field label", 45),
    description:
      rawDescription === null
        ? (current?.description ?? null)
        : normalizeOptionalFieldText(rawDescription, "Field description"),
    placeholder:
      rawPlaceholder === null
        ? (current?.placeholder ?? null)
        : normalizeOptionalFieldText(rawPlaceholder, "Field placeholder"),
    fieldType,
    required,
    minLength,
    maxLength,
    ...(current ? { sortOrder: current.sortOrder } : {}),
  };
}

function hasAnyFieldEditOption(
  interaction: ChatInputCommandInteraction,
): boolean {
  return (
    interaction.options.getString("label", false) !== null ||
    interaction.options.getString("description", false) !== null ||
    interaction.options.getString("placeholder", false) !== null ||
    interaction.options.getString("type", false) !== null ||
    interaction.options.getBoolean("required", false) !== null ||
    interaction.options.getInteger("min_length", false) !== null ||
    interaction.options.getInteger("max_length", false) !== null
  );
}

function normalizeFieldType(value: unknown): FormFieldType {
  if (value !== "short" && value !== "paragraph") {
    throw new TypeError("Field type must be short or paragraph.");
  }
  return value;
}

function normalizeOptionalFieldText(
  value: string,
  label: string,
): string | null {
  if (value.trim().toLowerCase() === "none") return null;
  return normalizeSingleLine(value, label, 100);
}

function validateFieldLengths(
  required: boolean,
  minimum: number,
  maximum: number,
): void {
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < 1 ||
    maximum > 4_000 ||
    minimum > maximum
  ) {
    throw new RangeError(
      "Field lengths must use 0-4000 characters with minimum no greater than maximum.",
    );
  }
  if ((required && minimum < 1) || (!required && minimum !== 0)) {
    throw new RangeError(
      required
        ? "A required field needs a minimum length of at least 1."
        : "An optional field must use a minimum length of 0.",
    );
  }
}

function normalizeEmoji(
  value: string | null,
  allowClear: boolean,
): string | null | undefined {
  if (value === null) return allowClear ? undefined : null;
  const normalized = value.trim();
  if (allowClear && normalized.toLowerCase() === "none") return null;
  return normalizeUnicodeEmoji(normalized, "Department emoji");
}

function normalizeDepartmentOrder(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= MAX_DEPARTMENTS) {
    throw new RangeError("Department order must be between 0 and 9.");
  }
  return value;
}

function readPosition(
  interaction: ChatInputCommandInteraction,
  required: boolean,
): number {
  const value = interaction.options.getInteger("position", required);
  if (value === null) throw new TypeError("Choose a field position.");
  return normalizeFieldPosition(value);
}

function normalizeFieldPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= MAX_FIELDS) {
    throw new RangeError("Field position must be between 0 and 4.");
  }
  return value;
}

function safeDepartmentFields(
  storage: TicketDepartmentStorage,
  department: TicketDepartment,
  guildId: string,
): TicketDepartmentField[] {
  return storage
    .listTicketDepartmentFields(department.departmentId)
    .filter(
      (field) =>
        field.guildId === guildId &&
        field.departmentId === department.departmentId,
    )
    .sort(compareFields)
    .slice(0, MAX_FIELDS + 1);
}

function orderedFieldIds(fields: readonly TicketDepartmentField[]): string[] {
  return [...fields].sort(compareFields).map((field) => field.fieldId);
}

function compareFields(
  left: TicketDepartmentField,
  right: TicketDepartmentField,
): number {
  return (
    left.sortOrder - right.sortOrder ||
    left.fieldId.localeCompare(right.fieldId)
  );
}

function isDepartmentField(
  field: TicketDepartmentField | null,
  department: TicketDepartment,
  guildId: string,
): field is TicketDepartmentField {
  return Boolean(
    field &&
    field.guildId === guildId &&
    field.departmentId === department.departmentId,
  );
}

function departmentConfiguration(
  department: TicketDepartment & {
    categoryId: string;
    logChannelId: string;
    supportRoleId: string;
  },
): TicketConfiguration {
  return {
    guildId: department.guildId,
    departmentId: department.departmentId,
    enabled: department.enabled,
    categoryId: department.categoryId,
    logChannelId: department.logChannelId,
    supportRoleId: department.supportRoleId,
    createdAt: department.createdAt,
    updatedAt: department.updatedAt,
  };
}

async function ensureCurrent(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (runtime.isCurrent()) return true;
  await replyPrivate(
    interaction,
    "This server changed while the request was being verified. No configuration was changed.",
  );
  return false;
}

async function ensureUnchanged(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: TicketDepartmentStorage,
  expected: TicketDepartment,
): Promise<boolean> {
  if (!(await ensureCurrent(interaction, runtime))) return false;
  const current = storage.getTicketDepartment(expected.departmentId);
  if (!sameDepartmentSnapshot(expected, current, runtime.guildId)) {
    await replyPrivate(
      interaction,
      "That ticket department changed while the request was being verified. Review it and try again.",
    );
    return false;
  }
  return true;
}

function sameDepartmentSnapshot(
  expected: TicketDepartment,
  current: TicketDepartment | null,
  guildId: string,
): boolean {
  return Boolean(
    current &&
    current.guildId === guildId &&
    current.departmentId === expected.departmentId &&
    current.slug === expected.slug &&
    current.enabled === expected.enabled &&
    current.definitionVersion === expected.definitionVersion &&
    current.categoryId === expected.categoryId &&
    current.logChannelId === expected.logChannelId &&
    current.supportRoleId === expected.supportRoleId &&
    current.updatedAt === expected.updatedAt,
  );
}

function nowIso(runtime: GuildRuntime): string {
  return runtime.now().toUTC().toISO() ?? new Date().toISOString();
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof TypeError || error instanceof RangeError) {
    return `No configuration was changed: ${error.message}`.slice(0, 1_000);
  }
  if (
    error instanceof Error &&
    /unique|constraint|already exists/iu.test(error.message)
  ) {
    return "No configuration was changed. A department slug, field key, or field position is already in use.";
  }
  return "Superior could not save that ticket department change. Review the current configuration and try again.";
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function replyPrivate(
  interaction: ChatInputCommandInteraction,
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
