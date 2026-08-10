import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../src/storage/backup.js";
import { BotStorage } from "../src/storage/db.js";
import { validateDatabaseFile } from "../src/storage/migration.js";
import {
  initializeV3Schema,
  initializeV4Schema,
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
  it("copies and validates schema v6 including operational data", async () => {
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
    storage.close();

    const result = await backupDatabase({
      dbFile: source,
      outputFile: output,
      expect: 6,
    });
    expect(result).toMatchObject({
      schema: "current-v6",
      schemaVersion: 6,
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(validateDatabaseFile(source, { expect: 6 }).schema).toBe(
      "current-v6",
    );
    expect(validateDatabaseFile(output, { expect: 6 }).schema).toBe(
      "current-v6",
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
      backupDatabase({ dbFile: source, outputFile: output, expect: 6 }),
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(output, "utf8")).toBe("operator-owned");

    const mismatch = path.join(root, "mismatch.db");
    await expect(
      backupDatabase({ dbFile: source, outputFile: mismatch, expect: 2 }),
    ).rejects.toThrow(/expected exact schema v2/);
    expect(fs.existsSync(mismatch)).toBe(false);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-backup-"));
  roots.push(root);
  return root;
}
