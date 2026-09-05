import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import {
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  classifyError,
  isDiscordInteractionAcknowledged,
  isDiscordInteractionExpired,
  type ClassifiedError,
} from "../errors.js";
import {
  logClassifiedError,
  logInfo,
  logWarn,
  type LogMetadata,
} from "../logging.js";
import { observeLatency } from "../latency.js";

export const INTERACTION_ACK_DEADLINE_MS = 3_000;
export const INTERACTION_STALE_CUTOFF_MS = 2_850;
export const INTERACTION_AGE_WARNING_MS = 2_000;
export const AUTOCOMPLETE_FALLBACK_MS = 1_200;

export type InteractionKind =
  "command" | "button" | "modal" | "select" | "autocomplete" | "other";

export type InteractionOutcome =
  | "succeeded"
  | "handled"
  | "rejected"
  | "failed"
  | "expired"
  | "already-acknowledged"
  | "autocomplete-fallback"
  | "ignored";

export interface EventLoopDelaySnapshot {
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p99Ms: number;
}

export interface InteractionLifecycleOptions {
  readonly now?: () => number;
  readonly correlationId?: () => string;
  readonly eventLoopDelay?: () => EventLoopDelaySnapshot;
}

export interface InteractionLifecycle {
  readonly correlationId: string;
  readonly kind: InteractionKind;
  readonly operation: string;
  readonly receivedAtMs: number;
  readonly ageAtReceiptMs: number;
  readonly eventLoopDelay: EventLoopDelaySnapshot;
  readonly ready: Promise<boolean>;
  complete: (outcome?: InteractionOutcome) => void;
  fail: (error: unknown, metadata?: LogMetadata) => ClassifiedError;
  markAcknowledged: (acknowledgement: string) => void;
}

type DeferrableInteraction =
  | ButtonInteraction
  | ChatInputCommandInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

const contexts = new WeakMap<Interaction, InteractionLifecycle>();

export class EventLoopDiagnostics {
  private readonly histogram: IntervalHistogram;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  public constructor(
    private readonly reportIntervalMs = 30_000,
    private readonly warningThresholdMs = 250,
  ) {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.timer = setInterval(() => this.report(), reportIntervalMs);
    this.timer.unref?.();
  }

  public snapshot(): EventLoopDelaySnapshot {
    return {
      maxMs: nanosecondsToMilliseconds(this.histogram.max),
      meanMs: nanosecondsToMilliseconds(this.histogram.mean),
      p99Ms: nanosecondsToMilliseconds(this.histogram.percentile(99)),
    };
  }

  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.histogram.disable();
  }

  private report(): void {
    const snapshot = this.snapshot();
    if (snapshot.maxMs >= this.warningThresholdMs) {
      logWarn(
        "event-loop",
        "The Bun event loop was delayed; Discord interactions may have arrived stale.",
        {
          maxDelayMs: snapshot.maxMs,
          p99DelayMs: snapshot.p99Ms,
          meanDelayMs: snapshot.meanMs,
          action:
            "Review synchronous database/backfill work and gateway health before retrying expired interactions.",
        },
      );
    }
    this.histogram.reset();
  }
}

export function beginInteractionLifecycle(
  interaction: Interaction,
  options: InteractionLifecycleOptions = {},
): InteractionLifecycle {
  const existing = contexts.get(interaction);
  if (existing) return existing;

  const now = options.now ?? Date.now;
  const receivedAtMs = now();
  const createdAtMs = finiteTimestamp(
    interaction.createdTimestamp,
    receivedAtMs,
  );
  const ageAtReceiptMs = Math.max(0, receivedAtMs - createdAtMs);
  const correlationId =
    options.correlationId?.() ?? randomUUID().replaceAll("-", "").slice(0, 12);
  const kind = interactionKind(interaction);
  const operation = interactionOperation(interaction);
  const eventLoopDelay = options.eventLoopDelay?.() ?? zeroEventLoopDelay();
  let acknowledgedAtMs: number | null = null;
  let acknowledgement: string | null = null;
  let completed = false;

  const lifecycle: InteractionLifecycle = {
    correlationId,
    kind,
    operation,
    receivedAtMs,
    ageAtReceiptMs,
    eventLoopDelay,
    ready: Promise.resolve(true),
    markAcknowledged(nextAcknowledgement: string): void {
      acknowledgedAtMs ??= now();
      acknowledgement ??= nextAcknowledgement;
    },
    complete(outcome: InteractionOutcome = "succeeded"): void {
      if (completed) return;
      completed = true;
      if (
        acknowledgedAtMs === null &&
        ((isDeferrableInteraction(interaction) &&
          (interaction.deferred || interaction.replied)) ||
          (interaction.isAutocomplete() && interaction.responded))
      ) {
        acknowledgedAtMs = now();
        acknowledgement = "handler-response";
      }
      const totalDurationMs = Math.max(0, now() - receivedAtMs);
      logInfo("interaction", `${titleCase(kind)} interaction completed`, {
        correlationId,
        operation,
        guildId: interaction.guildId ?? "dm",
        outcome,
        ageAtReceiptMs,
        acknowledgement: acknowledgement ?? "none",
        ...(acknowledgedAtMs === null
          ? {}
          : {
              acknowledgementLatencyMs: Math.max(
                0,
                acknowledgedAtMs - receivedAtMs,
              ),
            }),
        totalDurationMs,
      });
    },
    fail(error: unknown, metadata: LogMetadata = {}): ClassifiedError {
      const classified = logClassifiedError("interaction", error, {
        correlationId,
        kind,
        operation,
        guildId: interaction.guildId ?? "dm",
        ageAtReceiptMs,
        acknowledgement: acknowledgement ?? "none",
        ...(acknowledgedAtMs === null
          ? {}
          : {
              acknowledgementLatencyMs: Math.max(
                0,
                acknowledgedAtMs - receivedAtMs,
              ),
            }),
        totalDurationMs: Math.max(0, now() - receivedAtMs),
        eventLoopMaxDelayMs: eventLoopDelay.maxMs,
        ...metadata,
      });
      lifecycle.complete(
        classified.category === "interaction-expired"
          ? "expired"
          : classified.category === "interaction-acknowledged"
            ? "already-acknowledged"
            : "failed",
      );
      return classified;
    },
  };
  contexts.set(interaction, lifecycle);

  const logReceipt = (): void => {
    logInfo("interaction", `${titleCase(kind)} interaction received`, {
      correlationId,
      operation,
      guildId: interaction.guildId ?? "dm",
      ageAtReceiptMs,
      eventLoopMaxDelayMs: eventLoopDelay.maxMs,
    });
    if (ageAtReceiptMs >= INTERACTION_AGE_WARNING_MS) {
      logWarn(
        "interaction",
        "Discord interaction arrived close to its acknowledgement deadline.",
        {
          correlationId,
          operation,
          guildId: interaction.guildId ?? "dm",
          ageAtReceiptMs,
          deadlineMs: INTERACTION_ACK_DEADLINE_MS,
          eventLoopMaxDelayMs: eventLoopDelay.maxMs,
          action:
            "Check event-loop-delay warnings and gateway health before retrying.",
        },
      );
    }
  };

  // Stale interactions have no valid acknowledgement to start, so preserve a
  // receipt-before-failure log sequence. All live deferrable interactions start
  // their acknowledgement first so terminal output cannot delay Discord I/O.
  if (ageAtReceiptMs >= INTERACTION_STALE_CUTOFF_MS) logReceipt();
  const ready = prepareAtReceipt(interaction, lifecycle, ageAtReceiptMs);
  if (ageAtReceiptMs < INTERACTION_STALE_CUTOFF_MS) {
    if (interactionPreservesInitialResponse(interaction)) {
      // The caller starts showModal/reply synchronously after this function
      // returns. Queue only the terminal receipt line behind that API call.
      queueMicrotask(logReceipt);
    } else {
      logReceipt();
    }
  }
  Object.defineProperty(lifecycle, "ready", {
    configurable: false,
    enumerable: true,
    value: ready,
    writable: false,
  });
  return lifecycle;
}

export function getInteractionLifecycle(
  interaction: Interaction,
): InteractionLifecycle | null {
  return contexts.get(interaction) ?? null;
}

export async function runBoundedAutocomplete(
  interaction: AutocompleteInteraction,
  lifecycle: InteractionLifecycle,
  handler: () => Promise<void>,
  timeoutMs = AUTOCOMPLETE_FALLBACK_MS,
): Promise<"handled" | "fallback"> {
  let claimed = false;
  let fallbackUsed = false;
  const originalRespondMethod = interaction.respond;
  const originalRespond = originalRespondMethod.bind(interaction);
  let responsePromise: ReturnType<AutocompleteInteraction["respond"]> | null =
    null;
  interaction.respond = ((choices) => {
    if (responsePromise) return responsePromise;
    claimed = true;
    try {
      responsePromise = observeLatency(
        "discord.respond",
        "autocomplete",
        () => originalRespond(choices),
        {
          guildId: interaction.guildId ?? "dm",
          correlationId: lifecycle.correlationId,
        },
        "info",
      );
    } catch (error) {
      claimed = false;
      throw error;
    }
    void responsePromise.then(
      () =>
        lifecycle.markAcknowledged(
          fallbackUsed ? "autocomplete-fallback" : "autocomplete",
        ),
      () => undefined,
    );
    return responsePromise;
  }) as AutocompleteInteraction["respond"];

  const useFallback = (
    reason: "timeout" | "missing-response",
  ): Promise<void> => {
    if (claimed || interaction.responded) return Promise.resolve();
    fallbackUsed = true;
    let fallbackResponse: ReturnType<AutocompleteInteraction["respond"]>;
    try {
      // Start the one allowed autocomplete acknowledgement before terminal
      // formatting so logging backpressure cannot consume more of its budget.
      fallbackResponse = interaction.respond([]);
    } catch (error) {
      lifecycle.fail(error, {
        stage: "autocomplete-fallback",
        fallbackReason: reason,
      });
      return Promise.resolve();
    }
    logWarn(
      "interaction",
      reason === "timeout"
        ? "Autocomplete exceeded its response budget; Superior returned an empty safe result."
        : "Autocomplete completed without a response; Superior returned an empty safe result.",
      {
        correlationId: lifecycle.correlationId,
        operation: lifecycle.operation,
        ageAtReceiptMs: lifecycle.ageAtReceiptMs,
        timeoutMs,
        reason,
      },
    );
    return fallbackResponse.then(
      () => undefined,
      (error: unknown) => {
        lifecycle.fail(error, {
          stage: "autocomplete-fallback",
          fallbackReason: reason,
        });
      },
    );
  };

  const timer = setTimeout(
    () => {
      void useFallback("timeout");
    },
    Math.max(0, Math.floor(timeoutMs)),
  );
  timer.unref?.();

  let handlerFailed = false;
  let handlerError: unknown;
  try {
    await handler();
  } catch (error) {
    handlerFailed = true;
    handlerError = error;
  } finally {
    clearTimeout(timer);
  }
  await useFallback("missing-response");
  interaction.respond = originalRespondMethod;
  if (handlerFailed) throw handlerError;
  return fallbackUsed ? "fallback" : "handled";
}

export async function replyWithUnexpectedInteractionError(
  interaction: DeferrableInteraction,
  classified: ClassifiedError,
  content: string,
): Promise<boolean> {
  if (!classified.interactionTokenValid) {
    logWarn(
      "interaction",
      "No user response was attempted because Discord invalidated the interaction token.",
      {
        code: classified.code,
        outcome: "response-skipped",
        action: classified.recoveryAction,
      },
    );
    return false;
  }
  if (classified.category === "interaction-acknowledged") {
    logWarn(
      "interaction",
      "No competing response was attempted for an already-acknowledged interaction.",
      { code: classified.code, outcome: "response-skipped" },
    );
    return false;
  }

  try {
    if (interaction.deferred && !interaction.replied) {
      await observeLatency(
        "discord.editReply",
        "editReply",
        () =>
          interaction.editReply({ content, allowedMentions: { parse: [] } }),
        { guildId: interaction.guildId ?? "dm" },
        "info",
      );
      return true;
    }
    if (interaction.replied) {
      await observeLatency(
        "discord.followUp",
        "followUp",
        () =>
          interaction.followUp({
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          }),
        { guildId: interaction.guildId ?? "dm" },
        "info",
      );
      return true;
    }
    await observeLatency(
      "discord.reply",
      "reply",
      () =>
        interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }),
      { guildId: interaction.guildId ?? "dm" },
      "info",
    );
    return true;
  } catch (error) {
    const fallback = classifyError(error);
    if (isDiscordInteractionExpired(error)) {
      logWarn(
        "interaction",
        "The interaction expired while Superior attempted its generic private recovery response.",
        {
          code: fallback.code,
          outcome: "response-expired",
          action: fallback.recoveryAction,
        },
      );
      return false;
    }
    logClassifiedError("interaction", error, {
      stage: "generic-private-response",
    });
    return false;
  }
}

export function interactionPreservesInitialResponse(
  interaction: Interaction,
): boolean {
  if (interaction.isChatInputCommand()) {
    const subcommand = interaction.options.getSubcommand(false);
    return (
      (interaction.commandName === "application" ||
        interaction.commandName === "suggestion" ||
        interaction.commandName === "report" ||
        interaction.commandName === "appeal") &&
      subcommand === "submit"
    );
  }
  if (interaction.isStringSelectMenu()) {
    return (
      interaction.customId.startsWith("superior:ticket:select:") ||
      interaction.customId.startsWith("superior:application:select:")
    );
  }
  if (!interaction.isButton()) return false;
  const customId = interaction.customId;
  return (
    customId.startsWith("superior:dm:") ||
    customId.startsWith("superior:ticket:open:") ||
    customId.startsWith("superior:ticket:close:") ||
    customId.startsWith("superior:suggestion:open:") ||
    customId.startsWith("superior:suggestion:review:") ||
    customId.startsWith("superior:application:open:") ||
    customId.startsWith("superior:application:accept:") ||
    customId.startsWith("superior:application:reject:") ||
    customId.startsWith("superior:report:open:") ||
    customId.startsWith("superior:report:resolve:") ||
    customId.startsWith("superior:report:dismiss:") ||
    customId.startsWith("superior:appeal:open:") ||
    customId.startsWith("superior:appeal:uphold:") ||
    customId.startsWith("superior:appeal:overturn:")
  );
}

function prepareAtReceipt(
  interaction: Interaction,
  lifecycle: InteractionLifecycle,
  ageAtReceiptMs: number,
): Promise<boolean> {
  if (ageAtReceiptMs >= INTERACTION_STALE_CUTOFF_MS) {
    const staleError = Object.assign(
      new Error("Discord interaction was already stale at event receipt"),
      { name: "DiscordAPIError[10062]", code: 10062 },
    );
    lifecycle.fail(staleError, {
      stage: "event-receipt",
      outcome: "operation-not-executed",
    });
    return Promise.resolve(false);
  }
  if (
    interaction.isAutocomplete() ||
    interactionPreservesInitialResponse(interaction)
  ) {
    return Promise.resolve(true);
  }
  if (!isDeferrableInteraction(interaction)) return Promise.resolve(true);
  if (interaction.deferred || interaction.replied) {
    lifecycle.markAcknowledged("existing-response");
    return Promise.resolve(true);
  }

  // Calling deferReply begins the Discord acknowledgement request immediately,
  // before the tracked handler is placed on a promise continuation.
  const acknowledgement = observeLatency(
    "discord.deferReply",
    "deferReply",
    () =>
      interaction.deferReply(
        interactionUsesPublicDeferral(interaction)
          ? {}
          : { flags: MessageFlags.Ephemeral },
      ),
    {
      guildId: interaction.guildId ?? "dm",
    },
    "info",
  );
  return acknowledgement.then(
    () => {
      lifecycle.markAcknowledged("defer-reply");
      return true;
    },
    (error: unknown) => {
      const classified = lifecycle.fail(error, {
        stage: "initial-acknowledgement",
        outcome: "operation-not-executed",
      });
      if (
        isDiscordInteractionExpired(error) ||
        isDiscordInteractionAcknowledged(error)
      ) {
        return false;
      }
      return (
        classified.interactionTokenValid &&
        (interaction.deferred || interaction.replied)
      );
    },
  );
}

function interactionUsesPublicDeferral(
  interaction: DeferrableInteraction,
): boolean {
  return (
    interaction.isChatInputCommand() &&
    (interaction.commandName === "greetings" ||
      (interaction.commandName === "fun" &&
        interaction.options.getSubcommand(false) === "battle"))
  );
}

function interactionKind(interaction: Interaction): InteractionKind {
  if (interaction.isAutocomplete()) return "autocomplete";
  if (interaction.isChatInputCommand()) return "command";
  if (interaction.isButton()) return "button";
  if (interaction.isModalSubmit()) return "modal";
  if (interaction.isStringSelectMenu()) return "select";
  return "other";
}

function interactionOperation(interaction: Interaction): string {
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
    const subcommand = interaction.options.getSubcommand(false);
    return sanitizeOperation(
      subcommand
        ? `${interaction.commandName}/${subcommand}`
        : interaction.commandName,
    );
  }
  if (
    interaction.isButton() ||
    interaction.isModalSubmit() ||
    interaction.isStringSelectMenu()
  ) {
    return sanitizeComponentRoute(interaction.customId);
  }
  return "unsupported";
}

function sanitizeComponentRoute(customId: string): string {
  const parts = customId.split(":").slice(0, 3);
  const safe = parts.filter((part) => /^[a-z][a-z0-9-]{0,31}$/u.test(part));
  return safe.length >= 2 ? safe.join(":") : "component:unknown";
}

function sanitizeOperation(value: string): string {
  return /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)?$/u.test(value)
    ? value.slice(0, 80)
    : "command:unknown";
}

function isDeferrableInteraction(
  interaction: Interaction,
): interaction is DeferrableInteraction {
  return (
    interaction.isChatInputCommand() ||
    interaction.isButton() ||
    interaction.isModalSubmit() ||
    interaction.isStringSelectMenu()
  );
}

function finiteTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.round((value / 1_000_000) * 10) / 10 : 0;
}

function zeroEventLoopDelay(): EventLoopDelaySnapshot {
  return { maxMs: 0, meanMs: 0, p99Ms: 0 };
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
