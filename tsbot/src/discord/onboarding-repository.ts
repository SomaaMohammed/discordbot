import type {
  MemberOnboardingState,
  MemberOnboardingStateInput,
  MemberRuleAcceptance,
  MemberRuleAcceptanceInput,
  MemberRuleAcceptanceResult,
  OnboardingAuditEvent,
  OnboardingAuditEventInput,
  OnboardingAutorole,
  OnboardingAutoroleAudience,
  OnboardingAutoroleInput,
  OnboardingConfiguration,
  OnboardingConfigurationInput,
  OnboardingDeliveryCompletionInput,
  OnboardingDeliveryRecord,
  OnboardingDeliveryReservationInput,
  OnboardingDeliveryReservationResult,
  OnboardingRoleOperation,
  OnboardingRoleOperationCompletionInput,
  OnboardingRoleOperationReservationInput,
  OnboardingRoleOperationReservationResult,
  OnboardingRulesActivationInput,
  OnboardingRulesActivationResult,
  OnboardingRulesVersion,
  OnboardingRulesVersionInput,
} from "../types.js";

export interface StoredOnboardingPanel {
  readonly guildId: string;
  readonly panelId: string;
  readonly preset: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly configuration: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The persisted onboarding definition captured before a member lifecycle run
 * starts Discord effects. Autoroles are included for join/screening work so a
 * replacement cannot leave an old role plan executing against new settings.
 */
export interface OnboardingLifecycleDefinitionSnapshot {
  readonly configuration: OnboardingConfiguration;
  readonly autoroles?: {
    readonly audience: OnboardingAutoroleAudience;
    readonly roles: readonly OnboardingAutorole[];
  };
}

export interface OnboardingRepository {
  getOnboardingConfiguration(): OnboardingConfiguration | null;
  isOnboardingLifecycleDefinitionCurrent(
    snapshot: OnboardingLifecycleDefinitionSnapshot,
  ): boolean;
  upsertOnboardingConfiguration(
    input: OnboardingConfigurationInput,
  ): OnboardingConfiguration;
  disableOnboardingConfiguration(
    actorId: string,
  ): OnboardingConfiguration | null;

  createOnboardingRulesVersion(
    input: OnboardingRulesVersionInput,
  ): OnboardingRulesVersion;
  createAndActivateOnboardingRulesVersion(
    input: OnboardingRulesActivationInput,
  ): OnboardingRulesActivationResult;
  getOnboardingRulesVersion(
    rulesVersion: number,
  ): OnboardingRulesVersion | null;
  getCurrentOnboardingRulesVersion(): OnboardingRulesVersion | null;
  listOnboardingRulesVersions(
    limit?: number,
    offset?: number,
  ): OnboardingRulesVersion[];

  replaceOnboardingAutoroles(
    audience: OnboardingAutoroleAudience,
    roles: readonly OnboardingAutoroleInput[],
    actorId: string,
  ): OnboardingAutorole[];
  listOnboardingAutoroles(
    audience?: OnboardingAutoroleAudience,
    limit?: number,
    offset?: number,
  ): OnboardingAutorole[];

  getMemberOnboardingState(memberId: string): MemberOnboardingState | null;
  upsertMemberOnboardingState(
    input: MemberOnboardingStateInput,
  ): MemberOnboardingState;
  getMemberRuleAcceptance(
    memberId: string,
    rulesVersion: number,
  ): MemberRuleAcceptance | null;
  listMemberRuleAcceptances(
    memberId: string,
    limit?: number,
    offset?: number,
  ): MemberRuleAcceptance[];
  recordMemberRuleAcceptance(
    input: MemberRuleAcceptanceInput,
  ): MemberRuleAcceptanceResult;

  reserveOnboardingDelivery(
    input: OnboardingDeliveryReservationInput,
  ): OnboardingDeliveryReservationResult;
  completeOnboardingDelivery(
    deliveryId: string,
    input: OnboardingDeliveryCompletionInput,
  ): OnboardingDeliveryRecord;
  listOnboardingDeliveries(options?: {
    memberId?: string;
    states?: readonly string[];
    kinds?: readonly string[];
    limit?: number;
    offset?: number;
  }): OnboardingDeliveryRecord[];

  reserveOnboardingRoleOperation(
    input: OnboardingRoleOperationReservationInput,
  ): OnboardingRoleOperationReservationResult;
  completeOnboardingRoleOperation(
    operationId: string,
    input: OnboardingRoleOperationCompletionInput,
  ): OnboardingRoleOperation;
  resolveOnboardingRoleOperations(
    resolvedByOperationId: string,
  ): OnboardingRoleOperation[];
  listOnboardingRoleOperations(options?: {
    memberId?: string;
    states?: readonly string[];
    unresolvedOnly?: boolean;
    limit?: number;
    offset?: number;
  }): OnboardingRoleOperation[];

  appendOnboardingAudit(input: OnboardingAuditEventInput): OnboardingAuditEvent;
  listOnboardingAuditEvents(options?: {
    memberId?: string;
    limit?: number;
    offset?: number;
  }): OnboardingAuditEvent[];

  findPostedPanelByToken(panelId: string): StoredOnboardingPanel | null;
  findPostedPanelByPresetAndChannel(
    preset: "verification",
    channelId: string,
  ): StoredOnboardingPanel | null;
  upsertPostedPanel(input: {
    panelId?: string;
    preset: "verification";
    channelId: string;
    messageId: string;
    configuration: unknown;
  }): StoredOnboardingPanel;
  countPostedPanels(preset?: "verification"): number;
  listPostedPanels(
    preset?: "verification",
    limit?: number,
    offset?: number,
  ): StoredOnboardingPanel[];
  recordCommandMetric(commandName: string, success?: boolean): unknown;
}

export function asOnboardingRepository(value: unknown): OnboardingRepository {
  return value as OnboardingRepository;
}
