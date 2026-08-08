import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  GUILD_CAPABILITIES,
  type CapabilityGrantResult,
  type CapabilityRevokeResult,
  type GuildCapability,
  type RoleCapabilityGrant,
} from "../types.js";

interface CapabilityGrantRow {
  guild_id: string;
  principal_type: string;
  principal_id: string;
  capability: string;
  active: number;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_ROLE_LOOKUP = 250;

/** Tenant-bound persistence for delegated role capabilities. */
export class GuildAccessRepository {
  public constructor(
    private readonly db: Database.Database,
    public readonly guildId: string,
  ) {}

  public grantRoleCapability(
    roleId: string,
    capability: GuildCapability,
    grantedBy: string,
  ): CapabilityGrantResult {
    const principalId = assertDiscordSnowflake(roleId, "role ID");
    const actorId = assertDiscordSnowflake(grantedBy, "granting user ID");
    const normalizedCapability = normalizeCapability(capability);
    let result: CapabilityGrantResult | null = null;
    const grant = this.db.transaction(() => {
      const existing = this.getGrant(principalId, normalizedCapability);
      if (existing?.active) {
        result = { status: "duplicate", grant: existing };
        return;
      }
      const now = utcNow();
      if (existing) {
        this.db
          .prepare(
            `UPDATE delegated_capability_grants
             SET active = 1, granted_by = ?, updated_at = ?
             WHERE guild_id = ? AND principal_type = 'role'
               AND principal_id = ? AND capability = ? AND active = 0`,
          )
          .run(actorId, now, this.guildId, principalId, normalizedCapability);
      } else {
        this.db
          .prepare(
            `INSERT INTO delegated_capability_grants (
               guild_id, principal_type, principal_id, capability, active,
               granted_by, created_at, updated_at
             ) VALUES (?, 'role', ?, ?, 1, ?, ?, ?)`,
          )
          .run(
            this.guildId,
            principalId,
            normalizedCapability,
            actorId,
            now,
            now,
          );
      }
      result = {
        status: "granted",
        grant: this.requireGrant(principalId, normalizedCapability),
      };
    });
    grant.immediate();
    return requireResult<CapabilityGrantResult>(result, "Capability grant");
  }

  public revokeRoleCapability(
    roleId: string,
    capability: GuildCapability,
  ): CapabilityRevokeResult {
    const principalId = assertDiscordSnowflake(roleId, "role ID");
    const normalizedCapability = normalizeCapability(capability);
    let result: CapabilityRevokeResult | null = null;
    const revoke = this.db.transaction(() => {
      const existing = this.getGrant(principalId, normalizedCapability);
      if (!existing?.active) {
        result = { status: "not-found", grant: null };
        return;
      }
      this.db
        .prepare(
          `UPDATE delegated_capability_grants
           SET active = 0, updated_at = ?
           WHERE guild_id = ? AND principal_type = 'role'
             AND principal_id = ? AND capability = ? AND active = 1`,
        )
        .run(utcNow(), this.guildId, principalId, normalizedCapability);
      result = {
        status: "revoked",
        grant: this.requireGrant(principalId, normalizedCapability),
      };
    });
    revoke.immediate();
    return requireResult<CapabilityRevokeResult>(result, "Capability revoke");
  }

  public listCapabilityGrants(
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): RoleCapabilityGrant[] {
    const boundedLimit = normalizeLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    return (
      this.db
        .prepare(
          `SELECT * FROM delegated_capability_grants
           WHERE guild_id = ? AND principal_type = 'role' AND active = 1
           ORDER BY capability, principal_id
           LIMIT ? OFFSET ?`,
        )
        .all(this.guildId, boundedLimit, boundedOffset) as CapabilityGrantRow[]
    ).map(parseRoleGrant);
  }

  public listCapabilityGrantsForCapability(
    capability: GuildCapability,
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
  ): RoleCapabilityGrant[] {
    const normalizedCapability = normalizeCapability(capability);
    const boundedLimit = normalizeLimit(limit);
    const boundedOffset = normalizeOffset(offset);
    return (
      this.db
        .prepare(
          `SELECT * FROM delegated_capability_grants
           WHERE guild_id = ? AND principal_type = 'role' AND active = 1
             AND capability = ?
           ORDER BY principal_id
           LIMIT ? OFFSET ?`,
        )
        .all(
          this.guildId,
          normalizedCapability,
          boundedLimit,
          boundedOffset,
        ) as CapabilityGrantRow[]
    ).map(parseRoleGrant);
  }

  public listCapabilitiesForRoles(
    roleIds: readonly string[],
  ): RoleCapabilityGrant[] {
    if (!Array.isArray(roleIds)) {
      throw new TypeError("Role IDs must be an array");
    }
    const normalized = [
      ...new Set(
        roleIds.map((roleId) => assertDiscordSnowflake(roleId, "role ID")),
      ),
    ];
    if (normalized.length === 0) return [];
    if (normalized.length > MAX_ROLE_LOOKUP) {
      throw new RangeError(
        `Capability evaluation supports at most ${MAX_ROLE_LOOKUP} roles`,
      );
    }
    const placeholders = normalized.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT * FROM delegated_capability_grants
           WHERE guild_id = ? AND principal_type = 'role' AND active = 1
             AND principal_id IN (${placeholders})
           ORDER BY capability, principal_id`,
        )
        .all(this.guildId, ...normalized) as CapabilityGrantRow[]
    ).map(parseRoleGrant);
  }

  public hasRoleCapability(
    roleIds: readonly string[],
    capability: GuildCapability,
  ): boolean {
    const normalizedCapability = normalizeCapability(capability);
    return this.listCapabilitiesForRoles(roleIds).some(
      (grant) => grant.capability === normalizedCapability,
    );
  }

  private getGrant(
    principalId: string,
    capability: GuildCapability,
  ): RoleCapabilityGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM delegated_capability_grants
         WHERE guild_id = ? AND principal_type = 'role'
           AND principal_id = ? AND capability = ?`,
      )
      .get(this.guildId, principalId, capability) as
      CapabilityGrantRow | undefined;
    return row ? parseRoleGrant(row) : null;
  }

  private requireGrant(
    principalId: string,
    capability: GuildCapability,
  ): RoleCapabilityGrant {
    const grant = this.getGrant(principalId, capability);
    if (!grant) throw new Error("Capability grant was not persisted");
    return grant;
  }
}

function parseRoleGrant(row: CapabilityGrantRow): RoleCapabilityGrant {
  if (row.principal_type !== "role") {
    throw new Error("Expected a stored role capability grant");
  }
  return {
    guildId: row.guild_id,
    principalType: "role",
    principalId: row.principal_id,
    roleId: row.principal_id,
    capability: normalizeCapability(row.capability),
    active: Boolean(row.active),
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeCapability(value: unknown): GuildCapability {
  if (!(GUILD_CAPABILITIES as readonly unknown[]).includes(value)) {
    throw new TypeError("Unsupported delegated capability");
  }
  return value as GuildCapability;
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new RangeError(`List limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function normalizeOffset(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("List offset must be a non-negative integer");
  }
  return value;
}

function utcNow(): string {
  return new Date().toISOString();
}

function requireResult<T>(result: T | null, label: string): T {
  if (result === null) throw new Error(`${label} completed without a result`);
  return result;
}
