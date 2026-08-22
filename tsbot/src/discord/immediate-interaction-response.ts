import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  isDiscordInteractionAcknowledged,
  isDiscordInteractionExpired,
} from "../errors.js";
import type { BotRuntime, InteractionFormSnapshot } from "../runtime.js";
import {
  buildApplicationFormSelect,
  createApplicationDecisionModal,
  createApplicationSubmitModal,
  parseApplicationComponentId,
} from "./application-components.js";
import { toApplicationFormDisplay } from "./application-delivery.js";
import {
  INTERACTION_STALE_CUTOFF_MS,
  interactionPreservesInitialResponse,
  type InteractionLifecycle,
} from "./interaction-lifecycle.js";
import {
  createPrivateMessagePanelModal,
  parsePersistentPanelButtonId,
} from "./panels.js";
import {
  parseApplicationOpenCustomId,
  parseAppealOpenCustomId,
  parseReportOpenCustomId,
  parseSuggestionOpenCustomId,
  parseTicketOpenCustomId,
} from "./panel-theme.js";
import {
  createReportDecisionModal,
  createReportSubmitModal,
  parseReportComponentId,
} from "./report-components.js";
import {
  createAppealDecisionModal,
  createAppealSubmitModal,
  parseAppealComponentId,
} from "./appeal-components.js";
import {
  createSuggestionReviewModal,
  createSuggestionSubmitModal,
  parseSuggestionComponentId,
} from "./suggestion-components.js";
import {
  buildTicketDepartmentSelect,
  createTicketCloseModal,
  createTicketOpenModal,
  parseTicketComponentId,
  parseTicketDepartmentSelectCustomId,
  toTicketFormFieldInput,
} from "./ticket-components.js";

export type ImmediateInteractionResponse = "handled" | "continue";

/**
 * Starts modal/select responses directly from a memory-only snapshot. This is
 * invoked synchronously by interactionCreate, before tracked runtime loading,
 * database queries, permission fetches, or any other network work. Submission
 * handlers remain authoritative and revalidate guild state, bindings, actor
 * authorization, and current resources before persisting or delivering data.
 */
export function startImmediateInteractionResponse(
  interaction: Interaction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<ImmediateInteractionResponse> {
  if (lifecycle.ageAtReceiptMs >= INTERACTION_STALE_CUTOFF_MS) {
    return Promise.resolve("handled");
  }
  try {
    if (interaction.isChatInputCommand()) {
      return handleImmediateCommand(interaction, runtime, lifecycle);
    }
    if (interaction.isButton()) {
      return handleImmediateButton(interaction, runtime, lifecycle);
    }
    if (interaction.isStringSelectMenu()) {
      return handleImmediateSelect(interaction, runtime, lifecycle);
    }
    return Promise.resolve("continue");
  } catch (error) {
    return recoverImmediateBuildFailure(interaction, lifecycle, error);
  }
}

function recoverImmediateBuildFailure(
  interaction: Interaction,
  lifecycle: InteractionLifecycle,
  buildError: unknown,
): Promise<ImmediateInteractionResponse> {
  if (
    isDiscordInteractionExpired(buildError) ||
    isDiscordInteractionAcknowledged(buildError)
  ) {
    lifecycle.fail(buildError, {
      stage: "immediate-response-build",
      recovery: "skipped-invalid-token",
    });
    return Promise.resolve("handled");
  }
  if (
    !interaction.isChatInputCommand() &&
    !interaction.isButton() &&
    !interaction.isStringSelectMenu()
  ) {
    lifecycle.fail(buildError, {
      stage: "immediate-response-build",
      recovery: "unsupported-interaction-kind",
    });
    return Promise.resolve("handled");
  }
  if (interaction.deferred || interaction.replied) {
    lifecycle.markAcknowledged("existing-response");
    lifecycle.fail(buildError, {
      stage: "immediate-response-build",
      recovery: "skipped-existing-response",
    });
    return Promise.resolve("handled");
  }

  let response: ReturnType<typeof interaction.reply>;
  try {
    // Start the acknowledgement before formatting the build failure for the
    // terminal. This is a single private recovery attempt; a rejected token is
    // never followed by another Discord response.
    response = interaction.reply({
      content:
        "Superior could not prepare that control safely. Try the current command or panel again.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (responseError) {
    lifecycle.fail(responseError, {
      stage: "immediate-build-recovery-reply",
    });
    lifecycle.fail(buildError, {
      stage: "immediate-response-build",
      recovery: "private-acknowledgement-start-failed",
    });
    return Promise.resolve("handled");
  }

  return response.then(
    () => {
      lifecycle.markAcknowledged("immediate-build-recovery");
      lifecycle.fail(buildError, {
        stage: "immediate-response-build",
        recovery: "private-acknowledged",
      });
      return "handled" as const;
    },
    (responseError: unknown) => {
      lifecycle.fail(responseError, {
        stage: "immediate-build-recovery-reply",
      });
      lifecycle.fail(buildError, {
        stage: "immediate-response-build",
        recovery: "private-acknowledgement-failed",
      });
      return "handled" as const;
    },
  );
}

function handleImmediateCommand(
  interaction: ChatInputCommandInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<ImmediateInteractionResponse> {
  if (interaction.options.getSubcommand(false) !== "submit") {
    return Promise.resolve("continue");
  }
  const snapshot = currentSnapshot(interaction, runtime);
  if (interaction.commandName === "suggestion") {
    if (!snapshot?.suggestionConfiguration) {
      return replyPrivate(
        interaction,
        lifecycle,
        "Suggestions need a verified destination channel and reviewer role before submissions can open.",
      );
    }
    return showModal(
      interaction,
      createSuggestionSubmitModal("command"),
      lifecycle,
    );
  }
  if (interaction.commandName === "report") {
    const target = interaction.options.getUser("member", true);
    return showModal(
      interaction,
      createReportSubmitModal("command", target.id),
      lifecycle,
    );
  }
  if (interaction.commandName === "appeal") {
    return showModal(
      interaction,
      createAppealSubmitModal(
        "command",
        interaction.options.getInteger("case_number", true),
      ),
      lifecycle,
    );
  }
  if (interaction.commandName !== "application") {
    return Promise.resolve("continue");
  }
  const slug = interaction.options.getString("form", true);
  const cached = snapshot?.applicationForms.find(
    ({ form }) => form.slug === slug,
  );
  if (!cached) {
    return replyPrivate(
      interaction,
      lifecycle,
      "That application form is disabled, deleted, or missing verified review bindings.",
    );
  }
  return showModal(
    interaction,
    createApplicationSubmitModal(
      "command",
      toApplicationFormDisplay(cached.form, cached.fields),
    ),
    lifecycle,
  );
}

function handleImmediateButton(
  interaction: ButtonInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<ImmediateInteractionResponse> {
  if (interaction.message.author?.id !== interaction.client.user?.id) {
    return interactionPreservesInitialResponse(interaction)
      ? replyPrivate(
          interaction,
          lifecycle,
          "This control was not posted by Superior and cannot be trusted.",
        )
      : Promise.resolve("continue");
  }
  const legacyPanel = parsePersistentPanelButtonId(interaction.customId);
  if (legacyPanel?.kind === "private-message") {
    return showModal(
      interaction,
      createPrivateMessagePanelModal(
        legacyPanel.targetId,
        interaction.message.id,
      ),
      lifecycle,
    );
  }

  const ticket = parseTicketComponentId(interaction.customId);
  if (ticket?.kind === "close") {
    return showModal(
      interaction,
      createTicketCloseModal(ticket.ticketId),
      lifecycle,
    );
  }

  const suggestion = parseSuggestionComponentId(interaction.customId);
  if (suggestion?.kind === "review") {
    return showModal(
      interaction,
      createSuggestionReviewModal(suggestion.suggestionId, suggestion.state),
      lifecycle,
    );
  }

  const application = parseApplicationComponentId(interaction.customId);
  if (
    application?.kind === "control" &&
    (application.action === "accept" || application.action === "reject")
  ) {
    return showModal(
      interaction,
      createApplicationDecisionModal(
        application.applicationId,
        application.action,
      ),
      lifecycle,
    );
  }

  const report = parseReportComponentId(interaction.customId);
  if (
    report?.kind === "control" &&
    (report.action === "resolve" || report.action === "dismiss")
  ) {
    return showModal(
      interaction,
      createReportDecisionModal(
        report.reportId,
        report.action,
        report.versionToken,
        interaction.message.id,
      ),
      lifecycle,
    );
  }
  const appeal = parseAppealComponentId(interaction.customId);
  if (
    appeal?.kind === "control" &&
    (appeal.action === "uphold" || appeal.action === "overturn")
  ) {
    return showModal(
      interaction,
      createAppealDecisionModal(
        appeal.appealId,
        appeal.action,
        appeal.versionToken,
        interaction.message.id,
      ),
      lifecycle,
    );
  }

  const snapshot = currentSnapshot(interaction, runtime);
  const suggestionPanelId = parseSuggestionOpenCustomId(interaction.customId);
  if (suggestionPanelId) {
    if (!snapshot?.suggestionConfiguration) {
      return replyPrivate(
        interaction,
        lifecycle,
        "This suggestion panel needs a verified destination channel and reviewer role.",
      );
    }
    return showModal(
      interaction,
      createSuggestionSubmitModal(suggestionPanelId),
      lifecycle,
    );
  }

  const applicationPanelId = parseApplicationOpenCustomId(interaction.customId);
  if (applicationPanelId) {
    return openApplicationLauncher(
      interaction,
      lifecycle,
      snapshot,
      applicationPanelId,
    );
  }

  const reportPanelId = parseReportOpenCustomId(interaction.customId);
  if (reportPanelId) {
    return showModal(
      interaction,
      createReportSubmitModal(reportPanelId, null, interaction.message.id),
      lifecycle,
    );
  }
  const appealPanelId = parseAppealOpenCustomId(interaction.customId);
  if (appealPanelId) {
    return showModal(
      interaction,
      createAppealSubmitModal(appealPanelId, null, interaction.message.id),
      lifecycle,
    );
  }

  const ticketPanelId = parseTicketOpenCustomId(interaction.customId);
  if (ticketPanelId) {
    return openTicketLauncher(interaction, lifecycle, snapshot, ticketPanelId);
  }
  return interactionPreservesInitialResponse(interaction)
    ? replyPrivate(
        interaction,
        lifecycle,
        "This modal control is outdated or malformed. Use the current panel or command.",
      )
    : Promise.resolve("continue");
}

function handleImmediateSelect(
  interaction: StringSelectMenuInteraction,
  runtime: BotRuntime,
  lifecycle: InteractionLifecycle,
): Promise<ImmediateInteractionResponse> {
  const snapshot = currentSnapshot(interaction, runtime);
  const application = parseApplicationComponentId(interaction.customId);
  if (application?.kind === "select") {
    const formId =
      interaction.values.length === 1 ? interaction.values[0] : null;
    const cached = snapshot?.applicationForms.find(
      ({ form }) => form.formId === formId,
    );
    if (!cached) {
      return replyPrivate(
        interaction,
        lifecycle,
        "That application form was disabled or deleted. Open the current application panel again.",
      );
    }
    return showModal(
      interaction,
      createApplicationSubmitModal(
        application.panelId,
        toApplicationFormDisplay(cached.form, cached.fields),
      ),
      lifecycle,
    );
  }

  const ticketPanelId = parseTicketDepartmentSelectCustomId(
    interaction.customId,
  );
  if (!ticketPanelId) {
    return interactionPreservesInitialResponse(interaction)
      ? replyPrivate(
          interaction,
          lifecycle,
          "This selection control is outdated or malformed. Open the current panel again.",
        )
      : Promise.resolve("continue");
  }
  const departmentId =
    interaction.values.length === 1 ? interaction.values[0] : null;
  const cached = snapshot?.ticketDepartments.find(
    ({ department }) => department.departmentId === departmentId,
  );
  if (!cached) {
    return replyPrivate(
      interaction,
      lifecycle,
      "That ticket department was disabled or deleted. Open the current ticket panel again.",
    );
  }
  return showModal(
    interaction,
    createTicketOpenModal(ticketPanelId, {
      departmentId: cached.department.departmentId,
      definitionVersion: cached.department.definitionVersion,
      departmentName: cached.department.displayName,
      fields: sortedTicketFields(cached.fields),
    }),
    lifecycle,
  );
}

function openApplicationLauncher(
  interaction: ButtonInteraction,
  lifecycle: InteractionLifecycle,
  snapshot: InteractionFormSnapshot | null,
  panelId: string,
): Promise<ImmediateInteractionResponse> {
  const forms = snapshot?.applicationForms ?? [];
  if (forms.length === 0) {
    return replyPrivate(
      interaction,
      lifecycle,
      "This application panel has no enabled form with a verified private review channel and reviewer role.",
    );
  }
  const displays = forms.map(({ form, fields }) =>
    toApplicationFormDisplay(form, fields),
  );
  if (displays.length === 1) {
    return showModal(
      interaction,
      createApplicationSubmitModal(panelId, displays[0]!),
      lifecycle,
    );
  }
  return replyPrivate(interaction, lifecycle, "Choose an application form:", [
    buildApplicationFormSelect(panelId, displays),
  ]);
}

function openTicketLauncher(
  interaction: ButtonInteraction,
  lifecycle: InteractionLifecycle,
  snapshot: InteractionFormSnapshot | null,
  panelId: string,
): Promise<ImmediateInteractionResponse> {
  const departments = snapshot?.ticketDepartments ?? [];
  if (departments.length === 0) {
    return replyPrivate(
      interaction,
      lifecycle,
      "This ticket panel has no enabled department with verified category, log channel, and support-role bindings.",
    );
  }
  if (departments.length === 1) {
    const cached = departments[0]!;
    return showModal(
      interaction,
      createTicketOpenModal(panelId, {
        departmentId: cached.department.departmentId,
        definitionVersion: cached.department.definitionVersion,
        departmentName: cached.department.displayName,
        fields: sortedTicketFields(cached.fields),
      }),
      lifecycle,
    );
  }
  return replyPrivate(
    interaction,
    lifecycle,
    "Choose the support department that best matches your request:",
    [
      buildTicketDepartmentSelect(
        panelId,
        departments.map(({ department }) => department),
      ),
    ],
  );
}

function currentSnapshot(
  interaction: Interaction,
  runtime: BotRuntime,
): InteractionFormSnapshot | null {
  if (
    !interaction.guildId ||
    !interaction.guild ||
    interaction.guild.id !== interaction.guildId
  ) {
    return null;
  }
  return runtime.interactionFormsForGuild(interaction.guildId);
}

function sortedTicketFields(
  fields: InteractionFormSnapshot["ticketDepartments"][number]["fields"],
) {
  return [...fields]
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.fieldId.localeCompare(right.fieldId),
    )
    .map(toTicketFormFieldInput);
}

function showModal(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  modal: Parameters<ButtonInteraction["showModal"]>[0],
  lifecycle: InteractionLifecycle,
): Promise<ImmediateInteractionResponse> {
  const response = interaction.showModal(modal);
  return response.then(
    () => {
      lifecycle.markAcknowledged("show-modal");
      return "handled" as const;
    },
    (error: unknown) => {
      lifecycle.fail(error, { stage: "immediate-show-modal" });
      return "handled" as const;
    },
  );
}

function replyPrivate(
  interaction:
    | ButtonInteraction
    | ChatInputCommandInteraction
    | StringSelectMenuInteraction,
  lifecycle: InteractionLifecycle,
  content: string,
  components: InteractionReplyOptions["components"] = [],
): Promise<ImmediateInteractionResponse> {
  const response = interaction.reply({
    content,
    components,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  return response.then(
    () => {
      lifecycle.markAcknowledged("immediate-private-reply");
      return "handled" as const;
    },
    (error: unknown) => {
      lifecycle.fail(error, { stage: "immediate-private-reply" });
      return "handled" as const;
    },
  );
}
