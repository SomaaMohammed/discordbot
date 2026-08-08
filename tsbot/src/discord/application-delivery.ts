import {
  ChannelType,
  escapeMarkdown,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
} from "discord.js";
import type {
  ApplicationDeliveryInput,
  ApplicationDeliveryResult,
  ApplicationForm,
  ApplicationFormField,
  ApplicationRecord,
  ApplicationResponse,
} from "../types.js";
import {
  buildApplicationReviewPayload,
  type ApplicationDisplayRecord,
  type ApplicationFormDisplay,
} from "./application-components.js";
import type { FormFieldInput, FormResponse } from "./forms.js";

export interface ApplicationDeliveryStorage {
  bindApplicationDelivery(
    applicationId: string,
    input: ApplicationDeliveryInput,
  ): ApplicationDeliveryResult;
  failApplicationDelivery(
    applicationId: string,
    reason: string,
  ): ApplicationDeliveryResult;
  markApplicationDeliveryMissing(
    applicationId: string,
    expectedUpdatedAt?: string,
  ): ApplicationDeliveryResult;
  getApplicationById?(applicationId: string): ApplicationRecord | null;
  listApplicationResponses(applicationId: string): ApplicationResponse[];
}

export interface ApplicationPublishResult {
  application: ApplicationRecord;
  message: Message;
}

export async function publishReservedApplication(
  guild: Guild,
  channel: TextChannel,
  form: ApplicationForm,
  application: ApplicationRecord,
  storage: ApplicationDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<ApplicationPublishResult> {
  if (
    guild.id !== application.guildId ||
    form.guildId !== guild.id ||
    form.formId !== application.formId ||
    channel.guild.id !== guild.id ||
    channel.id !== form.reviewChannelId
  ) {
    throw new Error(
      "Application delivery resources do not belong to this server.",
    );
  }

  let message: Message | null = null;
  try {
    if (!isCurrent()) {
      throw new Error(
        "Application delivery was cancelled because this server changed.",
      );
    }
    const responses = storage.listApplicationResponses(
      application.applicationId,
    );
    message = await channel.send(
      buildApplicationReviewPayload(
        toApplicationDisplayRecord(application),
        toApplicationFormDisplay(form, []),
        toFormResponses(responses),
      ),
    );
    if (!isCurrent()) {
      throw new Error(
        "Application delivery was cancelled because this server changed.",
      );
    }
    const bound = storage.bindApplicationDelivery(application.applicationId, {
      reviewChannelId: channel.id,
      reviewMessageId: message.id,
      expectedUpdatedAt: application.updatedAt,
    });
    if (bound.status !== "posted" && bound.status !== "already-posted") {
      throw new Error(
        "Application review-message binding changed before it could be saved.",
      );
    }
    if (
      bound.status === "already-posted" &&
      bound.application.reviewMessageId !== message.id
    ) {
      const duplicate = message;
      message = null;
      await duplicate.delete().catch(() => undefined);
      throw new Error(
        "Another recovery operation already posted this application.",
      );
    }
    return { application: bound.application, message };
  } catch (error) {
    if (message) await message.delete().catch(() => undefined);
    const failureReason =
      errorMessage(error).trim().slice(0, 1_000) ||
      "Application delivery failed.";
    if (isCurrent()) {
      try {
        storage.failApplicationDelivery(
          application.applicationId,
          failureReason,
        );
      } catch {
        // Preserve the Discord delivery error; recovery can inspect the reservation.
      }
    }
    throw error;
  }
}

export async function refreshApplicationReviewMessage(
  guild: Guild,
  form: ApplicationForm,
  application: ApplicationRecord,
  storage: ApplicationDeliveryStorage,
  isCurrent: () => boolean = () => true,
): Promise<"updated" | "missing" | "unavailable"> {
  if (
    application.guildId !== guild.id ||
    form.guildId !== guild.id ||
    form.formId !== application.formId ||
    !application.reviewChannelId ||
    !application.reviewMessageId
  ) {
    return "unavailable";
  }
  let expected = application;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!isCurrent()) return "unavailable";
    const latest = storage.getApplicationById?.(expected.applicationId);
    if (latest) {
      if (
        latest.guildId !== guild.id ||
        latest.formId !== form.formId ||
        !latest.reviewChannelId ||
        !latest.reviewMessageId
      ) {
        return "unavailable";
      }
      expected = latest;
    }
    let channel: GuildBasedChannel | null;
    try {
      channel = await guild.channels.fetch(expected.reviewChannelId!, {
        cache: true,
        force: true,
      });
    } catch (error) {
      if (!isUnknownDiscordResource(error, 10_003)) return "unavailable";
      channel = null;
    }
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guild.id !== guild.id
    ) {
      return markDeliveryMissing(storage, expected, isCurrent);
    }
    let message: Message | null;
    try {
      message = await channel.messages.fetch(expected.reviewMessageId!);
    } catch (error) {
      if (!isUnknownDiscordResource(error, 10_008)) return "unavailable";
      message = null;
    }
    if (!message || message.author.id !== guild.client.user?.id) {
      return markDeliveryMissing(storage, expected, isCurrent);
    }
    if (!isCurrent()) return "unavailable";
    try {
      await message.edit(
        buildApplicationReviewPayload(
          toApplicationDisplayRecord(expected),
          toApplicationFormDisplay(form, []),
          toFormResponses(
            storage.listApplicationResponses(expected.applicationId),
          ),
        ),
      );
    } catch (error) {
      return isUnknownDiscordResource(error, 10_008)
        ? markDeliveryMissing(storage, expected, isCurrent)
        : "unavailable";
    }
    if (!isCurrent()) return "unavailable";
    const after = storage.getApplicationById?.(expected.applicationId);
    if (!after || sameApplicationDeliverySnapshot(expected, after)) {
      return "updated";
    }
    expected = after;
  }
  return "unavailable";
}

export async function notifyApplicationApplicant(
  guild: Guild,
  form: ApplicationForm,
  application: ApplicationRecord,
): Promise<void> {
  const applicant = await guild.client.users
    .fetch(application.applicantId)
    .catch(() => null);
  if (!applicant || applicant.bot) return;
  const reason = application.decisionReason
    ? `\nReason: ${application.decisionReason}`
    : "";
  await applicant
    .send({
      content: [
        `Your **${escapeMarkdown(form.displayName)}** application #${application.applicationNumber}`,
        `is now **${application.state}**.${reason}`,
      ]
        .join(" ")
        .slice(0, 2_000),
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

export function toApplicationFormDisplay(
  form: ApplicationForm,
  fields: readonly ApplicationFormField[],
): ApplicationFormDisplay {
  return {
    formId: form.formId,
    definitionVersion: form.definitionVersion,
    slug: form.slug,
    displayName: form.displayName,
    description: form.description,
    fields: fields.map(toFormFieldInput),
  };
}

export function toFormFieldInput(field: ApplicationFormField): FormFieldInput {
  return {
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
  };
}

export function toFormResponses(
  responses: readonly ApplicationResponse[],
): FormResponse[] {
  return responses.map((response) => ({
    fieldId: response.fieldId,
    key: response.fieldId,
    label: response.fieldLabel,
    value: response.responseText,
    sortOrder: response.sortOrder,
  }));
}

export function toApplicationDisplayRecord(
  application: ApplicationRecord,
): ApplicationDisplayRecord {
  return {
    applicationId: application.applicationId,
    applicationNumber: application.applicationNumber,
    applicantId: application.applicantId,
    state: application.state,
    claimedBy: application.claimedBy,
    decisionBy: application.decisionBy,
    decisionReason: application.decisionReason,
    createdAt: application.createdAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Application delivery failed.";
}

function markDeliveryMissing(
  storage: ApplicationDeliveryStorage,
  application: ApplicationRecord,
  isCurrent: () => boolean,
): "missing" | "unavailable" {
  if (!isCurrent()) return "unavailable";
  const result = storage.markApplicationDeliveryMissing(
    application.applicationId,
    application.updatedAt,
  );
  return result.status === "missing" || result.status === "already-missing"
    ? "missing"
    : "unavailable";
}

function sameApplicationDeliverySnapshot(
  expected: ApplicationRecord,
  current: ApplicationRecord,
): boolean {
  return (
    expected.guildId === current.guildId &&
    expected.formId === current.formId &&
    expected.state === current.state &&
    expected.deliveryState === current.deliveryState &&
    expected.reviewChannelId === current.reviewChannelId &&
    expected.reviewMessageId === current.reviewMessageId &&
    expected.claimedBy === current.claimedBy &&
    expected.decisionBy === current.decisionBy &&
    expected.decisionReason === current.decisionReason &&
    expected.updatedAt === current.updatedAt
  );
}

function isUnknownDiscordResource(
  error: unknown,
  expectedCode: number,
): boolean {
  if (!error || typeof error !== "object") return false;
  return Number((error as { code?: unknown }).code) === expectedCode;
}
