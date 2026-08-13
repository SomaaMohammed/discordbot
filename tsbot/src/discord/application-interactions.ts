import {
  AttachmentBuilder,
  ChannelType,
  MessageFlags,
  escapeMarkdown,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { GuildRuntime } from "../runtime.js";
import type {
  ApplicationForm,
  ApplicationRecord,
  ApplicationTransitionResult,
} from "../types.js";
import { authorizeConfiguredRoleOrCapability } from "./authorization.js";
import {
  APPLICATION_DECISION_REASON_FIELD_ID,
  applicationStatusMessage,
  buildApplicationFormSelect,
  createApplicationDecisionModal,
  createApplicationSubmitModal,
  parseApplicationComponentId,
} from "./application-components.js";
import type { ApplicationStorage } from "./application-commands-handler.js";
import {
  notifyApplicationApplicant,
  publishReservedApplication,
  refreshApplicationReviewMessage,
  toApplicationFormDisplay,
} from "./application-delivery.js";
import {
  normalizeMultilineText,
  safeDisplayText,
  validateFormResponses,
} from "./forms.js";
import { parseApplicationOpenCustomId } from "./panel-theme.js";
import { inspectApplicationResources } from "./phase2-permissions.js";
import { logDomainOutcome } from "./domain-outcomes.js";

const NAMESPACE = "superior:application:";

type ApplicationInteraction =
  ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction;

export async function handleApplicationButton(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(NAMESPACE)) return false;
  const storage = runtime.storage as unknown as ApplicationStorage;
  const panelId = parseApplicationOpenCustomId(interaction.customId);
  if (panelId) {
    await openApplicationFormSelector(interaction, runtime, storage, panelId);
    return true;
  }

  const parsed = parseApplicationComponentId(interaction.customId);
  if (!parsed || parsed.kind !== "control") {
    await replyPrivate(
      interaction,
      "This application control is outdated or invalid. Ask an administrator to refresh it.",
    );
    return true;
  }
  const application = storage.getApplicationById(parsed.applicationId);
  const form = application
    ? storage.getApplicationForm(application.formId)
    : null;
  if (
    !application ||
    !hasVerifiedApplicationBindings(form) ||
    application.guildId !== runtime.guildId ||
    application.reviewChannelId !== interaction.channelId ||
    application.reviewMessageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id
  ) {
    await replyPrivate(
      interaction,
      "This review control is stale or does not belong to that application.",
    );
    return true;
  }
  const reviewer = await authorizeReviewer(interaction, runtime, form);
  if (!reviewer) return true;
  const verifiedApplication = storage.getApplicationById(
    application.applicationId,
  );
  const verifiedForm = storage.getApplicationForm(form.formId);
  if (
    !runtime.isCurrent() ||
    !verifiedApplication ||
    !verifiedForm ||
    !sameApplicationSnapshot(application, verifiedApplication) ||
    !sameFormSnapshot(form, verifiedForm)
  ) {
    await replyPrivate(
      interaction,
      "This application changed while access was being verified. Refresh the review message and try again.",
    );
    return true;
  }

  if (parsed.action === "accept" || parsed.action === "reject") {
    if (
      verifiedApplication.state !== "under-review" ||
      verifiedApplication.claimedBy !== reviewer.id
    ) {
      await replyPrivate(
        interaction,
        "Claim this pending application before recording its decision.",
      );
      return true;
    }
    await interaction.showModal(
      createApplicationDecisionModal(
        verifiedApplication.applicationId,
        parsed.action,
      ),
    );
    return true;
  }

  await deferPrivate(interaction);
  const deferredApplication = storage.getApplicationById(
    verifiedApplication.applicationId,
  );
  const deferredForm = storage.getApplicationForm(verifiedForm.formId);
  if (
    !deferredApplication ||
    !deferredForm ||
    !isCurrentReviewerControlSnapshot(
      interaction,
      runtime,
      verifiedApplication,
      verifiedForm,
      deferredApplication,
      deferredForm,
    )
  ) {
    await replyPrivate(
      interaction,
      "This application changed while access was being verified. Refresh the review message and try again.",
    );
    return true;
  }

  const currentReviewer = await authorizeReviewer(
    interaction,
    runtime,
    deferredForm,
  );
  if (!currentReviewer) return true;
  const currentApplication = storage.getApplicationById(
    deferredApplication.applicationId,
  );
  const currentForm = storage.getApplicationForm(deferredForm.formId);
  if (
    !currentApplication ||
    !currentForm ||
    !isCurrentReviewerControlSnapshot(
      interaction,
      runtime,
      deferredApplication,
      deferredForm,
      currentApplication,
      currentForm,
    )
  ) {
    await replyPrivate(
      interaction,
      "This application changed while access was being verified. Refresh the review message and try again.",
    );
    return true;
  }

  if (parsed.action === "info") {
    await showReviewerInfo(
      interaction,
      storage,
      currentForm,
      currentApplication,
    );
    runtime.storage.recordCommandMetric("application.review.info");
    return true;
  }

  const result = storage.claimApplication(
    currentApplication.applicationId,
    currentReviewer.id,
    currentApplication.updatedAt,
  );
  await handleClaimResult(interaction, runtime, storage, currentForm, result);
  return true;
}

export async function handleApplicationSelect(
  interaction: StringSelectMenuInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(NAMESPACE)) return false;
  const parsed = parseApplicationComponentId(interaction.customId);
  if (!parsed || parsed.kind !== "select") {
    await replyPrivate(
      interaction,
      "This application selection is outdated. Open the launcher again.",
    );
    return true;
  }
  const storage = runtime.storage as unknown as ApplicationStorage;
  if (!(await verifyApplicationPanel(interaction, runtime, parsed.panelId))) {
    await replyPrivate(
      interaction,
      "This application launcher is outdated or missing.",
    );
    return true;
  }
  const formId = interaction.values[0];
  const form = formId ? storage.getApplicationForm(formId) : null;
  if (!isActiveApplicationForm(form) || form.guildId !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "That application form is no longer available.",
    );
    return true;
  }
  const fields = storage.listApplicationFormFields(form.formId);
  try {
    await interaction.showModal(
      createApplicationSubmitModal(
        parsed.panelId,
        toApplicationFormDisplay(form, fields),
      ),
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
  }
  return true;
}

export async function handleApplicationModal(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
): Promise<boolean> {
  if (!interaction.customId.startsWith(NAMESPACE)) return false;
  const parsed = parseApplicationComponentId(interaction.customId);
  if (
    !parsed ||
    (parsed.kind !== "submit-modal" && parsed.kind !== "decision-modal")
  ) {
    await replyPrivate(
      interaction,
      "This application form is outdated. Open a fresh form.",
    );
    return true;
  }
  const storage = runtime.storage as unknown as ApplicationStorage;
  if (parsed.kind === "submit-modal") {
    await submitApplication(
      interaction,
      runtime,
      storage,
      parsed.panelId,
      parsed.formId,
      parsed.definitionVersion,
    );
  } else {
    await decideApplication(
      interaction,
      runtime,
      storage,
      parsed.applicationId,
      parsed.decision,
    );
  }
  return true;
}

async function openApplicationFormSelector(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  panelId: string,
): Promise<void> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  if (
    !panel ||
    panel.preset !== "applications" ||
    panel.channelId !== interaction.channelId ||
    panel.messageId !== interaction.message.id ||
    interaction.message.author.id !== interaction.client.user?.id ||
    !runtime.isCurrent()
  ) {
    await replyPrivate(
      interaction,
      "This application panel is outdated or unavailable.",
    );
    return;
  }
  const forms = storage
    .listApplicationForms({ enabledOnly: true, limit: 25 })
    .filter(isActiveApplicationForm);
  if (forms.length === 0) {
    await replyPrivate(
      interaction,
      "Applications are not currently available in this server.",
    );
    return;
  }
  await interaction.reply({
    content: "Choose the private application you want to submit:",
    components: [
      buildApplicationFormSelect(
        panel.panelId,
        forms.map((form) => toApplicationFormDisplay(form, [])),
      ),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  runtime.storage.recordCommandMetric("panel.applications.use");
}

async function submitApplication(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  panelId: string,
  formId: string,
  definitionVersion: number,
): Promise<void> {
  await deferPrivate(interaction);
  const guild = interaction.guild;
  if (!guild || guild.id !== runtime.guildId) {
    await replyPrivate(
      interaction,
      "Applications must be submitted inside this server.",
    );
    return;
  }
  if (
    panelId !== "command" &&
    !(await verifyApplicationPanel(interaction, runtime, panelId))
  ) {
    await replyPrivate(
      interaction,
      "This application launcher is outdated. Open a fresh form.",
    );
    return;
  }
  const form = storage.getApplicationForm(formId);
  if (
    !isActiveApplicationForm(form) ||
    form.guildId !== runtime.guildId ||
    form.definitionVersion !== definitionVersion
  ) {
    await replyPrivate(
      interaction,
      "That application form changed or is no longer available. Open a fresh form.",
    );
    return;
  }
  const resources = await inspectApplicationResources(guild, form);
  if (!resources.reviewChannel || resources.issues.length > 0) {
    await replyPrivate(
      interaction,
      `Applications need administrator attention: ${resources.issues.join(" ")}`,
    );
    return;
  }
  const member = await fetchMember(interaction, runtime);
  if (!member || member.user.bot) {
    await replyPrivate(
      interaction,
      "Could not verify your current server membership.",
    );
    return;
  }
  const fields = storage.listApplicationFormFields(form.formId);
  let responses;
  try {
    responses = validateFormResponses(
      fields.map((field) => ({
        fieldId: field.fieldId,
        key: `field-${field.sortOrder + 1}`,
        label: field.label,
        description: field.description,
        placeholder: field.placeholder,
        type: field.fieldType,
        required: field.required,
        minLength: field.minLength,
        maxLength: field.maxLength,
        sortOrder: field.sortOrder,
      })),
      (fieldId) => interaction.fields.getTextInputValue(fieldId),
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  if (!runtime.isCurrent()) {
    await replyPrivate(interaction, "This server changed. Please try again.");
    return;
  }
  const currentForm = storage.getApplicationForm(form.formId);
  if (!currentForm || !sameFormSnapshot(form, currentForm)) {
    await replyPrivate(
      interaction,
      "That application form changed. Open a fresh form and submit again.",
    );
    return;
  }
  let reservation;
  try {
    reservation = storage.reserveApplication({
      formId: form.formId,
      applicantId: member.id,
      responses: responses.map((response) => ({
        fieldId: response.fieldId,
        fieldLabel: response.label,
        fieldType: fields.find((field) => field.fieldId === response.fieldId)!
          .fieldType,
        responseText: response.value,
        sortOrder: response.sortOrder,
      })),
    });
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  if (reservation.status === "disabled") {
    logDomainOutcome(
      "application",
      "submit",
      runtime.guildId,
      "rejected-disabled",
    );
    await replyPrivate(
      interaction,
      "That application form was disabled before submission.",
    );
    return;
  }
  if (reservation.status === "existing") {
    logDomainOutcome(
      "application",
      "submit",
      runtime.guildId,
      "rejected-existing-active-application",
      {
        recordId: reservation.application.applicationId,
        recordNumber: reservation.application.applicationNumber,
      },
    );
    await replyPrivate(
      interaction,
      `You already have active application #${reservation.application.applicationNumber} for this form.`,
    );
    return;
  }
  logDomainOutcome("application", "submit", runtime.guildId, "reserved", {
    recordId: reservation.application.applicationId,
    recordNumber: reservation.application.applicationNumber,
  });
  const deliveryForm = storage.getApplicationForm(form.formId);
  if (
    !runtime.isCurrent() ||
    !deliveryForm ||
    !isActiveApplicationForm(deliveryForm) ||
    !sameFormSnapshot(currentForm, deliveryForm)
  ) {
    storage.failApplicationDelivery(
      reservation.application.applicationId,
      "Application form changed during submission",
    );
    await replyPrivate(
      interaction,
      "The application form changed during submission. Your reserved submission was not posted; withdraw it or ask staff to recover it safely.",
    );
    runtime.storage.recordCommandMetric("application.submit", false);
    logDomainOutcome(
      "application",
      "submit",
      runtime.guildId,
      "failed-configuration-changed",
      {
        recordId: reservation.application.applicationId,
        recordNumber: reservation.application.applicationNumber,
      },
    );
    return;
  }
  try {
    const published = await publishReservedApplication(
      guild,
      resources.reviewChannel,
      deliveryForm,
      reservation.application,
      storage,
      () => runtime.isCurrent(),
    );
    await replyPrivate(
      interaction,
      `Application #${published.application.applicationNumber} was submitted privately for staff review.`,
    );
    runtime.storage.recordCommandMetric("application.submit");
    logDomainOutcome("application", "submit", runtime.guildId, "delivered", {
      recordId: published.application.applicationId,
      recordNumber: published.application.applicationNumber,
      channelId: published.message.channelId,
      state: published.application.state,
    });
  } catch {
    await replyPrivate(
      interaction,
      "Superior could not deliver the application safely. The failed reservation was recorded for recovery.",
    );
    runtime.storage.recordCommandMetric("application.submit", false);
    logDomainOutcome(
      "application",
      "submit",
      runtime.guildId,
      "failed-delivery",
      {
        recordId: reservation.application.applicationId,
        recordNumber: reservation.application.applicationNumber,
      },
    );
  }
}

async function decideApplication(
  interaction: ModalSubmitInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  applicationId: string,
  decision: "accept" | "reject",
): Promise<void> {
  let reason: string;
  try {
    reason = normalizeMultilineText(
      interaction.fields.getTextInputValue(
        APPLICATION_DECISION_REASON_FIELD_ID,
      ),
      "Decision reason",
      1,
      500,
    );
  } catch (error) {
    await replyPrivate(interaction, errorMessage(error));
    return;
  }
  await deferPrivate(interaction);
  const application = storage.getApplicationById(applicationId);
  const form = application
    ? storage.getApplicationForm(application.formId)
    : null;
  if (
    !application ||
    !hasVerifiedApplicationBindings(form) ||
    application.guildId !== runtime.guildId
  ) {
    await replyPrivate(interaction, "That application is no longer available.");
    return;
  }
  const reviewer = await authorizeReviewer(interaction, runtime, form);
  if (!reviewer) return;
  const verifiedApplication = storage.getApplicationById(
    application.applicationId,
  );
  const verifiedForm = storage.getApplicationForm(form.formId);
  if (
    !runtime.isCurrent() ||
    !verifiedApplication ||
    !verifiedForm ||
    !sameApplicationSnapshot(application, verifiedApplication) ||
    !sameFormSnapshot(form, verifiedForm)
  ) {
    await replyPrivate(
      interaction,
      "That application changed while access was being verified. Refresh the review message and try again.",
    );
    return;
  }
  const result = storage.decideApplication(verifiedApplication.applicationId, {
    state: decision === "accept" ? "accepted" : "rejected",
    reviewerId: reviewer.id,
    reason,
    expectedUpdatedAt: verifiedApplication.updatedAt,
  });
  if (
    result.status === "not-found" ||
    result.status === "unavailable" ||
    result.status === "conflict"
  ) {
    logDomainOutcome(
      "application",
      "review-decision",
      runtime.guildId,
      `rejected-${result.status}`,
      {
        recordId: verifiedApplication.applicationId,
        recordNumber: verifiedApplication.applicationNumber,
      },
    );
    await replyPrivate(
      interaction,
      "That application changed or is not claimed by you. Refresh the review message and try again.",
    );
    return;
  }
  await Promise.all([
    refreshApplicationReviewMessage(
      interaction.guild!,
      verifiedForm,
      result.application,
      storage,
      () => runtime.isCurrent(),
    ).catch(() => "unavailable" as const),
    ...(result.status === "changed"
      ? [
          notifyApplicationApplicant(
            interaction.guild!,
            verifiedForm,
            result.application,
          ),
        ]
      : []),
  ]);
  await replyPrivate(
    interaction,
    result.status === "unchanged"
      ? `Application #${result.application.applicationNumber} already has that decision.`
      : `Application #${result.application.applicationNumber} was **${result.application.state}**.`,
  );
  runtime.storage.recordCommandMetric("application.review.decision");
  logDomainOutcome(
    "application",
    "review-decision",
    runtime.guildId,
    result.status,
    {
      recordId: result.application.applicationId,
      recordNumber: result.application.applicationNumber,
      state: result.application.state,
    },
  );
}

async function handleClaimResult(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  storage: ApplicationStorage,
  form: ApplicationForm,
  result: ApplicationTransitionResult,
): Promise<void> {
  if (
    result.status === "not-found" ||
    result.status === "unavailable" ||
    result.status === "conflict"
  ) {
    logDomainOutcome(
      "application",
      "review-claim",
      runtime.guildId,
      `rejected-${result.status}`,
    );
    await replyPrivate(
      interaction,
      "That application is no longer available to claim.",
    );
    return;
  }
  await Promise.all([
    refreshApplicationReviewMessage(
      interaction.guild!,
      form,
      result.application,
      storage,
      () => runtime.isCurrent(),
    ).catch(() => "unavailable" as const),
    ...(result.status === "changed"
      ? [
          notifyApplicationApplicant(
            interaction.guild!,
            form,
            result.application,
          ),
        ]
      : []),
  ]);
  await replyPrivate(
    interaction,
    result.status === "unchanged"
      ? `You already claimed application #${result.application.applicationNumber}.`
      : `You claimed application #${result.application.applicationNumber}.`,
  );
  runtime.storage.recordCommandMetric("application.review.claim");
  logDomainOutcome(
    "application",
    "review-claim",
    runtime.guildId,
    result.status,
    {
      recordId: result.application.applicationId,
      recordNumber: result.application.applicationNumber,
      state: result.application.state,
    },
  );
}

async function showReviewerInfo(
  interaction: ButtonInteraction,
  storage: ApplicationStorage,
  form: ApplicationForm,
  application: ApplicationRecord,
): Promise<void> {
  const responses = storage.listApplicationResponses(application.applicationId);
  const answerText = [
    `Superior application #${application.applicationNumber}`,
    `Form: ${safeDisplayText(form.displayName, 120)}`,
    `Applicant ID: ${application.applicantId}`,
    `Status: ${application.state}`,
    "",
    ...responses.flatMap((response, index) => [
      `${index + 1}. ${safeDisplayText(response.fieldLabel, 200)}`,
      safeDisplayText(response.responseText || "No response provided.", 4_000),
      "",
    ]),
  ]
    .join("\n")
    .slice(0, 24_000);
  await interaction.editReply({
    content: [
      applicationStatusMessage(application, form.displayName),
      `Applicant: \`${application.applicantId}\``,
      "Complete responses are attached privately.",
    ]
      .join("\n")
      .slice(0, 2_000),
    files: [
      new AttachmentBuilder(Buffer.from(answerText, "utf8"), {
        name: `superior-application-${application.applicationNumber}-responses.txt`,
      }),
    ],
    allowedMentions: { parse: [] },
  });
}

async function authorizeReviewer(
  interaction: ApplicationInteraction,
  runtime: GuildRuntime,
  form: ApplicationForm,
): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (
    !guild ||
    guild.id !== runtime.guildId ||
    form.guildId !== runtime.guildId ||
    !hasVerifiedApplicationBindings(form)
  ) {
    await replyPrivate(
      interaction,
      "Application review configuration is unavailable.",
    );
    return null;
  }
  const decision = await authorizeConfiguredRoleOrCapability({
    guild,
    userId: interaction.user.id,
    capability: "applications.review",
    configuredRoleId: form.reviewerRoleId,
    configuredRoleReason: "reviewer-role",
    grants: runtime.storage,
  });
  if (!decision.allowed) {
    await replyPrivate(
      interaction,
      "Only authorized application reviewers can use that control.",
    );
    return null;
  }
  return decision.member;
}

async function verifyApplicationPanel(
  interaction: ApplicationInteraction,
  runtime: GuildRuntime,
  panelId: string,
): Promise<boolean> {
  const panel = runtime.storage.findPostedPanelByToken(panelId);
  if (!panel || panel.preset !== "applications" || !runtime.isCurrent()) {
    return false;
  }
  if (interaction.channelId !== panel.channelId) return false;
  const channel = await interaction
    .guild!.channels.fetch(panel.channelId)
    .catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    return false;
  }
  const message = await channel.messages
    .fetch(panel.messageId)
    .catch(() => null);
  return message?.author.id === interaction.client.user?.id;
}

async function fetchMember(
  interaction: ApplicationInteraction,
  runtime: GuildRuntime,
): Promise<GuildMember | null> {
  const member = await interaction.guild?.members
    .fetch({ user: interaction.user.id, cache: true, force: true })
    .catch(() => null);
  return member?.guild.id === runtime.guildId ? member : null;
}

async function deferPrivate(
  interaction: ApplicationInteraction,
): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

async function replyPrivate(
  interaction: ApplicationInteraction,
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

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Application validation failed.";
}

function sameApplicationSnapshot(
  expected: ApplicationRecord,
  current: ApplicationRecord,
): boolean {
  return (
    expected.updatedAt === current.updatedAt &&
    expected.state === current.state &&
    expected.deliveryState === current.deliveryState &&
    expected.reviewChannelId === current.reviewChannelId &&
    expected.reviewMessageId === current.reviewMessageId &&
    expected.claimedBy === current.claimedBy
  );
}

function sameFormSnapshot(
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

function isCurrentReviewerControlSnapshot(
  interaction: ButtonInteraction,
  runtime: GuildRuntime,
  expectedApplication: ApplicationRecord,
  expectedForm: ApplicationForm,
  currentApplication: ApplicationRecord,
  currentForm: ApplicationForm,
): boolean {
  return (
    runtime.isCurrent() &&
    currentApplication.applicationId === expectedApplication.applicationId &&
    currentApplication.guildId === runtime.guildId &&
    currentApplication.formId === expectedApplication.formId &&
    currentApplication.formId === currentForm.formId &&
    currentApplication.reviewChannelId === interaction.channelId &&
    currentApplication.reviewMessageId === interaction.message.id &&
    currentForm.formId === expectedForm.formId &&
    currentForm.guildId === runtime.guildId &&
    hasVerifiedApplicationBindings(currentForm) &&
    interaction.message.author.id === interaction.client.user?.id &&
    sameApplicationSnapshot(expectedApplication, currentApplication) &&
    sameFormSnapshot(expectedForm, currentForm)
  );
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
