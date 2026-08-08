import {
  ChannelType,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import type { BotRuntime, GuildRuntime } from "../runtime.js";
import type {
  ApplicationDecisionInput,
  ApplicationForm,
  ApplicationFormDeleteResult,
  ApplicationFormField,
  ApplicationFormFieldInput,
  ApplicationFormInput,
  ApplicationFormUpdate,
  ApplicationRecord,
  ApplicationReservationInput,
  ApplicationReservationResult,
  ApplicationState,
  ApplicationTransitionResult,
  RoleCapabilityGrant,
} from "../types.js";
import {
  authorizeCapability,
  authorizeConfiguredRoleOrCapability,
  fetchAndValidateRole,
} from "./authorization.js";
import { inspectContentDestinationBoundary } from "./content-destination-boundary.js";
import {
  applicationStatusMessage,
  createApplicationSubmitModal,
} from "./application-components.js";
import {
  publishReservedApplication,
  refreshApplicationReviewMessage,
  toApplicationFormDisplay,
  toFormFieldInput,
  type ApplicationDeliveryStorage,
} from "./application-delivery.js";
import { validateFormDefinition, type FormFieldInput } from "./forms.js";
import {
  applicationReviewRoleAccessIssue,
  inspectApplicationResources,
} from "./phase2-permissions.js";
import { postFeatureLauncher } from "./preset-panels.js";

const PAGE_SIZE = 10;

export interface ApplicationStorage extends ApplicationDeliveryStorage {
  createApplicationForm(input: ApplicationFormInput): ApplicationForm;
  updateApplicationForm(
    formId: string,
    input: ApplicationFormUpdate,
  ): ApplicationForm | null;
  setApplicationFormEnabled(
    formId: string,
    enabled: boolean,
  ): ApplicationForm | null;
  deleteApplicationForm(formId: string): ApplicationFormDeleteResult;
  getApplicationForm(formId: string): ApplicationForm | null;
  getApplicationFormBySlug(slug: string): ApplicationForm | null;
  listApplicationForms(options?: {
    enabledOnly?: boolean;
    limit?: number;
    offset?: number;
  }): ApplicationForm[];
  listCapabilityGrantsForCapability(
    capability: "applications.review",
    limit?: number,
    offset?: number,
  ): RoleCapabilityGrant[];
  upsertApplicationFormField(
    formId: string,
    input: ApplicationFormFieldInput,
  ): ApplicationFormField;
  removeApplicationFormField(formId: string, fieldId: string): boolean;
  reorderApplicationFormFields(
    formId: string,
    fieldIds: readonly string[],
  ): ApplicationFormField[];
  getApplicationFormField(
    formId: string,
    fieldId: string,
  ): ApplicationFormField | null;
  listApplicationFormFields(formId: string): ApplicationFormField[];
  reserveApplication(
    input: ApplicationReservationInput,
  ): ApplicationReservationResult;
  claimApplication(
    applicationId: string,
    reviewerId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult;
  decideApplication(
    applicationId: string,
    input: ApplicationDecisionInput,
  ): ApplicationTransitionResult;
  withdrawApplication(
    applicationId: string,
    applicantId: string,
    expectedUpdatedAt?: string,
  ): ApplicationTransitionResult;
  getApplicationById(applicationId: string): ApplicationRecord | null;
  hasApplicationsForForm(formId: string): boolean;
  getApplicationByNumber(applicationNumber: number): ApplicationRecord | null;
  listApplications(
    filter?: {
      formId?: string;
      applicantId?: string;
      states?: readonly ApplicationState[];
    },
    limit?: number,
    offset?: number,
  ): ApplicationRecord[];
}

export async function handleApplicationCommand(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<void> {
  const storage = runtime.storage as unknown as ApplicationStorage;
  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();

  if (!group && subcommand === "submit") {
    await showApplicationModal(interaction, storage);
    return;
  }

  await deferPrivate(interaction);
  if (group === "form" || group === "field") {
    if (
      !(await requireCapability(interaction, runtime, "applications.configure"))
    ) {
      return;
    }
    try {
      if (group === "form") {
        await handleFormConfiguration(
          interaction,
          runtime,
          storage,
          subcommand,
        );
      } else {
        await handleFieldConfiguration(
          interaction,
          runtime,
          storage,
          subcommand,
        );
      }
    } catch (error) {
      await replyPrivate(interaction, errorMessage(error));
      runtime.storage.recordCommandMetric(
        `application.${group}.${subcommand}`,
        false,
      );
    }
    return;
  }

  switch (subcommand) {
    case "status":
      await showApplicationStatus(interaction, runtime, storage);
      return;
    case "withdraw":
      await withdrawApplication(interaction, runtime, storage);
      return;
    case "panel":
      if (
        !(await requireCapability(
          interaction,
          runtime,
          "applications.configure",
        ))
      ) {
        return;
      }
      await postApplicationPanel(interaction, runtime, storage);
      return;
    case "recover":
      await recoverApplication(interaction, runtime, storage);
      return;
    default:
      await replyPrivate(
        interaction,
        "Choose a supported application operation.",
      );
  }
}

export async function handleApplicationAutocomplete(
  interaction: AutocompleteInteraction,
  runtime: BotRuntime,
): Promise<boolean> {
  if (interaction.commandName !== "application") return false;
  if (!interaction.guildId || !interaction.guild) {
    await interaction.respond([]);
    return true;
  }
  const guildRuntime = await runtime.forGuild(interaction.guildId);
  if (!guildRuntime?.isCurrent()) {
    await interaction.respond([]);
    return true;
  }
  const focused = String(interaction.options.getFocused() ?? "")
    .trim()
    .toLowerCase();
  const storage = guildRuntime.storage as unknown as ApplicationStorage;
  const forms = storage
    .listApplicationForms({ enabledOnly: true, limit: 25 })
    .filter(isActiveApplicationForm)
    .filter(
      (form) =>
        !focused ||
        form.slug.includes(focused) ||
        form.displayName.toLowerCase().includes(focused),
    )
    .slice(0, 25);
  await interaction.respond(
    forms.map((form) => ({
      name: `${form.displayName} (${form.slug})`.slice(0, 100),
      value: form.slug,
    })),
  );
  return true;
}

async function showApplicationModal(
  interaction: ChatInputCommandInteraction,
  storage: ApplicationStorage,
): Promise<void> {
  const slug = interaction.options.getString("form", true);
  const form = storage.getApplicationFormBySlug(slug);
  if (!isActiveApplicationForm(form)) {
    await replyPrivate(
      interaction,
      "That application form is unavailable or disabled.",
    );
    return;
  }
  const fields = storage.listApplicationFormFields(form.formId);
  try {
    await interaction.showModal(
      createApplicationSubmitModal(
        "command",
        toApplicationFormDisplay(form, fields),
      ),
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
  }
}

async function handleFormConfiguration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  subcommand: string,
): Promise<void> {
  if (subcommand === "list") {
    const page = interaction.options.getInteger("page", false) ?? 1;
    const forms = storage.listApplicationForms({
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    });
    const visible = forms.slice(0, PAGE_SIZE);
    await replyPrivate(
      interaction,
      visible.length === 0
        ? `No application forms were found on page ${page}.`
        : [
            `**Application forms · page ${page}**`,
            ...visible.map(
              (form) =>
                `- \`${form.slug}\` · **${escapeMarkdown(form.displayName)}** · ${form.enabled ? "enabled" : "disabled"} · ${storage.listApplicationFormFields(form.formId).length} field(s)`,
            ),
            ...(forms.length > PAGE_SIZE
              ? [`More results are available on page ${page + 1}.`]
              : []),
          ].join("\n"),
    );
    runtime.storage.recordCommandMetric("application.form.list");
    return;
  }

  const slug = interaction.options.getString("form", true);
  if (subcommand === "create") {
    const form = await readAndVerifyFormInput(interaction, runtime, slug);
    if (!form) return;
    if (
      !(await allowApplicationReviewerRoleAssignment(
        interaction,
        runtime,
        storage,
        form.reviewerRoleId,
        form.reviewChannelId,
        null,
      ))
    ) {
      return;
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after the application form was verified. No form was created.",
      );
      return;
    }
    const saved = storage.createApplicationForm({ ...form, enabled: false });
    runtime.invalidate();
    await replyPrivate(
      interaction,
      `Created disabled application form **${escapeMarkdown(saved.displayName)}** (\`${saved.slug}\`). Add 1-5 questions, then enable it.`,
    );
    runtime.storage.recordCommandMetric("application.form.create");
    return;
  }

  const current = storage.getApplicationFormBySlug(slug);
  if (!current) {
    await replyPrivate(
      interaction,
      `Application form \`${escapeMarkdown(slug)}\` was not found.`,
    );
    return;
  }
  if (subcommand === "edit") {
    const update = await readAndVerifyFormUpdate(interaction, runtime, current);
    if (!update) return;
    if (
      !(await allowApplicationReviewerRoleAssignment(
        interaction,
        runtime,
        storage,
        update.reviewerRoleId ?? current.reviewerRoleId,
        update.reviewChannelId ?? current.reviewChannelId,
        current,
      ))
    ) {
      return;
    }
    const reviewRoutingChanged =
      (update.reviewerRoleId !== undefined &&
        update.reviewerRoleId !== current.reviewerRoleId) ||
      (update.reviewChannelId !== undefined &&
        update.reviewChannelId !== current.reviewChannelId);
    if (
      reviewRoutingChanged &&
      storage.hasApplicationsForForm(current.formId)
    ) {
      await replyPrivate(
        interaction,
        "This form already has application history. Its reviewer role and private review channel cannot be changed; disable and archive it, then create a new form for new routing.",
      );
      return;
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after the application form was verified. No form changes were saved.",
      );
      return;
    }
    const saved = storage.updateApplicationForm(current.formId, {
      ...update,
      enabled: false,
    });
    runtime.invalidate();
    await replyPrivate(
      interaction,
      `Updated **${escapeMarkdown(saved!.displayName)}** and disabled it pending review.`,
    );
    runtime.storage.recordCommandMetric("application.form.edit");
    return;
  }
  if (subcommand === "enable") {
    const candidate = {
      ...current,
      bindingsVerifiedAt: new Date().toISOString(),
    };
    const fields = storage.listApplicationFormFields(current.formId);
    try {
      validateFormDefinition(fields.map(toFormFieldInput));
    } catch (error) {
      await replyPrivate(
        interaction,
        `The form questions are invalid: ${errorMessage(error)}`,
      );
      return;
    }
    const resources = await inspectApplicationResources(
      interaction.guild!,
      candidate,
    );
    if (!resources.reviewChannel || resources.issues.length > 0) {
      await replyPrivate(interaction, resources.issues.join(" "));
      return;
    }
    if (
      !(await allowApplicationReviewerRoleAssignment(
        interaction,
        runtime,
        storage,
        current.reviewerRoleId,
        current.reviewChannelId,
        current,
      ))
    ) {
      return;
    }
    if (
      !(await verifyDelegatedApplicationReviewAccess(
        interaction,
        runtime,
        storage,
        resources.reviewChannel,
      ))
    ) {
      return;
    }
    if (
      !(await allowApplicationContentDestination(
        interaction,
        runtime,
        resources.reviewChannel,
        current.reviewerRoleId,
      ))
    ) {
      return;
    }
    const latest = storage.getApplicationForm(current.formId);
    if (
      !runtime.isCurrent() ||
      !latest ||
      !sameApplicationForm(current, latest)
    ) {
      await replyPrivate(
        interaction,
        "The application form changed during binding verification. Try again.",
      );
      return;
    }
    storage.updateApplicationForm(current.formId, {
      bindingsVerifiedAt: candidate.bindingsVerifiedAt,
      enabled: true,
    });
    runtime.invalidate();
    await replyPrivate(
      interaction,
      `Enabled application form **${escapeMarkdown(current.displayName)}**.`,
    );
    runtime.storage.recordCommandMetric("application.form.enable");
    return;
  }
  if (subcommand === "disable") {
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after access was verified. The application form was not disabled.",
      );
      return;
    }
    storage.setApplicationFormEnabled(current.formId, false);
    runtime.invalidate();
    await replyPrivate(
      interaction,
      `Disabled application form **${escapeMarkdown(current.displayName)}**.`,
    );
    runtime.storage.recordCommandMetric("application.form.disable");
    return;
  }
  if (subcommand === "delete") {
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after access was verified. The application form was not deleted.",
      );
      return;
    }
    const result = storage.deleteApplicationForm(current.formId);
    if (result.status === "deleted") runtime.invalidate();
    await replyPrivate(
      interaction,
      result.status === "deleted"
        ? `Deleted unused application form **${escapeMarkdown(current.displayName)}**.`
        : "That form has application history and cannot be deleted; disable it instead.",
    );
    runtime.storage.recordCommandMetric(
      "application.form.delete",
      result.status === "deleted",
    );
    return;
  }
  await replyPrivate(interaction, "Choose a supported form operation.");
}

const CAPABILITY_GRANT_PAGE_SIZE = 100;
const MAX_APPLICATION_REVIEW_GRANTS = 250;

async function verifyDelegatedApplicationReviewAccess(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  reviewChannel: TextChannel,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Could not verify delegated application reviewers in this server.",
    );
    return false;
  }
  const grants = listApplicationReviewGrants(storage);
  if (!grants) {
    await replyPrivate(
      interaction,
      `Application forms support at most ${MAX_APPLICATION_REVIEW_GRANTS} active \`applications.review\` role grants. Revoke unused grants before enabling this form.`,
    );
    return false;
  }
  if (grants.length === 0) return true;

  const roles = await fetchCurrentGuildRoles(guild);
  if (!roles) {
    await replyPrivate(
      interaction,
      "Superior could not verify current delegated application reviewer roles. Try again.",
    );
    return false;
  }
  for (const grant of grants) {
    const role = roles.get(grant.roleId);
    // Stale or now-invalid grants are already unusable at authorization time
    // and should not prevent owner/Administrator recovery.
    if (
      !role ||
      role.guild.id !== guild.id ||
      role.id === guild.id ||
      role.managed
    ) {
      continue;
    }
    const issue = applicationReviewRoleAccessIssue(reviewChannel, role);
    if (issue) {
      await replyPrivate(
        interaction,
        `Cannot enable this form while active \`applications.review\` role **${escapeMarkdown(role.name)}** (\`${role.id}\`) lacks private review-channel access. ${issue}`,
      );
      return false;
    }
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while delegated application review access was being verified. Try again.",
    );
    return false;
  }
  return true;
}

function listApplicationReviewGrants(
  storage: ApplicationStorage,
): RoleCapabilityGrant[] | null {
  const grants: RoleCapabilityGrant[] = [];
  for (
    let offset = 0;
    offset < MAX_APPLICATION_REVIEW_GRANTS;
    offset += CAPABILITY_GRANT_PAGE_SIZE
  ) {
    const limit = Math.min(
      CAPABILITY_GRANT_PAGE_SIZE,
      MAX_APPLICATION_REVIEW_GRANTS - offset,
    );
    const page = storage.listCapabilityGrantsForCapability(
      "applications.review",
      limit,
      offset,
    );
    grants.push(...page);
    if (page.length < limit) return grants;
  }
  return storage.listCapabilityGrantsForCapability(
    "applications.review",
    1,
    MAX_APPLICATION_REVIEW_GRANTS,
  ).length > 0
    ? null
    : grants;
}

async function fetchCurrentGuildRoles(
  guild: Guild,
): Promise<Map<string, Role> | null> {
  const roles = await guild.roles.fetch().catch(() => null);
  return roles &&
    [...roles.values()].every((role) => role.guild.id === guild.id)
    ? roles
    : null;
}

async function handleFieldConfiguration(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  subcommand: string,
): Promise<void> {
  const slug = interaction.options.getString("form", true);
  const form = storage.getApplicationFormBySlug(slug);
  if (!form) {
    await replyPrivate(
      interaction,
      `Application form \`${escapeMarkdown(slug)}\` was not found.`,
    );
    return;
  }
  const fieldId = interaction.options.getString("field", true);
  const current = storage.getApplicationFormField(form.formId, fieldId);

  if (subcommand === "remove") {
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after access was verified. No application question was removed.",
      );
      return;
    }
    if (current) storage.setApplicationFormEnabled(form.formId, false);
    const removed = storage.removeApplicationFormField(form.formId, fieldId);
    if (current || removed) runtime.invalidate();
    await replyPrivate(
      interaction,
      removed
        ? `Removed question \`${escapeMarkdown(fieldId)}\`; the form remains disabled.`
        : `Question \`${escapeMarkdown(fieldId)}\` was not found.`,
    );
    runtime.storage.recordCommandMetric("application.field.remove", removed);
    return;
  }
  if (subcommand === "move") {
    if (!current) {
      await replyPrivate(
        interaction,
        `Question \`${escapeMarkdown(fieldId)}\` was not found.`,
      );
      return;
    }
    const position = interaction.options.getInteger("position", true);
    const fields = storage.listApplicationFormFields(form.formId);
    const remaining = fields.filter((field) => field.fieldId !== fieldId);
    if (position > remaining.length) {
      await replyPrivate(
        interaction,
        `Position must be between 0 and ${remaining.length}.`,
      );
      return;
    }
    if (!runtime.isCurrent()) {
      await replyPrivate(
        interaction,
        "This server changed after access was verified. No application question was moved.",
      );
      return;
    }
    storage.setApplicationFormEnabled(form.formId, false);
    remaining.splice(position, 0, current);
    storage.reorderApplicationFormFields(
      form.formId,
      remaining.map((field) => field.fieldId),
    );
    runtime.invalidate();
    await replyPrivate(
      interaction,
      `Moved question \`${escapeMarkdown(fieldId)}\` to position ${position}; the form remains disabled.`,
    );
    runtime.storage.recordCommandMetric("application.field.move");
    return;
  }
  if (subcommand !== "add" && subcommand !== "edit") {
    await replyPrivate(interaction, "Choose a supported field operation.");
    return;
  }
  if (subcommand === "edit" && !current) {
    await replyPrivate(
      interaction,
      `Question \`${escapeMarkdown(fieldId)}\` was not found.`,
    );
    return;
  }
  if (subcommand === "add" && current) {
    await replyPrivate(
      interaction,
      `Question \`${escapeMarkdown(fieldId)}\` already exists; use edit.`,
    );
    return;
  }
  const fieldType = interaction.options.getString("type", false) as
    "short" | "paragraph" | null;
  const required = interaction.options.getBoolean("required", false);
  const input: ApplicationFormFieldInput = {
    fieldId,
    label:
      interaction.options.getString("label", false) ?? current?.label ?? "",
    ...optionalNullable(
      "description",
      interaction.options.getString("description", false),
      current?.description,
    ),
    ...optionalNullable(
      "placeholder",
      interaction.options.getString("placeholder", false),
      current?.placeholder,
    ),
    fieldType: fieldType ?? current?.fieldType ?? "short",
    required: required ?? current?.required ?? true,
    minLength:
      interaction.options.getInteger("min_length", false) ??
      current?.minLength ??
      (required === false ? 0 : 1),
    maxLength:
      interaction.options.getInteger("max_length", false) ??
      current?.maxLength ??
      (fieldType === "paragraph" ? 4_000 : 400),
  };
  const fields = storage.listApplicationFormFields(form.formId);
  const currentIndex = current
    ? fields.findIndex((field) => field.fieldId === current.fieldId)
    : -1;
  if (current && currentIndex < 0) {
    await replyPrivate(
      interaction,
      "That question changed while its order was being inspected. Try again.",
    );
    return;
  }
  const requestedPosition = interaction.options.getInteger("position", false);
  const maximumPosition = current ? fields.length - 1 : fields.length;
  const desiredPosition =
    requestedPosition ?? (current ? currentIndex : fields.length);
  if (desiredPosition < 0 || desiredPosition > maximumPosition) {
    await replyPrivate(
      interaction,
      `Position must be between 0 and ${Math.max(0, maximumPosition)}.`,
    );
    return;
  }
  const safeSortOrder =
    current?.sortOrder ??
    firstFreeFieldOrder(fields.map((field) => field.sortOrder));
  const validatedInput: ApplicationFormFieldInput = {
    ...input,
    sortOrder: safeSortOrder,
  };
  const candidateField: FormFieldInput = {
    fieldId,
    key: "candidate",
    label: validatedInput.label,
    ...(validatedInput.description !== undefined
      ? { description: validatedInput.description }
      : {}),
    ...(validatedInput.placeholder !== undefined
      ? { placeholder: validatedInput.placeholder }
      : {}),
    type: validatedInput.fieldType,
    required: validatedInput.required ?? true,
    minLength: validatedInput.minLength ?? 0,
    maxLength: validatedInput.maxLength ?? 400,
    sortOrder: desiredPosition,
  };
  const candidateOrder: FormFieldInput[] = fields
    .filter((field) => field.fieldId !== fieldId)
    .map(toFormFieldInput);
  candidateOrder.splice(desiredPosition, 0, candidateField);
  validateFormDefinition(
    candidateOrder.map((field, sortOrder) => ({
      ...field,
      key: `field-${sortOrder + 1}`,
      sortOrder,
    })),
  );
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed after the application question was verified. No question changes were saved.",
    );
    return;
  }
  storage.setApplicationFormEnabled(form.formId, false);
  let saved: ApplicationFormField | null = null;
  try {
    saved = storage.upsertApplicationFormField(form.formId, validatedInput);
    const finalOrder = fields
      .filter((field) => field.fieldId !== fieldId)
      .map((field) => field.fieldId);
    finalOrder.splice(desiredPosition, 0, saved.fieldId);
    if (
      finalOrder.some(
        (orderedFieldId, index) => fields[index]?.fieldId !== orderedFieldId,
      )
    ) {
      storage.reorderApplicationFormFields(form.formId, finalOrder);
    }
  } catch (error) {
    if (!current && saved) {
      storage.removeApplicationFormField(form.formId, saved.fieldId);
    }
    throw error;
  }
  if (!saved) throw new Error("Application question was not persisted.");
  runtime.invalidate();
  await replyPrivate(
    interaction,
    `${subcommand === "add" ? "Added" : "Updated"} question \`${saved.fieldId}\`; the form remains disabled until re-enabled.`,
  );
  runtime.storage.recordCommandMetric(`application.field.${subcommand}`);
}

async function readAndVerifyFormInput(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  slug: string,
): Promise<ApplicationFormInput | null> {
  const roleValue = interaction.options.getRole("reviewer_role", true);
  const channelValue = interaction.options.getChannel("review_channel", true);
  if (
    !("guild" in roleValue) ||
    roleValue.guild.id !== runtime.guildId ||
    !("guild" in channelValue) ||
    channelValue.guild.id !== runtime.guildId ||
    channelValue.type !== ChannelType.GuildText
  ) {
    await replyPrivate(
      interaction,
      "Application review resources must belong to this server.",
    );
    return null;
  }
  const role = await fetchAndValidateRole(interaction.guild!, roleValue.id);
  if (!role.valid) {
    await replyPrivate(
      interaction,
      "Choose a current reviewer role that is not @everyone or integration-managed.",
    );
    return null;
  }
  const now = new Date().toISOString();
  const candidate: ApplicationForm = {
    guildId: runtime.guildId,
    formId: "candidate",
    slug,
    displayName: interaction.options.getString("name", true),
    description: interaction.options.getString("description", true),
    reviewerRoleId: role.role.id,
    reviewChannelId: channelValue.id,
    enabled: false,
    sortOrder: interaction.options.getInteger("sort_order", false) ?? 0,
    definitionVersion: 1,
    bindingsVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const resources = await inspectApplicationResources(
    interaction.guild!,
    candidate,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Application form needs attention: ${resources.issues.join(" ")}`,
    );
    return null;
  }
  return candidate;
}

async function readAndVerifyFormUpdate(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  current: ApplicationForm,
): Promise<ApplicationFormUpdate | null> {
  const selectedRole = interaction.options.getRole("reviewer_role", false);
  const selectedChannel = interaction.options.getChannel(
    "review_channel",
    false,
  );
  const reviewerRoleId = selectedRole?.id ?? current.reviewerRoleId;
  const reviewChannelId = selectedChannel?.id ?? current.reviewChannelId;
  if (
    (selectedRole &&
      (!("guild" in selectedRole) ||
        selectedRole.guild.id !== runtime.guildId)) ||
    (selectedChannel &&
      (!("guild" in selectedChannel) ||
        selectedChannel.guild.id !== runtime.guildId ||
        selectedChannel.type !== ChannelType.GuildText))
  ) {
    await replyPrivate(
      interaction,
      "Application review resources must belong to this server.",
    );
    return null;
  }
  const role = await fetchAndValidateRole(interaction.guild!, reviewerRoleId);
  if (!role.valid) {
    await replyPrivate(
      interaction,
      "Choose a current reviewer role that is not @everyone or integration-managed.",
    );
    return null;
  }
  const now = new Date().toISOString();
  const candidate: ApplicationForm = {
    ...current,
    slug: interaction.options.getString("form", true),
    displayName:
      interaction.options.getString("name", false) ?? current.displayName,
    description:
      interaction.options.getString("description", false) ??
      current.description,
    reviewerRoleId,
    reviewChannelId,
    sortOrder:
      interaction.options.getInteger("sort_order", false) ?? current.sortOrder,
    enabled: false,
    bindingsVerifiedAt: now,
  };
  const resources = await inspectApplicationResources(
    interaction.guild!,
    candidate,
  );
  if (resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Application form needs attention: ${resources.issues.join(" ")}`,
    );
    return null;
  }
  return candidate;
}

async function postApplicationPanel(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
): Promise<void> {
  const forms = storage.listApplicationForms({ enabledOnly: true, limit: 25 });
  const activeForms = forms.filter(isActiveApplicationForm);
  if (activeForms.length === 0) {
    await replyPrivate(
      interaction,
      "Enable at least one application form before posting a launcher.",
    );
    return;
  }
  for (const form of activeForms) {
    const resources = await inspectApplicationResources(
      interaction.guild!,
      form,
    );
    if (resources.issues.length > 0) {
      await replyPrivate(
        interaction,
        `Form \`${form.slug}\` needs attention: ${resources.issues.join(" ")}`,
      );
      return;
    }
  }
  const actor = await fetchActor(interaction, runtime);
  if (!actor) return;
  await postFeatureLauncher(interaction, runtime, actor, "applications");
}

async function showApplicationStatus(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
): Promise<void> {
  const number = interaction.options.getInteger("number", false);
  if (number !== null) {
    const application = storage.getApplicationByNumber(number);
    if (!application || application.applicantId !== interaction.user.id) {
      await replyPrivate(
        interaction,
        `Application #${number} was not found among your submissions.`,
      );
      return;
    }
    const form = storage.getApplicationForm(application.formId);
    await replyPrivate(
      interaction,
      applicationStatusMessage(application, form?.displayName ?? "Application"),
    );
    runtime.storage.recordCommandMetric("application.status");
    return;
  }
  const applications = storage.listApplications(
    { applicantId: interaction.user.id },
    PAGE_SIZE,
  );
  if (applications.length === 0) {
    await replyPrivate(interaction, "You have not submitted any applications.");
    return;
  }
  await replyPrivate(
    interaction,
    [
      "**Your recent applications**",
      ...applications.map((application) => {
        const form = storage.getApplicationForm(application.formId);
        return `- #${application.applicationNumber} · **${escapeMarkdown(form?.displayName ?? "Application")}** · ${application.state}`;
      }),
    ].join("\n"),
  );
  runtime.storage.recordCommandMetric("application.status");
}

async function withdrawApplication(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
): Promise<void> {
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed before the withdrawal could start. No application was withdrawn. Try again.",
    );
    return;
  }
  const number = interaction.options.getInteger("number", true);
  const application = storage.getApplicationByNumber(number);
  if (!application || application.applicantId !== interaction.user.id) {
    await replyPrivate(
      interaction,
      "That pending application was not found among your submissions.",
    );
    return;
  }
  const result = storage.withdrawApplication(
    application.applicationId,
    interaction.user.id,
    application.updatedAt,
  );
  if (
    result.status === "not-found" ||
    result.status === "unavailable" ||
    result.status === "conflict"
  ) {
    await replyPrivate(
      interaction,
      "That application can no longer be withdrawn.",
    );
    return;
  }
  const form = storage.getApplicationForm(result.application.formId);
  if (hasVerifiedApplicationBindings(form)) {
    await refreshApplicationReviewMessage(
      interaction.guild!,
      form,
      result.application,
      storage,
      () => runtime.isCurrent(),
    ).catch(() => "unavailable" as const);
  }
  await replyPrivate(
    interaction,
    result.status === "unchanged"
      ? `Application #${number} is already withdrawn.`
      : `Application #${number} was withdrawn.`,
  );
  runtime.storage.recordCommandMetric("application.withdraw");
}

async function recoverApplication(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
): Promise<void> {
  const unavailableMessage =
    "That application was not found or you are not authorized to recover it.";
  const number = interaction.options.getInteger("number", true);
  let application = storage.getApplicationByNumber(number);
  if (!application) {
    await replyPrivate(interaction, unavailableMessage);
    return;
  }
  let form = storage.getApplicationForm(application.formId);
  if (!hasVerifiedApplicationBindings(form)) {
    await replyPrivate(interaction, unavailableMessage);
    return;
  }
  const authorization = await authorizeConfiguredRoleOrCapability({
    guild: interaction.guild!,
    userId: interaction.user.id,
    capability: "applications.review",
    configuredRoleId: form.reviewerRoleId,
    configuredRoleReason: "reviewer-role",
    grants: runtime.storage,
  });
  if (!authorization.allowed) {
    await replyPrivate(interaction, unavailableMessage);
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while recovery was being authorized. Try again.",
    );
    return;
  }
  const authorizedForm = storage.getApplicationForm(form.formId);
  if (
    !hasVerifiedApplicationBindings(authorizedForm) ||
    !sameApplicationForm(form, authorizedForm)
  ) {
    await replyPrivate(
      interaction,
      "Application review settings changed while access was being verified. Try again.",
    );
    return;
  }
  form = authorizedForm;
  const refreshed = await refreshApplicationReviewMessage(
    interaction.guild!,
    form,
    application,
    storage,
    () => runtime.isCurrent(),
  ).catch(() => "unavailable" as const);
  if (refreshed === "updated") {
    await replyPrivate(
      interaction,
      `Application #${number} is healthy and refreshed.`,
    );
    return;
  }
  application =
    storage.getApplicationById(application.applicationId) ?? application;
  if (!["reserved", "failed", "missing"].includes(application.deliveryState)) {
    await replyPrivate(
      interaction,
      "That application is not available for message recovery.",
    );
    return;
  }
  const resources = await inspectApplicationResources(interaction.guild!, form);
  if (!resources.reviewChannel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Application recovery needs attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  const deliveryForm = storage.getApplicationForm(form.formId);
  if (
    !runtime.isCurrent() ||
    !hasVerifiedApplicationBindings(deliveryForm) ||
    !sameApplicationForm(form, deliveryForm)
  ) {
    await replyPrivate(
      interaction,
      "Application review settings changed during recovery. Verify the form and try again.",
    );
    return;
  }
  try {
    const published = await publishReservedApplication(
      interaction.guild!,
      resources.reviewChannel,
      deliveryForm,
      application,
      storage,
      () => runtime.isCurrent(),
    );
    await replyPrivate(
      interaction,
      `Application #${number} was reposted in <#${published.message.channelId}>.`,
    );
    runtime.storage.recordCommandMetric("application.recover");
  } catch (error) {
    await replyPrivate(
      interaction,
      `Application recovery failed safely: ${errorMessage(error)}`,
    );
    runtime.storage.recordCommandMetric("application.recover", false);
  }
}

async function requireCapability(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  capability: "applications.configure" | "applications.review",
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability,
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      `You need the \`${capability}\` capability to use that operation.`,
    );
    return false;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while access was being verified. Try again.",
    );
    return false;
  }
  return true;
}

async function allowApplicationReviewerRoleAssignment(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  reviewerRoleId: string,
  reviewChannelId: string,
  expectedCurrent: ApplicationForm | null,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const decision = await authorizeCapability({
    guild,
    userId: interaction.user.id,
    capability: "applications.configure",
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Your application configuration access changed. Try again.",
    );
    return false;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(
      interaction,
      "This server changed while access was being verified. Try again.",
    );
    return false;
  }
  const current = expectedCurrent
    ? storage.getApplicationForm(expectedCurrent.formId)
    : null;
  if (
    expectedCurrent &&
    (!current || !sameApplicationForm(expectedCurrent, current))
  ) {
    await replyPrivate(
      interaction,
      "The application form changed while access was being verified. Try again.",
    );
    return false;
  }
  if (
    decision.reason === "delegated" &&
    (!current ||
      current.bindingsVerifiedAt === null ||
      current.reviewerRoleId !== reviewerRoleId) &&
    decision.member.roles.cache.has(reviewerRoleId)
  ) {
    await replyPrivate(
      interaction,
      "Delegated configurators cannot assign an application reviewer role they currently hold. Ask the server owner or an Administrator to make that change.",
    );
    return false;
  }
  if (
    decision.reason === "delegated" &&
    (!current ||
      current.bindingsVerifiedAt === null ||
      current.reviewChannelId !== reviewChannelId)
  ) {
    const channelValue = await guild.channels
      .fetch(reviewChannelId, { cache: true, force: true })
      .catch(() => null);
    if (
      !channelValue ||
      channelValue.type !== ChannelType.GuildText ||
      channelValue.guild.id !== guild.id
    ) {
      await replyPrivate(
        interaction,
        "The private review channel changed while access was being verified. Try again.",
      );
      return false;
    }
    if (
      !(await allowApplicationContentDestination(
        interaction,
        runtime,
        channelValue,
        reviewerRoleId,
      ))
    ) {
      return false;
    }
  }
  const latest = expectedCurrent
    ? storage.getApplicationForm(expectedCurrent.formId)
    : null;
  if (
    expectedCurrent &&
    (!latest || !sameApplicationForm(expectedCurrent, latest))
  ) {
    await replyPrivate(
      interaction,
      "The application form changed while access was being verified. Try again.",
    );
    return false;
  }
  return true;
}

async function allowApplicationContentDestination(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
  reviewChannel: TextChannel,
  reviewerRoleId: string,
): Promise<boolean> {
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) return false;
  const boundary = await inspectContentDestinationBoundary({
    guild,
    userId: interaction.user.id,
    capability: "applications.review",
    configuredRoleId: reviewerRoleId,
    grants: runtime.storage,
    channel: reviewChannel,
  });
  if (!runtime.isCurrent() || boundary === "unverifiable") {
    await replyPrivate(
      interaction,
      "Superior could not verify the current application-content boundary. No routing was changed; try again.",
    );
    return false;
  }
  if (boundary === "visible-without-authority") {
    await replyPrivate(
      interaction,
      "A configuration-only delegate cannot route private application answers to a channel they can read without application-review or reviewer-role authority. Ask the server owner or an Administrator to choose that destination.",
    );
    return false;
  }
  return true;
}

async function fetchActor(
  interaction: ChatInputCommandInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const actor = await interaction
    .guild!.members.fetch({
      user: interaction.user.id,
      cache: true,
      force: true,
    })
    .catch(() => null);
  if (!actor || actor.guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return null;
  }
  return actor;
}

async function deferPrivate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
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
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
    return;
  }
  await interaction.reply({
    content,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Application validation failed.";
}

function isActiveApplicationForm(
  form: ApplicationForm | null,
): form is ApplicationForm {
  return form?.enabled === true && hasVerifiedApplicationBindings(form);
}

function hasVerifiedApplicationBindings(
  form: ApplicationForm | null,
): form is ApplicationForm {
  return form !== null && form.bindingsVerifiedAt !== null;
}

function sameApplicationForm(
  expected: ApplicationForm,
  current: ApplicationForm,
): boolean {
  return (
    expected.updatedAt === current.updatedAt &&
    expected.definitionVersion === current.definitionVersion &&
    expected.enabled === current.enabled &&
    expected.reviewerRoleId === current.reviewerRoleId &&
    expected.reviewChannelId === current.reviewChannelId &&
    expected.bindingsVerifiedAt === current.bindingsVerifiedAt
  );
}

function optionalNullable<K extends "description" | "placeholder">(
  key: K,
  selected: string | null,
  current: string | null | undefined,
): { [P in K]?: string | null } {
  const value = selected ?? current;
  return value === undefined
    ? {}
    : ({ [key]: value } as { [P in K]: string | null });
}

function firstFreeFieldOrder(usedOrders: readonly number[]): number {
  const used = new Set(usedOrders);
  for (let index = 0; index < 5; index += 1) {
    if (!used.has(index)) return index;
  }
  throw new RangeError("An application form can contain at most 5 questions.");
}
