import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "../src/storage/database.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupDatabase } from "../src/storage/backup.js";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  initializeV3Schema,
  initializeV4Schema,
  initializeV9Schema,
} from "../src/storage/schema.js";
import {
  createV2FixtureDatabase,
  insertV2Guild,
} from "./helpers/v2-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("validated SQLite backup", () => {
  it("copies and validates schema v11 including Phase 4 operational data", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "backup.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.forGuild("111111111111111111").recordCommandMetric("utility.ping");
    const guild = storage.forGuild("111111111111111111");
    guild.upsertTicketConfiguration({
      categoryId: "222222222222222222",
      logChannelId: "333333333333333333",
      supportRoleId: "444444444444444444",
    });
    const reservation = guild.reserveTicketCreation({
      openerId: "555555555555555555",
      subject: "Backup coverage",
      description: "Preserve this ticket and its audit event.",
    });
    guild.grantRoleCapability(
      "666666666666666666",
      "suggestions.review",
      "777777777777777777",
    );
    guild.upsertSuggestionConfiguration({
      enabled: true,
      suggestionChannelId: "888888888888888888",
      reviewerRoleId: "999999999999999999",
      reviewChannelId: "101010101010101010",
    });
    const suggestion = guild.reserveSuggestion({
      authorId: "121212121212121212",
      title: "Backup suggestion",
      details: "Preserve this suggestion, vote, delivery, and audit history.",
    });
    if (suggestion.status !== "created") throw new Error("Expected suggestion");
    guild.bindSuggestionDelivery(suggestion.suggestion.suggestionId, {
      channelId: "888888888888888888",
      messageId: "131313131313131313",
    });
    guild.toggleSuggestionVote(
      suggestion.suggestion.suggestionId,
      "141414141414141414",
      1,
    );
    guild.appendSuggestionEvent(suggestion.suggestion.suggestionId, {
      type: "recovery_noted",
      details: { source: "backup-test" },
    });

    const form = guild.createApplicationForm({
      slug: "backup-staff",
      displayName: "Backup Staff",
      description: "Preserve this private application workflow.",
      reviewerRoleId: "151515151515151515",
      reviewChannelId: "161616161616161616",
    });
    const field = guild.upsertApplicationFormField(form.formId, {
      label: "Why should we select you?",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 500,
    });
    guild.setApplicationFormEnabled(form.formId, true);
    const application = guild.reserveApplication({
      formId: form.formId,
      applicantId: "171717171717171717",
      responses: [
        {
          fieldId: field.fieldId,
          fieldLabel: field.label,
          fieldType: field.fieldType,
          responseText: "A private answer preserved by the backup.",
          sortOrder: field.sortOrder,
        },
      ],
    });
    if (application.status !== "created")
      throw new Error("Expected application");
    guild.bindApplicationDelivery(application.application.applicationId, {
      reviewChannelId: "161616161616161616",
      reviewMessageId: "181818181818181818",
    });
    guild.appendApplicationEvent(application.application.applicationId, {
      type: "recovery_noted",
      details: { source: "backup-test" },
    });
    guild.reserveMudaeWatchDelivery("202020202020202020");
    const votingPanel = guild.createVotingPanel({
      voteId: "vote_backup",
      channelId: "212121212121212121",
      messageId: "222222222222222222",
      creatorId: "232323232323232323",
      question: "Preserve this voting panel.",
      pollType: "yes-no",
      multiSelect: false,
      options: [
        { optionId: "option_yes", label: "Yes" },
        { optionId: "option_no", label: "No" },
      ],
      mentionEveryoneOnCreation: false,
      mentionEveryoneOnCompletion: false,
    });
    guild.selectVotingPanelOption(
      votingPanel.voteId,
      "242424242424242424",
      "option_yes",
    );

    const phase4Now = "2026-01-01T00:00:00.000Z";
    const rules = guild.createOnboardingRulesVersion({
      title: "Backup rules",
      body: "Acknowledge these server rules.",
      actorId: "212121212121212121",
    });
    guild.upsertOnboardingConfiguration({
      enabled: false,
      welcomeChannelId: "222222222222222223",
      welcomePublicEnabled: false,
      welcomeDmEnabled: true,
      farewellChannelId: "222222222222222224",
      farewellPublicEnabled: false,
      lifecycleLogChannelId: "222222222222222225",
      rulesChannelId: "222222222222222226",
      verificationEnabled: false,
      currentRulesVersion: rules.rulesVersion,
      verifiedRoleId: "222222222222222227",
      unverifiedRoleId: "222222222222222228",
      humanAutorolesEnabled: false,
      botAutorolesEnabled: false,
      accountAgeAlertHours: 24,
      welcomeTitle: "Welcome",
      welcomeBody: "Welcome to the backup fixture.",
      farewellTitle: "Farewell",
      farewellBody: "A member left the backup fixture.",
      welcomeChannelVerifiedAt: null,
      farewellChannelVerifiedAt: null,
      lifecycleLogChannelVerifiedAt: null,
      rulesChannelVerifiedAt: null,
      verificationRolesVerifiedAt: null,
      actorId: "212121212121212121",
    });
    guild.replaceOnboardingAutoroles(
      "human",
      [{ roleId: "222222222222222229", enabled: false }],
      "212121212121212121",
    );
    guild.upsertMemberOnboardingState({
      memberId: "232323232323232323",
      memberKind: "human",
      screeningState: "complete",
      lifecycleState: "active",
      joinedAt: phase4Now,
      accountCreatedAt: "2025-01-01T00:00:00.000Z",
      screeningCompletedAt: phase4Now,
      departedAt: null,
      lastProcessedAt: phase4Now,
    });
    guild.recordMemberRuleAcceptance({
      memberId: "232323232323232323",
      rulesVersion: rules.rulesVersion,
      acceptedAt: phase4Now,
    });
    const onboardingDelivery = guild.reserveOnboardingDelivery({
      memberId: "232323232323232323",
      joinInstance: "backup-join-1",
      kind: "welcome-dm",
      claimId: "backupclm1",
      claimExpiresAt: "2026-01-01T00:05:00.000Z",
    });
    guild.completeOnboardingDelivery(onboardingDelivery.delivery.deliveryId, {
      claimId: "backupclm1",
      state: "skipped",
    });
    const onboardingRoleOperation = guild.reserveOnboardingRoleOperation({
      memberId: "232323232323232323",
      roleId: "222222222222222227",
      kind: "verified-add",
      idempotencyKey: "backup.rules.1",
    });
    guild.completeOnboardingRoleOperation(
      onboardingRoleOperation.operation.operationId,
      { state: "no-change" },
    );
    guild.appendOnboardingAudit({
      eventType: "backup-fixture",
      memberId: "232323232323232323",
      actorId: "212121212121212121",
      rulesVersion: rules.rulesVersion,
      outcome: "preserved",
      details: { source: "storage-backup-test" },
    });

    const roleMenu = guild.createRoleMenu({
      slug: "backup-colors",
      title: "Backup colors",
      description: "Pick a color role.",
      mode: "toggle",
      minSelections: 0,
      maxSelections: 1,
      actorId: "212121212121212121",
    });
    const roleMenuOption = guild.createRoleMenuOption(roleMenu.menuId, {
      roleId: "242424242424242424",
      label: "Gold",
      actorId: "212121212121212121",
    });
    const enabledRoleMenu = guild.setRoleMenuState(
      roleMenu.menuId,
      "enabled",
      "212121212121212121",
      phase4Now,
    );
    if (!enabledRoleMenu) throw new Error("Expected role menu");
    guild.createRoleMenuPost({
      menuId: roleMenu.menuId,
      channelId: "252525252525252525",
      messageId: "262626262626262626",
      definitionVersion: enabledRoleMenu.definitionVersion,
      bindingsVerifiedAt: phase4Now,
      state: "active",
    });
    const roleMenuOperation = guild.reserveRoleMenuOperation({
      interactionId: "272727272727272727",
      menuId: roleMenu.menuId,
      memberId: "232323232323232323",
      definitionVersion: enabledRoleMenu.definitionVersion,
      selectionKey: roleMenuOption.optionId,
      plannedAdds: [roleMenuOption.roleId],
    });
    guild.completeRoleMenuOperation(roleMenuOperation.operation.operationId, {
      state: "completed",
      addedRoleIds: [roleMenuOption.roleId],
      removedRoleIds: [],
      failedRoleIds: [],
      skippedRoleIds: [],
    });
    storage.close();

    const result = await backupDatabase({
      dbFile: source,
      outputFile: output,
      expect: 11,
    });
    expect(result).toMatchObject({
      schema: "current-v11",
      schemaVersion: 11,
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(validateDatabaseFile(source, { expect: 11 }).schema).toBe(
      "current-v11",
    );
    expect(validateDatabaseFile(output, { expect: 11 }).schema).toBe(
      "current-v11",
    );

    const original = new Database(source, { readonly: true });
    const copied = new Database(output, { readonly: true });
    try {
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM guilds").get(),
      ).toEqual({ count: 1 });
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM metrics").get(),
      ).toEqual({ count: 1 });
      expect(
        copied
          .prepare("SELECT COUNT(*) AS count FROM ticket_departments")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM tickets").get(),
      ).toEqual({
        count: 1,
      });
      expect(
        copied.prepare("SELECT COUNT(*) AS count FROM ticket_events").get(),
      ).toEqual({ count: 1 });
      expect(
        copied
          .prepare("SELECT ticket_id FROM tickets WHERE guild_id = ?")
          .get("111111111111111111"),
      ).toEqual({ ticket_id: reservation.ticket.ticketId });
      for (const table of [
        "delegated_capability_grants",
        "suggestion_configurations",
        "suggestions",
        "suggestion_votes",
        "suggestion_events",
        "application_forms",
        "application_form_fields",
        "applications",
        "application_responses",
        "application_events",
        "mudae_watch_deliveries",
        "onboarding_rules_versions",
        "onboarding_configurations",
        "onboarding_message_templates",
        "onboarding_autoroles",
        "member_onboarding_states",
        "member_rule_acceptances",
        "onboarding_delivery_records",
        "onboarding_role_operations",
        "onboarding_audit_events",
        "role_menus",
        "role_menu_options",
        "role_menu_posts",
        "role_menu_operations",
        "role_menu_operation_items",
        "voting_panels",
        "voting_panel_options",
        "voting_panel_selections",
      ] as const) {
        const sourceRows = original
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all();
        expect(sourceRows.length, `${table} source fixture`).toBeGreaterThan(0);
        expect(
          copied.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          `${table} backup rows`,
        ).toEqual(sourceRows);
      }
      expect(
        copied
          .prepare(
            "SELECT title, message_id FROM suggestions WHERE suggestion_id = ?",
          )
          .get(suggestion.suggestion.suggestionId),
      ).toEqual({
        title: "Backup suggestion",
        message_id: "131313131313131313",
      });
      expect(
        copied
          .prepare(
            "SELECT response_text FROM application_responses WHERE application_id = ?",
          )
          .get(application.application.applicationId),
      ).toEqual({
        response_text: "A private answer preserved by the backup.",
      });
    } finally {
      original.close();
      copied.close();
    }
  });

  it("supports an exact schema-v9 backup before migration", async () => {
    const root = makeRoot();
    const source = path.join(root, "source-v9.db");
    const output = path.join(root, "backup-v9.db");
    const db = new Database(source);
    db.pragma("foreign_keys = ON");
    initializeV9Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 9 }),
    ).resolves.toMatchObject({ schema: "legacy-v9", schemaVersion: 9 });
    expect(validateDatabaseFile(output, { expect: 9 }).schema).toBe(
      "legacy-v9",
    );
  });

  it("supports exact v2 pre-migration backups", async () => {
    const root = makeRoot();
    const source = path.join(root, "source-v2.db");
    const output = path.join(root, "backup-v2.db");
    const db = createV2FixtureDatabase(source);
    insertV2Guild(db, { guildId: "111111111111111111" });
    db.close();

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 2 }),
    ).resolves.toMatchObject({ schema: "legacy-v2", schemaVersion: 2 });
    expect(validateDatabaseFile(output, { expect: 2 }).schema).toBe(
      "legacy-v2",
    );
  });

  it("supports exact v3 pre-migration backups", async () => {
    const root = makeRoot();
    const source = path.join(root, "source-v3.db");
    const output = path.join(root, "backup-v3.db");
    const db = new Database(source);
    db.pragma("foreign_keys = ON");
    initializeV3Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 3 }),
    ).resolves.toMatchObject({ schema: "legacy-v3", schemaVersion: 3 });
    expect(validateDatabaseFile(output, { expect: 3 }).schema).toBe(
      "legacy-v3",
    );
  });

  it("supports exact v4 pre-migration backups", async () => {
    const root = makeRoot();
    const source = path.join(root, "source-v4.db");
    const output = path.join(root, "backup-v4.db");
    const db = new Database(source);
    db.pragma("foreign_keys = ON");
    initializeV4Schema(db, "2026-01-01T00:00:00.000Z");
    db.close();

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 4 }),
    ).resolves.toMatchObject({ schema: "legacy-v4", schemaVersion: 4 });
    expect(validateDatabaseFile(output, { expect: 4 }).schema).toBe(
      "legacy-v4",
    );
  });

  it("refuses existing destinations and schema mismatches", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "existing.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.close();
    fs.writeFileSync(output, "operator-owned");

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 11 }),
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(output, "utf8")).toBe("operator-owned");

    const mismatch = path.join(root, "mismatch.db");
    await expect(
      backupDatabase({ dbFile: source, outputFile: mismatch, expect: 2 }),
    ).rejects.toThrow(/expected exact schema v2/);
    expect(fs.existsSync(mismatch)).toBe(false);
    expect(
      fs.readdirSync(root).some((entry) => entry.endsWith(".partial")),
    ).toBe(false);

    const reservedBySidecar = path.join(root, "reserved-by-sidecar.db");
    fs.writeFileSync(`${reservedBySidecar}-wal`, "operator-owned sidecar");
    await expect(
      backupDatabase({
        dbFile: source,
        outputFile: reservedBySidecar,
        expect: 11,
      }),
    ).rejects.toThrow(/sidecar already exists/);
    expect(fs.existsSync(reservedBySidecar)).toBe(false);
    expect(fs.readFileSync(`${reservedBySidecar}-wal`, "utf8")).toBe(
      "operator-owned sidecar",
    );
  });

  it("fails closed when the destination filesystem cannot publish atomically", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "unsupported-filesystem.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.close();
    const linkFailure = Object.assign(new Error("hard links unsupported"), {
      code: "ENOTSUP",
    });
    vi.spyOn(fs, "linkSync").mockImplementationOnce(() => {
      throw linkFailure;
    });

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 11 }),
    ).rejects.toThrow(/requires hard-link support/);
    expect(fs.existsSync(output)).toBe(false);
    expect(
      fs.readdirSync(root).some((entry) => entry.endsWith(".partial")),
    ).toBe(false);
  });

  it("never claims a partial path created by a failing snapshot operation", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "backup.db");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.close();
    let competingPath = "";
    const vacuum = vi
      .spyOn(Database.prototype, "vacuumInto")
      .mockImplementationOnce((destinationFile) => {
        competingPath = destinationFile;
        fs.writeFileSync(destinationFile, "operator-owned-after-failure");
        throw new Error("injected snapshot failure");
      });

    try {
      await expect(
        backupDatabase({ dbFile: source, outputFile: output, expect: 11 }),
      ).rejects.toThrow(/cleanup was incomplete/);
      expect(fs.readFileSync(competingPath, "utf8")).toBe(
        "operator-owned-after-failure",
      );
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      vacuum.mockRestore();
    }
  });

  it("captures a valid transaction boundary while another connection writes", async () => {
    const root = makeRoot();
    const source = path.join(root, "source live O'Brien Ω.db");
    const output = path.join(root, "backup live O'Brien Ω.db");
    const restored = path.join(root, "restored live O'Brien Ω.db");
    const ready = path.join(root, "writer.ready");
    const stop = path.join(root, "writer.stop");
    const storage = new BotStorage({ dbFile: source });
    storage.initStorage();
    storage.ensureGuild("111111111111111111");
    storage.close();
    const padding = new Database(source, { fileMustExist: true });
    try {
      padding
        .prepare(
          "UPDATE guilds SET name = zeroblob(67108864) WHERE guild_id = ?",
        )
        .run("111111111111111111");
    } finally {
      padding.close();
    }

    const writerScript = fileURLToPath(
      new URL("./helpers/concurrent-backup-writer.ts", import.meta.url),
    );
    const writer = Bun.spawn(
      [process.execPath, "--no-env-file", writerScript, source, ready, stop],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      await waitForFile(ready, writer);
      const before = readProbeValues(source);
      expect(before.first).toBe(before.second);

      const backup = await backupDatabase({
        dbFile: source,
        outputFile: output,
        expect: 11,
      });
      expect(backup).toMatchObject({
        schema: "current-v11",
        integrity: "ok",
        foreignKeyViolations: 0,
      });
      expect(typeof backup.concurrentWritesObserved).toBe("boolean");
      if (process.platform !== "linux") {
        expect(backup.concurrentWritesObserved).toBe(true);
      }
      expect(backup.snapshotDurationMs).toBeGreaterThan(0);

      const after = readProbeValues(source);
      expect(after.first).toBe(after.second);
      expect(after.first).toBeGreaterThan(before.first);

      const snapshot = readProbeValues(output);
      expect(snapshot.first).toBe(snapshot.second);
      expect(snapshot.first).toBeGreaterThan(before.first);
      expect(snapshot.first).toBeLessThan(after.first);

      fs.copyFileSync(output, restored, fs.constants.COPYFILE_EXCL);
      expect(validateDatabaseFile(restored, { expect: 11 })).toMatchObject({
        schema: "current-v11",
        integrity: "ok",
        foreignKeyViolations: 0,
      });
      expect(readProbeValues(restored)).toEqual(snapshot);
    } finally {
      fs.writeFileSync(stop, "stop");
      const exitCode = await writer.exited;
      const stderr = await new Response(writer.stderr).text();
      expect(exitCode, stderr).toBe(0);
    }
  }, 30_000);

  it("rejects a destination directory reached through a reparse point", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const realDestination = path.join(root, "real destination");
    const redirectedDestination = path.join(root, "redirected destination");
    fs.mkdirSync(realDestination);
    createDirectoryLink(realDestination, redirectedDestination);
    createCurrentDatabase(source);

    await expect(
      backupDatabase({
        dbFile: source,
        outputFile: path.join(redirectedDestination, "backup.db"),
        expect: 11,
      }),
    ).rejects.toThrow(/reparse point/u);
    expect(fs.readdirSync(realDestination)).toEqual([]);
  });

  it("refuses a reparse-point sidecar without modifying it", async () => {
    const root = makeRoot();
    const source = path.join(root, "source.db");
    const output = path.join(root, "backup.db");
    const sidecarTarget = path.join(root, "operator sidecar target");
    fs.mkdirSync(sidecarTarget);
    createDirectoryLink(sidecarTarget, `${output}-wal`);
    createCurrentDatabase(source);

    await expect(
      backupDatabase({ dbFile: source, outputFile: output, expect: 11 }),
    ).rejects.toThrow(/already exists/u);
    expect(fs.existsSync(`${output}-wal`)).toBe(true);
    expect(fs.readdirSync(sidecarTarget)).toEqual([]);
    expect(fs.existsSync(output)).toBe(false);
  });
});

function createCurrentDatabase(fileName: string): void {
  const storage = new BotStorage({ dbFile: fileName });
  storage.initStorage();
  storage.ensureGuild("111111111111111111");
  storage.close();
}

function createDirectoryLink(target: string, link: string): void {
  fs.symlinkSync(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function readProbeValues(databaseFile: string): {
  first: number;
  second: number;
} {
  const db = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const firstKey = "command_usage.utility.backup_probe";
    const secondKey = "command_failures.utility.backup_probe";
    return db
      .prepare(
        `SELECT
           COALESCE(MAX(CASE WHEN metric_key = ? THEN metric_value END), 0) AS first,
           COALESCE(MAX(CASE WHEN metric_key = ? THEN metric_value END), 0) AS second
         FROM metrics
         WHERE guild_id = ? AND metric_key IN (?, ?)`,
      )
      .get(firstKey, secondKey, "111111111111111111", firstKey, secondKey) as {
      first: number;
      second: number;
    };
  } finally {
    db.close();
  }
}

async function waitForFile(
  fileName: string,
  writer: Bun.ReadableSubprocess,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(fileName)) {
    if (writer.exitCode !== null) {
      const stderr = await new Response(writer.stderr).text();
      throw new Error(`Concurrent writer exited before readiness: ${stderr}`);
    }
    if (Date.now() >= deadline) {
      writer.kill();
      throw new Error(
        "Concurrent writer did not become ready within 10 seconds",
      );
    }
    await Bun.sleep(10);
  }
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-backup-"));
  roots.push(root);
  return root;
}
