import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  detectDatabaseSchema,
  initializeV3Schema,
  initializeV4Schema,
  initializeV5Schema,
  initializeV6Schema,
  initializeV7Schema,
  initializeV8Schema,
  initializeV9Schema,
  validateV2Schema,
  validateV9Schema,
  validateV10Schema,
  V10_EXPLICIT_INDEX_NAMES,
  V10_TABLE_NAMES,
} from "../src/storage/schema.js";
import { createV2FixtureDatabase } from "./helpers/v2-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("schema v10", () => {
  it("creates only the exact active tables and required index", () => {
    const dbFile = freshDatabase();
    const validation = validateDatabaseFile(dbFile, { expect: 10 });
    expect(validation).toEqual({
      schema: "current-v10",
      schemaVersion: 10,
      integrity: "ok",
      foreignKeyViolations: 0,
    });

    const db = new Database(dbFile, { readonly: true });
    try {
      const objects = db
        .prepare(
          `SELECT type, name FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
        .all() as Array<{ type: string; name: string }>;
      expect(
        objects.filter((row) => row.type === "table").map(rowName),
      ).toEqual([...V10_TABLE_NAMES].sort());
      expect(
        objects.filter((row) => row.type === "index").map(rowName),
      ).toEqual([...V10_EXPLICIT_INDEX_NAMES].sort());
      expect(objects.some((row) => row.type === "view")).toBe(false);
      expect(objects.some((row) => row.type === "trigger")).toBe(false);
      expect(validateV10Schema(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects user-principal capability grants in a fresh v10 schema", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO delegated_capability_grants (
               guild_id, principal_type, principal_id, capability, active,
               granted_by, created_at, updated_at
             ) VALUES (?, 'user', ?, 'panels.manage', 1, ?, ?, ?)`,
          )
          .run(
            "111111111111111111",
            "222222222222222222",
            "333333333333333333",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("requires the normalized welcome and farewell templates for onboarding", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO onboarding_configurations (
           guild_id, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /exactly two message templates/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects impossible role-menu parent/item outcomes", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    try {
      db.prepare(
        `INSERT INTO role_menus (
           guild_id, menu_id, slug, title, description, menu_state,
           sort_order, selection_mode, min_selections, max_selections,
           definition_version, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'schemaMenu01', 'schema-menu', 'Schema menu',
           'Validate parent and item outcomes.', 'disabled', 0, 'toggle', 0, 1,
           1, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO role_menu_operations (
           guild_id, operation_id, interaction_id, menu_id, member_id,
           definition_version, selection_key, operation_state, failure_code,
           created_at, updated_at, completed_at
         ) VALUES (?, 'schemaOp001', ?, 'schemaMenu01', ?, 1, 'selection',
           'completed', NULL, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "333333333333333333",
        "444444444444444444",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        `INSERT INTO role_menu_operation_items (
           guild_id, operation_id, role_id, role_action, item_state,
           failure_code
         ) VALUES (?, 'schemaOp001', ?, 'add', 'planned', NULL)`,
      ).run("111111111111111111", "555555555555555555");

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent parent\/item outcomes/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects a retryable onboarding delivery with a delivered-message checkpoint", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO onboarding_delivery_records (
           guild_id, delivery_id, member_id, join_instance, delivery_kind,
           delivery_state, channel_id, message_id, attempt_count,
           failure_code, delivered_at, created_at, updated_at
         ) VALUES (?, 'unsafeDelivery01', ?, 'join-1', 'welcome-public',
           'failed', ?, ?, 1, 'discord-failed', ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "333333333333333333",
        "444444444444444444",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent delivery outcomes/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects successful onboarding role work with failure metadata", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO onboarding_role_operations (
           guild_id, operation_id, member_id, role_id, operation_kind,
           idempotency_key, operation_state, failure_code, attempt_count,
           created_at, updated_at, completed_at
         ) VALUES (?, 'unsafeRoleOp01', ?, ?, 'verified-add',
           'rules:1:verified', 'completed', 'unexpected-failure', 1, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "333333333333333333",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent completion metadata/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects recovery resolution linked to a mismatched successful role operation", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    const guild = storage.forGuild("111111111111111111");
    guild.reserveOnboardingRoleOperation({
      operationId: "originalRole01",
      memberId: "222222222222222222",
      roleId: "333333333333333333",
      kind: "verified-add",
      idempotencyKey: "rules:1:verified",
    });
    const recovery = guild.reserveOnboardingRoleOperation({
      operationId: "recoveryRole01",
      memberId: "222222222222222222",
      roleId: "333333333333333333",
      kind: "verified-add",
      idempotencyKey:
        "recover:444444444444444444:verified-add:333333333333333333",
    });
    guild.completeOnboardingRoleOperation(recovery.operation.operationId, {
      state: "completed",
    });
    guild.resolveOnboardingRoleOperations(recovery.operation.operationId);
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `UPDATE onboarding_role_operations SET role_id = ?
         WHERE guild_id = ? AND operation_id = ?`,
      ).run(
        "555555555555555555",
        "111111111111111111",
        recovery.operation.operationId,
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent recovery resolution metadata/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects a verification checkpoint without a verified role", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO onboarding_configurations (
           guild_id, verification_roles_verified_at, created_by, updated_by,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "2026-01-01T00:00:00.000Z",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");
      const insertTemplate = db.prepare(
        `INSERT INTO onboarding_message_templates (
           guild_id, template_kind, title, body, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const [kind, title, body] of [
        ["welcome", "Welcome", "Welcome {user}."],
        ["farewell", "Member left", "{user} left."],
      ] as const) {
        insertTemplate.run(
          "111111111111111111",
          kind,
          title,
          body,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
      }

      expect(validateV10Schema(db).join(" ")).toMatch(
        /verification checkpoint without a role/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects text that only fits SQLite code-point length limits", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO onboarding_configurations (
           guild_id, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      const insertTemplate = db.prepare(
        `INSERT INTO onboarding_message_templates (
           guild_id, template_kind, title, body, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertTemplate.run(
        "111111111111111111",
        "welcome",
        "Welcome",
        "😀".repeat(4_096),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      insertTemplate.run(
        "111111111111111111",
        "farewell",
        "Member left",
        "{user} left.",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /message_templates contains invalid normalized text/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects disabled autoroles that retain a verified binding", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO onboarding_autoroles (
           guild_id, audience, role_id, sort_order, enabled,
           bindings_verified_at, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'human', ?, 0, 0, ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "333333333333333333",
        "2026-01-01T00:00:00.000Z",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent verified binding/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects overlap between verification and automatic roles", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    const guild = storage.forGuild("111111111111111111");
    const rules = guild.createOnboardingRulesVersion({
      title: "Server rules",
      body: "Keep role semantics distinct.",
      actorId: "222222222222222222",
    });
    guild.upsertOnboardingConfiguration({
      enabled: true,
      welcomeChannelId: null,
      welcomePublicEnabled: false,
      welcomeDmEnabled: false,
      farewellChannelId: null,
      farewellPublicEnabled: false,
      lifecycleLogChannelId: null,
      rulesChannelId: null,
      verificationEnabled: true,
      currentRulesVersion: rules.rulesVersion,
      verifiedRoleId: "333333333333333333",
      unverifiedRoleId: null,
      humanAutorolesEnabled: false,
      botAutorolesEnabled: false,
      accountAgeAlertHours: null,
      welcomeTitle: "Welcome",
      welcomeBody: "Welcome {user}.",
      farewellTitle: "Member left",
      farewellBody: "{user} left.",
      welcomeChannelVerifiedAt: null,
      farewellChannelVerifiedAt: null,
      lifecycleLogChannelVerifiedAt: null,
      rulesChannelVerifiedAt: null,
      verificationRolesVerifiedAt: "2026-01-01T00:00:00.000Z",
      actorId: "222222222222222222",
    });
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO onboarding_autoroles (
           guild_id, audience, role_id, sort_order, enabled,
           bindings_verified_at, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'human', ?, 0, 0, NULL, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "333333333333333333",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /verification roles overlap automatic roles/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects a roles panel whose Phase 4 menu/post binding is missing", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, 'missingPost01', 'roles', ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "333333333333333333",
        "444444444444444444",
        JSON.stringify({
          bindingsVerifiedAt: null,
          definitionVersion: 1,
          menuId: "missingMenu01",
          postId: "missingPost01",
        }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent Phase 4 references/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects a verification panel with malformed Phase 4 metadata", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, 'verifyPanel01', 'verification', ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "333333333333333333",
        "444444444444444444",
        JSON.stringify({
          bindingsVerifiedAt: "not-a-timestamp",
          rulesVersion: 1,
          unsupported: true,
        }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /inconsistent Phase 4 references/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects an enabled role menu with unsatisfiable option bounds", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO role_menus (
           guild_id, menu_id, slug, title, description, menu_state,
           sort_order, selection_mode, min_selections, max_selections,
           definition_version, bindings_verified_at,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'emptyMenu001', 'empty-menu', 'Empty menu',
           'This enabled menu has no selectable options.', 'enabled', 0,
           'limited', 1, 25, 1, ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "2026-01-01T00:00:00.000Z",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /impossible option bounds/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects impossible parent versions and per-menu post overflow", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO role_menus (
           guild_id, menu_id, slug, title, description, menu_state,
           sort_order, selection_mode, min_selections, max_selections,
           definition_version, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'parentMenu01', 'parent-menu', 'Parent menu',
           'Validate child versions and post bounds.', 'disabled', 0, 'toggle',
           0, 1, 1, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      const insertPost = db.prepare(
        `INSERT INTO role_menu_posts (
           guild_id, post_id, menu_id, channel_id, message_id,
           definition_version, bindings_verified_at, post_state,
           created_at, updated_at
         ) VALUES (?, ?, 'parentMenu01', ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertPost.run(
        "111111111111111111",
        "futurePost01",
        "333333333333333333",
        "444444444444444444",
        999,
        "2026-01-01T00:00:00.000Z",
        "active",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      for (let index = 0; index < 100; index += 1) {
        insertPost.run(
          "111111111111111111",
          `post${String(index).padStart(8, "0")}`,
          String(500_000_000_000_000_000n + BigInt(index)),
          String(600_000_000_000_000_000n + BigInt(index)),
          1,
          null,
          "stale",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        );
      }
      db.prepare(
        `INSERT INTO role_menu_operations (
           guild_id, operation_id, interaction_id, menu_id, member_id,
           definition_version, selection_key, operation_state,
           created_at, updated_at, completed_at
         ) VALUES (?, 'futureOp001', ?, 'parentMenu01', ?, 999,
           'no-change', 'no-change', ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "700000000000000000",
        "800000000000000000",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      const issues = validateV10Schema(db).join(" ");
      expect(issues).toMatch(/inconsistent parent menu binding/u);
      expect(issues).toMatch(/future menu definition/u);
      expect(issues).toMatch(/per-menu post limit/u);
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("flags unsafe anti-spam case metadata during v10 validation", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    const moderationCase = storage
      .forGuild("111111111111111111")
      .createModerationCase({
        targetUserId: "222222222222222222",
        actorId: "333333333333333333",
        actionType: "automod-warning",
        source: "anti-spam",
        publicReason: "Safe automated warning metadata.",
        status: "active",
        discordActionMetadata: {
          ruleType: "burst",
          messageId: "444444444444444444",
          channelId: "555555555555555555",
          observedCount: 4,
        },
      });
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `UPDATE moderation_cases SET discord_action_metadata_json = ?
         WHERE guild_id = ? AND case_id = ?`,
      ).run(
        JSON.stringify({ content: "raw private message content" }),
        "111111111111111111",
        moderationCase.caseId,
      );
      expect(validateV10Schema(db).join(" ")).toMatch(
        /unsafe anti-spam metadata/,
      );
    } finally {
      db.close();
    }
  });

  it.each([
    ["table", "CREATE TABLE unexpected_table (value TEXT)"],
    ["view", "CREATE VIEW unexpected_view AS SELECT guild_id FROM guilds"],
    [
      "trigger",
      "CREATE TRIGGER unexpected_trigger AFTER INSERT ON guilds BEGIN SELECT 1; END",
    ],
    ["index", "CREATE INDEX unexpected_index ON metrics (updated_at)"],
  ])("rejects every extra explicit %s", (_kind, sql) => {
    const dbFile = freshDatabase();
    const db = new Database(dbFile);
    try {
      db.exec(sql);
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects data-level settings inconsistencies", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        "UPDATE guild_settings SET settings_json = '{malformed' WHERE guild_id = ?",
      ).run("111111111111111111");
      expect(detectDatabaseSchema(db)).toBe("unknown");
      expect(validateV10Schema(db).join(" ")).toMatch(/settings are invalid/);
    } finally {
      db.close();
    }
  });

  it("rejects malformed Phase 3 timestamps despite SQLite dynamic typing", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.forGuild("111111111111111111").upsertModerationConfiguration({
      actorId: "222222222222222222",
    });
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        "UPDATE moderation_configurations SET updated_at = 'not-a-timestamp' WHERE guild_id = ?",
      ).run("111111111111111111");
      expect(detectDatabaseSchema(db)).toBe("unknown");
      expect(validateV10Schema(db).join(" ")).toMatch(
        /moderation_configurations contains invalid timestamps/,
      );
    } finally {
      db.close();
    }
  });

  it("rejects fractional Phase 4 integers despite SQLite dynamic typing", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO role_menus (
           guild_id, menu_id, slug, title, description, menu_state,
           sort_order, selection_mode, min_selections, max_selections,
           definition_version, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 'integercheck', 'integer-check', 'Integer check',
           'Reject fractional selection limits.', 'disabled', 0, 'limited',
           0.5, 1, 1, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /role_menus contains non-integer data in an integer column/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects gapped guild-local role-menu ordering", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      const insert = db.prepare(
        `INSERT INTO role_menus (
           guild_id, menu_id, slug, title, description, menu_state,
           sort_order, selection_mode, min_selections, max_selections,
           definition_version, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'Validate contiguous menu ordering.',
           'disabled', ?, 'toggle', 0, 1, 1, ?, ?, ?, ?)`,
      );
      insert.run(
        "111111111111111111",
        "orderedMenu01",
        "ordered-one",
        "Ordered one",
        0,
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      insert.run(
        "111111111111111111",
        "orderedMenu02",
        "ordered-two",
        "Ordered two",
        2,
        "222222222222222222",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /role_menus contains non-contiguous guild ordering/u,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects incoherent internal delivery reservations", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO mudae_watch_deliveries (
           guild_id, message_id, delivery_state, reservation_id,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, 'reserved', NULL, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "2026-01-01T00:00:00.000Z",
        "not-a-timestamp",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");

      expect(validateV10Schema(db).join(" ")).toMatch(
        /invalid timestamps|invalid delivery state/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects internal delivery history above its per-guild cap", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value <= 10000
         )
         INSERT INTO mudae_watch_deliveries (
           guild_id, message_id, delivery_state, reservation_id,
           completed_at, created_at, updated_at
         )
         SELECT ?, printf('%018d', 100000000000000000 + value),
                'delivered', NULL, ?, ?, ?
         FROM sequence`,
      ).run(
        "111111111111111111",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /exceeds the per-guild record limit/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("preserves CHECK literal case while comparing exact table SQL", () => {
    const dbFile = freshDatabase();
    const db = new Database(dbFile);
    try {
      const table = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'ticket_events'`,
        )
        .get() as { sql: string };
      const index = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_ticket_events_ticket'`,
        )
        .get() as { sql: string };
      db.exec("DROP TABLE ticket_events");
      db.exec(table.sql.replace("'creation_reserved'", "'CREATION_RESERVED'"));
      db.exec(index.sql);
      expect(validateV10Schema(db).join(" ")).toMatch(
        /ticket_events SQL does not match/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("rejects operational JSON that exceeds repository UTF-8 byte limits", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();
    const db = new Database(dbFile);
    try {
      db.pragma("ignore_check_constraints = ON");
      db.prepare(
        `INSERT INTO posted_panels (
           guild_id, panel_id, preset, channel_id, message_id,
           configuration_json, created_at, updated_at
         ) VALUES (?, ?, 'resources', ?, ?, ?, ?, ?)`,
      ).run(
        "111111111111111111",
        "bytepanel1",
        "222222222222222222",
        "333333333333333333",
        JSON.stringify({ body: "😀".repeat(5_000) }),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.pragma("ignore_check_constraints = OFF");
      expect(validateV10Schema(db).join(" ")).toMatch(
        /invalid or oversized JSON/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it.each(["subject", "description", "close_reason", "failure_reason"])(
    "rejects a SQLite BLOB in the ticket %s column",
    (column) => {
      const dbFile = freshDatabase();
      const storage = new BotStorage({ dbFile });
      storage.initStorage();
      storage.ensureGuild("111111111111111111");
      const guild = storage.forGuild("111111111111111111");
      guild.upsertTicketConfiguration({
        categoryId: "222222222222222222",
        logChannelId: "333333333333333333",
        supportRoleId: "444444444444444444",
      });
      const reserved = guild.reserveTicketCreation({
        openerId: "555555555555555555",
        subject: "BLOB validation",
        description: "The schema checker must reject binary ticket text.",
      });
      storage.close();

      const db = new Database(dbFile);
      try {
        db.pragma("ignore_check_constraints = ON");
        db.prepare(
          `UPDATE tickets SET ${column} = ? WHERE guild_id = ? AND ticket_id = ?`,
        ).run(
          Buffer.from("binary ticket text"),
          "111111111111111111",
          reserved.ticket.ticketId,
        );
        db.pragma("ignore_check_constraints = OFF");

        expect(validateV10Schema(db).join(" ")).toMatch(/non-text data/);
        expect(detectDatabaseSchema(db)).toBe("unknown");
      } finally {
        db.close();
      }
    },
  );

  it("rejects an enabled application form without a configured field", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();

    const db = new Database(dbFile);
    try {
      db.prepare(
        `INSERT INTO application_forms (
           guild_id, form_id, slug, display_name, description,
           reviewer_role_id, review_channel_id, enabled, sort_order,
           definition_version, bindings_verified_at, created_at, updated_at
         ) VALUES (?, 'staffform', 'staff', 'Staff', 'Apply for staff.',
           ?, ?, 1, 0, 1, NULL, ?, ?)`,
      ).run(
        "111111111111111111",
        "222222222222222222",
        "333333333333333333",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      expect(validateV10Schema(db).join(" ")).toMatch(
        /enabled application form does not have 1-5 fields/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
  });

  it("enforces active-opener, channel, lifecycle, and composite tenant constraints", () => {
    const dbFile = freshDatabase();
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.ensureGuild("222222222222222222");
    const guild = storage.forGuild("111111111111111111");
    const reserved = guild.reserveTicketCreation({
      openerId: "333333333333333333",
      subject: "Constraint proof",
      description: "Exercise raw SQLite invariants.",
    });
    guild.activateTicketCreation(reserved.ticket.ticketId, {
      channelId: "444444444444444444",
    });
    storage.close();

    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    try {
      const activeIndex = db
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_tickets_guild_opener_department_active'`,
        )
        .get() as { sql: string };
      expect(activeIndex.sql).toMatch(
        /UNIQUE INDEX[\s\S]*guild_id, department_id, opener_id[\s\S]*WHERE state IN \('creating', 'open', 'closing'\)/i,
      );
      const eventForeignKeys = db
        .prepare("PRAGMA foreign_key_list(ticket_events)")
        .all() as Array<{ table: string; from: string; to: string }>;
      expect(
        eventForeignKeys
          .filter((row) => row.table === "tickets")
          .map((row) => `${row.from}:${row.to}`)
          .sort(),
      ).toEqual(["guild_id:guild_id", "ticket_id:ticket_id"]);

      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (
               guild_id, ticket_id, ticket_number, department_id, opener_id,
               subject, description, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`,
          )
          .run(
            "111111111111111111",
            "duplicate1",
            2,
            reserved.ticket.departmentId,
            "333333333333333333",
            "Duplicate",
            "Must fail",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (
               guild_id, ticket_id, ticket_number, department_id, opener_id,
               channel_id, subject, description, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(
            "111111111111111111",
            "duplicate2",
            2,
            reserved.ticket.departmentId,
            "555555555555555555",
            "444444444444444444",
            "Duplicate channel",
            "Must fail",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        db
          .prepare(
            "UPDATE tickets SET state = 'closed' WHERE guild_id = ? AND ticket_id = ?",
          )
          .run("111111111111111111", reserved.ticket.ticketId),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            `INSERT INTO ticket_events (
               guild_id, ticket_id, event_id, event_number, event_type,
               details_json, created_at
             ) VALUES (?, ?, ?, 2, 'recovery_noted', '{}', ?)`,
          )
          .run(
            "222222222222222222",
            reserved.ticket.ticketId,
            "crossevent",
            "2026-01-01T00:00:00.000Z",
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it("normal startup read-only classifies and refuses schema v2 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v2.db");
    createV2FixtureDatabase(dbFile).close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(/explicit migration/);
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("rejects a schema-v2 migration marker with an invalid timestamp", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "invalid-v2-marker.db");
    const db = createV2FixtureDatabase(dbFile);
    try {
      db.prepare(
        "UPDATE schema_migrations SET applied_at = 'not-a-timestamp' WHERE version = 2",
      ).run();
      expect(validateV2Schema(db).join(" ")).toMatch(
        /schema_migrations must end at version 2/,
      );
      expect(detectDatabaseSchema(db)).toBe("unknown");
    } finally {
      db.close();
    }
    expect(() => validateDatabaseFile(dbFile, { expect: 2 })).toThrow(
      /expected exact schema v2/,
    );
  });

  it("normal startup read-only classifies and refuses schema v3 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v3.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV3Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v3 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 3 }).schema).toBe(
      "legacy-v3",
    );
  });

  it("normal startup read-only classifies and refuses schema v4 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v4.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV4Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v4 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 4 }).schema).toBe(
      "legacy-v4",
    );
  });

  it("normal startup read-only classifies and refuses schema v5 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v5.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV5Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v5 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 5 }).schema).toBe(
      "legacy-v5",
    );
  });

  it("normal startup read-only classifies and refuses schema v6 unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v6.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV6Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v6 requires an explicit migration/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 6 }).schema).toBe(
      "legacy-v6",
    );
  });

  it("refuses schema v7 until the explicit v10 migration runs", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v7.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV7Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v7 requires an explicit migration to v10/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 7 }).schema).toBe(
      "legacy-v7",
    );
  });

  it("refuses schema v8 until the explicit v10 migration runs", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v8.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV8Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v8 requires an explicit migration to v10/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 8 }).schema).toBe(
      "legacy-v8",
    );
  });

  it("classifies and refuses exact schema v9 unchanged until migration", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "v9.db");
    const db = new Database(dbFile);
    db.pragma("foreign_keys = ON");
    initializeV9Schema(db, "2026-01-01T00:00:00.000Z");
    expect(validateV9Schema(db)).toEqual([]);
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(
      /schema v9 requires an explicit migration to v10/i,
    );
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
    expect(validateDatabaseFile(dbFile, { expect: 9 })).toMatchObject({
      schema: "legacy-v9",
      schemaVersion: 9,
      foreignKeyViolations: 0,
    });
  });

  it("normal startup refuses an unknown database unchanged", () => {
    const root = makeRoot();
    const dbFile = path.join(root, "unknown.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE partial (value TEXT)");
    db.close();
    const before = fs.readFileSync(dbFile);

    const storage = new BotStorage({ dbFile });
    expect(() => storage.initStorage()).toThrow(/unknown or incomplete/);
    storage.close();
    expect(fs.readFileSync(dbFile)).toEqual(before);
  });
});

function rowName(row: { name: string }): string {
  return row.name;
}

function freshDatabase(): string {
  const root = makeRoot();
  const dbFile = path.join(root, "fresh.db");
  const storage = new BotStorage({ dbFile });
  storage.initStorage();
  storage.close();
  return dbFile;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-schema-"));
  roots.push(root);
  return root;
}
