import { randomBytes } from "node:crypto";
import type {
  MemberOnboardingState,
  OnboardingAutoroleAudience,
  OnboardingConfiguration,
  OnboardingDeliveryCompletionInput,
  OnboardingDeliveryKind,
  OnboardingRoleOperationCompletionInput,
  OnboardingRoleOperationKind,
} from "../types.js";
import type {
  OnboardingLifecycleDefinitionSnapshot,
  OnboardingRepository,
} from "./onboarding-repository.js";
import { renderOnboardingTemplatePair } from "./onboarding-template.js";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/u;
const RESERVATION_TTL_MS = 30_000;
const MAX_AUTOROLES_PER_AUDIENCE = 10;

export type MemberLifecycleRepository = Pick<
  OnboardingRepository,
  | "getOnboardingConfiguration"
  | "isOnboardingLifecycleDefinitionCurrent"
  | "listOnboardingAutoroles"
  | "getMemberOnboardingState"
  | "upsertMemberOnboardingState"
  | "reserveOnboardingDelivery"
  | "completeOnboardingDelivery"
  | "reserveOnboardingRoleOperation"
  | "completeOnboardingRoleOperation"
  | "appendOnboardingAudit"
>;

export interface MemberLifecycleSnapshot {
  readonly guildId: string;
  readonly memberId: string;
  readonly isBot: boolean;
  readonly pending: boolean;
  readonly displayName: string;
  readonly guildName: string;
  readonly approximateMemberCount: number;
  readonly accountCreatedAt: Date;
  readonly joinedAt: Date | null;
}

export interface MemberLifecycleMessage {
  readonly title: string;
  readonly body: string;
}

export type MemberLifecycleLogEvent =
  | {
      readonly kind: "member-joined" | "bot-joined";
      readonly memberId: string;
      readonly pending: boolean;
    }
  | {
      readonly kind: "member-left" | "bot-left";
      readonly memberId: string;
    }
  | {
      readonly kind: "account-age-alert";
      readonly memberId: string;
      readonly accountCreatedAt: string;
      readonly thresholdHours: number;
    }
  | {
      readonly kind: "automatic-role-failure";
      readonly memberId: string;
      readonly roleId: string;
      readonly failureCode: string;
    }
  | {
      readonly kind: "verification-accepted" | "verification-recovery";
      readonly memberId: string;
      readonly rulesVersion: number;
    };

export type MemberLifecycleDeliveryRequest =
  | {
      readonly kind: "welcome-public" | "farewell-public";
      readonly guildId: string;
      readonly memberId: string;
      readonly channelId: string;
      readonly message: MemberLifecycleMessage;
    }
  | {
      readonly kind: "welcome-dm";
      readonly guildId: string;
      readonly memberId: string;
      readonly channelId: null;
      readonly message: MemberLifecycleMessage;
    }
  | {
      readonly kind: "lifecycle-log";
      readonly guildId: string;
      readonly memberId: string;
      readonly channelId: string;
      readonly events: readonly MemberLifecycleLogEvent[];
    };

export interface MemberLifecycleDeliveryReceipt {
  readonly channelId: string;
  readonly messageId: string;
}

export interface MemberLifecycleRoleRequest {
  readonly guildId: string;
  readonly memberId: string;
  readonly roleId: string;
  readonly audience: OnboardingAutoroleAudience;
  readonly operationKind: Extract<
    OnboardingRoleOperationKind,
    "human-autorole-add" | "bot-autorole-add"
  >;
}

export type MemberLifecycleRoleAssignmentResult = "added" | "already-held";

export interface MemberLifecycleEffects {
  /**
   * Sends one already-bounded lifecycle payload. The adapter must suppress
   * mentions and freshly validate a public/log destination before sending.
   */
  deliver(
    request: MemberLifecycleDeliveryRequest,
    isDefinitionCurrent?: () => boolean,
  ): Promise<MemberLifecycleDeliveryReceipt>;

  /**
   * Re-fetches the guild member, bot member, and role; applies the shared safe
   * role policy and hierarchy checks; then performs at most one role addition.
   */
  validateAndAssignRole(
    request: MemberLifecycleRoleRequest,
    isDefinitionCurrent?: () => boolean,
  ): Promise<MemberLifecycleRoleAssignmentResult>;
}

export type MemberLifecycleFailureOperation =
  OnboardingDeliveryKind | "human-autorole-add" | "bot-autorole-add";

export type MemberLifecycleResultStatus =
  | "processed"
  | "deferred"
  | "disabled"
  | "no-change"
  | "not-accepting"
  | "stale";

export interface MemberLifecycleDeliveryOutcome {
  readonly kind: OnboardingDeliveryKind;
  readonly status: "delivered" | "failed" | "duplicate" | "busy" | "stale";
  readonly failureCode: string | null;
}

export interface MemberLifecycleRoleOutcome {
  readonly roleId: string;
  readonly operationKind: Extract<
    OnboardingRoleOperationKind,
    "human-autorole-add" | "bot-autorole-add"
  >;
  readonly status:
    | "added"
    | "already-held"
    | "partial"
    | "failed"
    | "duplicate"
    | "pending"
    | "stale";
  readonly failureCode: string | null;
}

export interface MemberLifecycleResult {
  readonly status: MemberLifecycleResultStatus;
  readonly state: MemberOnboardingState | null;
  readonly deliveries: readonly MemberLifecycleDeliveryOutcome[];
  readonly roles: readonly MemberLifecycleRoleOutcome[];
}

export interface MemberLifecycleService {
  handleJoin(snapshot: MemberLifecycleSnapshot): Promise<MemberLifecycleResult>;
  handleScreeningUpdate(
    snapshot: MemberLifecycleSnapshot,
  ): Promise<MemberLifecycleResult>;
  handleLeave(
    snapshot: MemberLifecycleSnapshot,
  ): Promise<MemberLifecycleResult>;
}

export interface CreateMemberLifecycleServiceOptions {
  readonly guildId: string;
  readonly repository: MemberLifecycleRepository;
  readonly effects: MemberLifecycleEffects;
  readonly isCurrent?: () => boolean;
  /**
   * Indicates whether this member event still represents the latest observed
   * presence state. Unlike runtime generation, a superseded event still
   * persists its ordered lifecycle transition but must not start new Discord
   * effects.
   */
  readonly isEffectCurrent?: () => boolean;
  readonly isAcceptingWork?: () => boolean;
  readonly now?: () => Date;
  readonly createClaimId?: () => string;
  readonly classifyFailure?: (
    error: unknown,
    operation: MemberLifecycleFailureOperation,
  ) => string;
}

export function createMemberLifecycleService(
  options: CreateMemberLifecycleServiceOptions,
): MemberLifecycleService {
  return new DefaultMemberLifecycleService(options);
}

class DefaultMemberLifecycleService implements MemberLifecycleService {
  private readonly guildId: string;
  private readonly repository: MemberLifecycleRepository;
  private readonly effects: MemberLifecycleEffects;
  private readonly isCurrent: () => boolean;
  private readonly isEffectCurrent: () => boolean;
  private readonly isAcceptingWork: () => boolean;
  private readonly now: () => Date;
  private readonly createClaimId: () => string;
  private readonly classifyFailure: (
    error: unknown,
    operation: MemberLifecycleFailureOperation,
  ) => string;

  public constructor(options: CreateMemberLifecycleServiceOptions) {
    this.guildId = requireSnowflake(options.guildId, "guild ID");
    this.repository = options.repository;
    this.effects = options.effects;
    this.isCurrent = options.isCurrent ?? (() => true);
    this.isEffectCurrent = options.isEffectCurrent ?? (() => true);
    this.isAcceptingWork = options.isAcceptingWork ?? (() => true);
    this.now = options.now ?? (() => new Date());
    this.createClaimId = options.createClaimId ?? createOpaqueId;
    this.classifyFailure = options.classifyFailure ?? defaultFailureCode;
  }

  public async handleJoin(
    snapshot: MemberLifecycleSnapshot,
  ): Promise<MemberLifecycleResult> {
    this.assertSnapshot(snapshot);
    const gate = this.entryGate();
    if (gate) return emptyResult(gate);

    const configuration = this.currentEnabledConfiguration();
    if (!configuration) return emptyResult("disabled");
    const definition = this.captureJoinDefinition(snapshot, configuration);

    const processedAt = requireDate(this.now(), "current time");
    const joinedAt = requireDate(
      snapshot.joinedAt ?? processedAt,
      "member join time",
    );
    const accountCreatedAt = requireDate(
      snapshot.accountCreatedAt,
      "account creation time",
    );
    const previous = this.repository.getMemberOnboardingState(
      snapshot.memberId,
    );
    const isNewJoin =
      previous === null ||
      previous.joinedAt !== joinedAt.toISOString() ||
      previous.lifecycleState === "departed";
    const screeningState = snapshot.isBot
      ? ("unknown" as const)
      : snapshot.pending
        ? ("pending" as const)
        : ("complete" as const);
    const state = this.repository.upsertMemberOnboardingState({
      memberId: snapshot.memberId,
      memberKind: audienceFor(snapshot),
      screeningState,
      lifecycleState:
        snapshot.pending && !snapshot.isBot ? "pending-screening" : "active",
      joinedAt: joinedAt.toISOString(),
      accountCreatedAt: accountCreatedAt.toISOString(),
      screeningCompletedAt:
        !snapshot.isBot && !snapshot.pending
          ? isNewJoin
            ? processedAt.toISOString()
            : (previous.screeningCompletedAt ?? processedAt.toISOString())
          : null,
      departedAt: null,
      lastProcessedAt: processedAt.toISOString(),
    });

    if (isNewJoin) {
      this.repository.appendOnboardingAudit({
        eventType: snapshot.isBot ? "bot-joined" : "member-joined",
        memberId: snapshot.memberId,
        outcome: snapshot.pending && !snapshot.isBot ? "deferred" : "processed",
        details: { screeningState },
      });
    }

    if (this.effectStalenessFailureCode(definition)) {
      return { status: "stale", state, deliveries: [], roles: [] };
    }

    const roles =
      snapshot.pending && !snapshot.isBot
        ? []
        : await this.applyAutomaticRoles(snapshot, definition, state.joinedAt);
    if (this.effectStalenessFailureCode(definition)) {
      return { status: "stale", state, deliveries: [], roles };
    }

    const logEvents = this.joinLogEvents(
      snapshot,
      configuration,
      joinedAt,
      accountCreatedAt,
      roles,
    );
    const deliveries = await this.deliverJoin(
      snapshot,
      definition,
      state.joinedAt,
      logEvents,
    );
    return {
      status: this.effectStalenessFailureCode(definition)
        ? "stale"
        : snapshot.pending && !snapshot.isBot
          ? "deferred"
          : "processed",
      state,
      deliveries,
      roles,
    };
  }

  public async handleScreeningUpdate(
    snapshot: MemberLifecycleSnapshot,
  ): Promise<MemberLifecycleResult> {
    this.assertSnapshot(snapshot);
    const gate = this.entryGate();
    if (gate) return emptyResult(gate);

    const configuration = this.currentEnabledConfiguration();
    if (!configuration) return emptyResult("disabled");
    if (snapshot.isBot) return emptyResult("no-change");
    const definition = this.captureJoinDefinition(snapshot, configuration);

    const previous = this.repository.getMemberOnboardingState(
      snapshot.memberId,
    );
    if (previous?.lifecycleState === "departed") {
      return {
        status: "no-change",
        state: previous,
        deliveries: [],
        roles: [],
      };
    }

    const processedAt = requireDate(this.now(), "current time");
    const joinedAt = requireDate(
      snapshot.joinedAt ??
        (previous ? new Date(previous.joinedAt) : processedAt),
      "member join time",
    );
    const accountCreatedAt = requireDate(
      snapshot.accountCreatedAt,
      "account creation time",
    );
    const state = this.repository.upsertMemberOnboardingState({
      memberId: snapshot.memberId,
      memberKind: "human",
      screeningState: snapshot.pending ? "pending" : "complete",
      lifecycleState: snapshot.pending ? "pending-screening" : "active",
      joinedAt: joinedAt.toISOString(),
      accountCreatedAt: accountCreatedAt.toISOString(),
      screeningCompletedAt: snapshot.pending
        ? null
        : (previous?.screeningCompletedAt ?? processedAt.toISOString()),
      departedAt: null,
      lastProcessedAt: processedAt.toISOString(),
    });

    if (snapshot.pending) {
      return { status: "deferred", state, deliveries: [], roles: [] };
    }

    const completedScreening =
      previous === null || previous.screeningState === "pending";
    if (completedScreening) {
      this.repository.appendOnboardingAudit({
        eventType: "native-screening-completed",
        memberId: snapshot.memberId,
        outcome: "processed",
        details: {},
      });
    }
    if (this.effectStalenessFailureCode(definition)) {
      return { status: "stale", state, deliveries: [], roles: [] };
    }
    const roles = await this.applyAutomaticRoles(
      snapshot,
      definition,
      state.joinedAt,
    );
    return {
      status: this.effectStalenessFailureCode(definition)
        ? "stale"
        : completedScreening ||
            roles.some((role) => role.status !== "duplicate")
          ? "processed"
          : "no-change",
      state,
      deliveries: [],
      roles,
    };
  }

  public async handleLeave(
    snapshot: MemberLifecycleSnapshot,
  ): Promise<MemberLifecycleResult> {
    this.assertSnapshot(snapshot);
    const gate = this.entryGate();
    if (gate) return emptyResult(gate);

    const configuration = this.currentConfiguration();
    const previous = this.repository.getMemberOnboardingState(
      snapshot.memberId,
    );
    if (!configuration || (!configuration.enabled && !previous)) {
      return emptyResult("disabled");
    }
    const definition: OnboardingLifecycleDefinitionSnapshot = {
      configuration,
    };

    const processedAt = requireDate(this.now(), "current time");
    const joinedAt = requireDate(
      previous
        ? new Date(previous.joinedAt)
        : (snapshot.joinedAt ?? processedAt),
      "member join time",
    );
    const accountCreatedAt = requireDate(
      previous
        ? new Date(previous.accountCreatedAt)
        : snapshot.accountCreatedAt,
      "account creation time",
    );
    const alreadyDeparted =
      previous?.lifecycleState === "departed" &&
      previous.joinedAt === joinedAt.toISOString();
    const state = this.repository.upsertMemberOnboardingState({
      memberId: snapshot.memberId,
      memberKind: audienceFor(snapshot),
      screeningState:
        !snapshot.isBot && previous?.screeningState === "complete"
          ? "complete"
          : "unknown",
      lifecycleState: "departed",
      joinedAt: joinedAt.toISOString(),
      accountCreatedAt: accountCreatedAt.toISOString(),
      screeningCompletedAt: previous?.screeningCompletedAt ?? null,
      departedAt: previous?.departedAt ?? processedAt.toISOString(),
      lastProcessedAt: processedAt.toISOString(),
    });

    if (!alreadyDeparted) {
      this.repository.appendOnboardingAudit({
        eventType: snapshot.isBot ? "bot-left" : "member-left",
        memberId: snapshot.memberId,
        outcome: "processed",
        details: {},
      });
    }
    if (!configuration.enabled || alreadyDeparted) {
      return {
        status: alreadyDeparted ? "no-change" : "processed",
        state,
        deliveries: [],
        roles: [],
      };
    }
    if (this.effectStalenessFailureCode(definition)) {
      return { status: "stale", state, deliveries: [], roles: [] };
    }

    const deliveries = await this.deliverLeave(
      snapshot,
      definition,
      state.joinedAt,
      snapshot.isBot ? "bot-left" : "member-left",
    );
    return {
      status: this.effectStalenessFailureCode(definition)
        ? "stale"
        : "processed",
      state,
      deliveries,
      roles: [],
    };
  }

  private entryGate(): "not-accepting" | "stale" | null {
    if (!this.isAcceptingWork()) return "not-accepting";
    return this.isCurrent() ? null : "stale";
  }

  private effectsAreCurrent(): boolean {
    return this.isCurrent() && this.isEffectCurrent();
  }

  private effectStalenessFailureCode(
    definition: OnboardingLifecycleDefinitionSnapshot,
  ): string | null {
    if (!this.effectsAreCurrent()) return this.staleEffectFailureCode();
    return this.repository.isOnboardingLifecycleDefinitionCurrent(definition)
      ? null
      : "onboarding-definition-changed";
  }

  private staleEffectFailureCode(): string {
    return this.isCurrent()
      ? "member-lifecycle-event-superseded"
      : "runtime-generation-changed";
  }

  private currentConfiguration(): OnboardingConfiguration | null {
    const configuration = this.repository.getOnboardingConfiguration();
    if (configuration && configuration.guildId !== this.guildId) {
      throw new Error("Onboarding configuration belongs to another server.");
    }
    return configuration;
  }

  private currentEnabledConfiguration(): OnboardingConfiguration | null {
    const configuration = this.currentConfiguration();
    return configuration?.enabled ? configuration : null;
  }

  private captureJoinDefinition(
    snapshot: MemberLifecycleSnapshot,
    configuration: OnboardingConfiguration,
  ): OnboardingLifecycleDefinitionSnapshot {
    const audience = audienceFor(snapshot);
    return {
      configuration,
      autoroles: {
        audience,
        roles: this.repository.listOnboardingAutoroles(
          audience,
          MAX_AUTOROLES_PER_AUDIENCE,
          0,
        ),
      },
    };
  }

  private assertSnapshot(snapshot: MemberLifecycleSnapshot): void {
    if (snapshot.guildId !== this.guildId) {
      throw new Error("Member lifecycle event belongs to another server.");
    }
    requireSnowflake(snapshot.memberId, "member ID");
  }

  private async applyAutomaticRoles(
    snapshot: MemberLifecycleSnapshot,
    definition: OnboardingLifecycleDefinitionSnapshot,
    joinedAt: string,
  ): Promise<MemberLifecycleRoleOutcome[]> {
    const audience = audienceFor(snapshot);
    const configuration = definition.configuration;
    const enabled = snapshot.isBot
      ? configuration.botAutorolesEnabled
      : configuration.humanAutorolesEnabled;
    if (!enabled) return [];

    const roles = (definition.autoroles?.roles ?? [])
      .filter(
        (role) =>
          role.guildId === this.guildId &&
          role.audience === audience &&
          role.enabled &&
          role.bindingsVerifiedAt !== null,
      )
      .sort((left, right) =>
        left.sortOrder === right.sortOrder
          ? left.roleId.localeCompare(right.roleId)
          : left.sortOrder - right.sortOrder,
      );
    const seen = new Set<string>();
    const outcomes: MemberLifecycleRoleOutcome[] = [];
    for (const role of roles) {
      if (seen.has(role.roleId)) continue;
      seen.add(role.roleId);
      if (this.effectStalenessFailureCode(definition)) break;
      outcomes.push(
        await this.assignAutomaticRole(
          snapshot,
          definition,
          audience,
          role.roleId,
          joinedAt,
        ),
      );
    }
    return outcomes;
  }

  private async assignAutomaticRole(
    snapshot: MemberLifecycleSnapshot,
    definition: OnboardingLifecycleDefinitionSnapshot,
    audience: OnboardingAutoroleAudience,
    roleId: string,
    joinedAt: string,
  ): Promise<MemberLifecycleRoleOutcome> {
    const operationKind = snapshot.isBot
      ? ("bot-autorole-add" as const)
      : ("human-autorole-add" as const);
    const reserved = this.repository.reserveOnboardingRoleOperation({
      memberId: snapshot.memberId,
      roleId,
      kind: operationKind,
      idempotencyKey: `join:${joinedAt}`,
    });
    if (reserved.status === "pending") {
      return roleOutcome(roleId, operationKind, "pending", null);
    }
    if (reserved.status === "completed") {
      return roleOutcome(
        roleId,
        operationKind,
        "duplicate",
        reserved.operation.failureCode,
      );
    }
    const stalenessFailureCode = this.effectStalenessFailureCode(definition);
    if (stalenessFailureCode) {
      this.completeRoleSafely(reserved.operation.operationId, {
        state: "failed",
        failureCode: stalenessFailureCode,
      });
      return roleOutcome(roleId, operationKind, "stale", stalenessFailureCode);
    }

    let result: MemberLifecycleRoleAssignmentResult;
    try {
      result = await this.effects.validateAndAssignRole(
        {
          guildId: this.guildId,
          memberId: snapshot.memberId,
          roleId,
          audience,
          operationKind,
        },
        () =>
          this.repository.isOnboardingLifecycleDefinitionCurrent(definition),
      );
    } catch (error) {
      const stalenessFailureCode = this.effectStalenessFailureCode(definition);
      const failureCode =
        stalenessFailureCode ??
        safeFailureCode(this.classifyFailure(error, operationKind));
      this.completeRoleSafely(reserved.operation.operationId, {
        state: "failed",
        failureCode,
      });
      return roleOutcome(
        roleId,
        operationKind,
        stalenessFailureCode ? "stale" : "failed",
        failureCode,
      );
    }
    try {
      this.repository.completeOnboardingRoleOperation(
        reserved.operation.operationId,
        { state: result === "added" ? "completed" : "no-change" },
      );
      return roleOutcome(roleId, operationKind, result, null);
    } catch {
      const failureCode = "role-checkpoint-persistence";
      this.completeRoleSafely(reserved.operation.operationId, {
        state: "partial",
        failureCode,
      });
      return roleOutcome(roleId, operationKind, "partial", failureCode);
    }
  }

  private completeRoleSafely(
    operationId: string,
    completion: OnboardingRoleOperationCompletionInput,
  ): void {
    try {
      this.repository.completeOnboardingRoleOperation(operationId, completion);
    } catch {
      // The reservation remains visible for bounded administrative recovery.
    }
  }

  private joinLogEvents(
    snapshot: MemberLifecycleSnapshot,
    configuration: OnboardingConfiguration,
    joinedAt: Date,
    accountCreatedAt: Date,
    roles: readonly MemberLifecycleRoleOutcome[],
  ): MemberLifecycleLogEvent[] {
    const events: MemberLifecycleLogEvent[] = [
      {
        kind: snapshot.isBot ? "bot-joined" : "member-joined",
        memberId: snapshot.memberId,
        pending: snapshot.pending && !snapshot.isBot,
      },
    ];
    if (
      !snapshot.isBot &&
      configuration.accountAgeAlertHours !== null &&
      joinedAt.getTime() - accountCreatedAt.getTime() <
        configuration.accountAgeAlertHours * 3_600_000
    ) {
      events.push({
        kind: "account-age-alert",
        memberId: snapshot.memberId,
        accountCreatedAt: accountCreatedAt.toISOString(),
        thresholdHours: configuration.accountAgeAlertHours,
      });
    }
    for (const role of roles) {
      if (
        (role.status !== "failed" && role.status !== "partial") ||
        !role.failureCode
      )
        continue;
      events.push({
        kind: "automatic-role-failure",
        memberId: snapshot.memberId,
        roleId: role.roleId,
        failureCode: role.failureCode,
      });
    }
    return events;
  }

  private async deliverJoin(
    snapshot: MemberLifecycleSnapshot,
    definition: OnboardingLifecycleDefinitionSnapshot,
    joinedAt: string,
    logEvents: readonly MemberLifecycleLogEvent[],
  ): Promise<MemberLifecycleDeliveryOutcome[]> {
    const configuration = definition.configuration;
    const message = renderOnboardingTemplatePair(
      {
        title: configuration.welcomeTitle,
        body: configuration.welcomeBody,
      },
      templateContext(snapshot, configuration),
    );
    const requests: MemberLifecycleDeliveryRequest[] = [];
    if (
      configuration.welcomePublicEnabled &&
      configuration.welcomeChannelId &&
      configuration.welcomeChannelVerifiedAt
    ) {
      requests.push({
        kind: "welcome-public",
        guildId: this.guildId,
        memberId: snapshot.memberId,
        channelId: configuration.welcomeChannelId,
        message,
      });
    }
    if (configuration.welcomeDmEnabled) {
      requests.push({
        kind: "welcome-dm",
        guildId: this.guildId,
        memberId: snapshot.memberId,
        channelId: null,
        message,
      });
    }
    if (
      configuration.lifecycleLogChannelId &&
      configuration.lifecycleLogChannelVerifiedAt
    ) {
      requests.push({
        kind: "lifecycle-log",
        guildId: this.guildId,
        memberId: snapshot.memberId,
        channelId: configuration.lifecycleLogChannelId,
        events: logEvents,
      });
    }
    return this.deliverRequests(definition, `join:${joinedAt}`, requests);
  }

  private async deliverLeave(
    snapshot: MemberLifecycleSnapshot,
    definition: OnboardingLifecycleDefinitionSnapshot,
    joinedAt: string,
    leaveKind: "member-left" | "bot-left",
  ): Promise<MemberLifecycleDeliveryOutcome[]> {
    const configuration = definition.configuration;
    const requests: MemberLifecycleDeliveryRequest[] = [];
    if (
      configuration.farewellPublicEnabled &&
      configuration.farewellChannelId &&
      configuration.farewellChannelVerifiedAt
    ) {
      requests.push({
        kind: "farewell-public",
        guildId: this.guildId,
        memberId: snapshot.memberId,
        channelId: configuration.farewellChannelId,
        message: renderOnboardingTemplatePair(
          {
            title: configuration.farewellTitle,
            body: configuration.farewellBody,
          },
          templateContext(snapshot, configuration),
        ),
      });
    }
    if (
      configuration.lifecycleLogChannelId &&
      configuration.lifecycleLogChannelVerifiedAt
    ) {
      requests.push({
        kind: "lifecycle-log",
        guildId: this.guildId,
        memberId: snapshot.memberId,
        channelId: configuration.lifecycleLogChannelId,
        events: [{ kind: leaveKind, memberId: snapshot.memberId }],
      });
    }
    return this.deliverRequests(definition, `leave:${joinedAt}`, requests);
  }

  private async deliverRequests(
    definition: OnboardingLifecycleDefinitionSnapshot,
    joinInstance: string,
    requests: readonly MemberLifecycleDeliveryRequest[],
  ): Promise<MemberLifecycleDeliveryOutcome[]> {
    const outcomes: MemberLifecycleDeliveryOutcome[] = [];
    for (const request of requests) {
      if (this.effectStalenessFailureCode(definition)) break;
      outcomes.push(await this.deliverOne(definition, joinInstance, request));
    }
    return outcomes;
  }

  private async deliverOne(
    definition: OnboardingLifecycleDefinitionSnapshot,
    joinInstance: string,
    request: MemberLifecycleDeliveryRequest,
  ): Promise<MemberLifecycleDeliveryOutcome> {
    const claimId = requireOpaqueId(this.createClaimId(), "delivery claim ID");
    const claimExpiresAt = new Date(
      requireDate(this.now(), "current time").getTime() + RESERVATION_TTL_MS,
    ).toISOString();
    const reserved = this.repository.reserveOnboardingDelivery({
      memberId: request.memberId,
      joinInstance,
      kind: request.kind,
      claimId,
      claimExpiresAt,
    });
    if (reserved.status === "duplicate") {
      return deliveryOutcome(request.kind, "duplicate", null);
    }
    if (reserved.status === "busy") {
      return deliveryOutcome(request.kind, "busy", null);
    }
    const stalenessFailureCode = this.effectStalenessFailureCode(definition);
    if (stalenessFailureCode) {
      this.completeDeliverySafely(reserved.delivery.deliveryId, {
        claimId,
        state: "failed",
        failureCode: stalenessFailureCode,
      });
      return deliveryOutcome(request.kind, "stale", stalenessFailureCode);
    }

    let receipt: MemberLifecycleDeliveryReceipt;
    try {
      receipt = await this.effects.deliver(request, () =>
        this.repository.isOnboardingLifecycleDefinitionCurrent(definition),
      );
    } catch (error) {
      const stalenessFailureCode = this.effectStalenessFailureCode(definition);
      const failureCode =
        stalenessFailureCode ??
        safeFailureCode(this.classifyFailure(error, request.kind));
      this.completeDeliverySafely(reserved.delivery.deliveryId, {
        claimId,
        state: "failed",
        failureCode,
      });
      return deliveryOutcome(
        request.kind,
        stalenessFailureCode ? "stale" : "failed",
        failureCode,
      );
    }
    try {
      this.repository.completeOnboardingDelivery(reserved.delivery.deliveryId, {
        claimId,
        state: "delivered",
        channelId: requireSnowflake(receipt.channelId, "delivery channel ID"),
        messageId: requireSnowflake(receipt.messageId, "delivery message ID"),
      });
      return deliveryOutcome(request.kind, "delivered", null);
    } catch {
      // Discord already confirmed the external message. Preserve the claim as
      // ambiguous instead of marking it failed and inviting an unsafe resend.
      return deliveryOutcome(
        request.kind,
        "failed",
        "delivery-checkpoint-persistence",
      );
    }
  }

  private completeDeliverySafely(
    deliveryId: string,
    completion: OnboardingDeliveryCompletionInput,
  ): void {
    try {
      this.repository.completeOnboardingDelivery(deliveryId, completion);
    } catch {
      // The persistent claim/terminal row remains inspectable by recovery.
    }
  }
}

function templateContext(
  snapshot: MemberLifecycleSnapshot,
  configuration: OnboardingConfiguration,
): {
  userDisplay: string;
  serverName: string;
  memberCount: number;
  accountCreatedAt: Date | null;
  joinedAt: Date | null;
  rulesChannelId: string | null;
} {
  return {
    userDisplay: snapshot.displayName,
    serverName: snapshot.guildName,
    memberCount: snapshot.approximateMemberCount,
    accountCreatedAt: snapshot.accountCreatedAt,
    joinedAt: snapshot.joinedAt,
    rulesChannelId: configuration.rulesChannelVerifiedAt
      ? configuration.rulesChannelId
      : null,
  };
}

function audienceFor(
  snapshot: MemberLifecycleSnapshot,
): OnboardingAutoroleAudience {
  return snapshot.isBot ? "bot" : "human";
}

function emptyResult(
  status: MemberLifecycleResultStatus,
): MemberLifecycleResult {
  return { status, state: null, deliveries: [], roles: [] };
}

function deliveryOutcome(
  kind: OnboardingDeliveryKind,
  status: MemberLifecycleDeliveryOutcome["status"],
  failureCode: string | null,
): MemberLifecycleDeliveryOutcome {
  return { kind, status, failureCode };
}

function roleOutcome(
  roleId: string,
  operationKind: MemberLifecycleRoleOutcome["operationKind"],
  status: MemberLifecycleRoleOutcome["status"],
  failureCode: string | null,
): MemberLifecycleRoleOutcome {
  return { roleId, operationKind, status, failureCode };
}

function requireSnowflake(value: string, label: string): string {
  const normalized = String(value).trim();
  if (!SNOWFLAKE_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a Discord snowflake.`);
  }
  return normalized;
}

function requireOpaqueId(value: string, label: string): string {
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,24}$/u.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function createOpaqueId(): string {
  return randomBytes(12).toString("base64url");
}

function defaultFailureCode(
  error: unknown,
  operation: MemberLifecycleFailureOperation,
): string {
  if (error && typeof error === "object") {
    const rawCode = (error as { code?: unknown }).code;
    if (
      (typeof rawCode === "string" || typeof rawCode === "number") &&
      /^[A-Za-z0-9_.:-]{1,60}$/u.test(String(rawCode))
    ) {
      return `discord-${String(rawCode)}`;
    }
  }
  return `${operation}-failed`;
}

function safeFailureCode(value: string): string {
  const normalized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return normalized || "external-operation-failed";
}
