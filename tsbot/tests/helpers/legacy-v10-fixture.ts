import fs from "node:fs";
import {
  createDefaultGuildSettings,
  serializeGuildSettings,
} from "../../src/guild-settings.js";
import Database from "../../src/storage/database.js";
import {
  detectDatabaseSchema,
  initializeV10Schema,
  validateV10Schema,
  validateV11Schema,
} from "../../src/storage/schema.js";

const FIXTURE_GUILD_ID = "123456789012345678";
const FIXTURE_GUILD_NAME = "packaged migration sentinel";
const FIXTURE_TIME = "2026-08-31T00:00:00.000Z";

const [mode, databaseFile] = Bun.argv.slice(2);
if ((mode !== "create" && mode !== "verify") || !databaseFile) {
  throw new Error(
    "Usage: bun legacy-v10-fixture.ts <create|verify> <database-file>",
  );
}

if (mode === "create" && fs.existsSync(databaseFile)) {
  throw new Error(`Legacy fixture destination already exists: ${databaseFile}`);
}

const database = new Database(databaseFile, { readonly: mode === "verify" });
try {
  if (mode === "create") {
    initializeV10Schema(database, FIXTURE_TIME);
    database
      .prepare(
        `INSERT INTO guilds (
           guild_id, enabled, name, joined_at, left_at, created_at, updated_at
         ) VALUES (?, 1, ?, ?, NULL, ?, ?)`,
      )
      .run(
        FIXTURE_GUILD_ID,
        FIXTURE_GUILD_NAME,
        FIXTURE_TIME,
        FIXTURE_TIME,
        FIXTURE_TIME,
      );
    database
      .prepare(
        `INSERT INTO guild_settings (
           guild_id, settings_version, settings_json, updated_at
         ) VALUES (?, 3, ?, ?)`,
      )
      .run(
        FIXTURE_GUILD_ID,
        serializeGuildSettings(createDefaultGuildSettings()),
        FIXTURE_TIME,
      );
    const schema = detectDatabaseSchema(database);
    if (schema !== "legacy-v10") {
      throw new Error(
        `Failed to create a valid schema-v10 fixture (${schema}): ${validateV10Schema(database).join("; ")}`,
      );
    }
    console.log(`[legacy-fixture] created schema-v10 database ${databaseFile}`);
  } else {
    const schema = detectDatabaseSchema(database);
    if (schema !== "current-v11") {
      throw new Error(
        `Packaged migration produced ${schema}, expected current-v11`,
      );
    }
    const issues = validateV11Schema(database);
    if (issues.length > 0) {
      throw new Error(`Migrated schema is invalid: ${issues.join("; ")}`);
    }
    const row = database
      .prepare("SELECT enabled, name FROM guilds WHERE guild_id = ?")
      .get(FIXTURE_GUILD_ID) as
      { enabled: number; name: string | null } | undefined;
    if (row?.enabled !== 1 || row.name !== FIXTURE_GUILD_NAME) {
      throw new Error(
        "Packaged migration did not preserve the legacy sentinel",
      );
    }
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      String(Object.values(integrity[0] ?? {})[0]).toLowerCase() !== "ok"
    ) {
      throw new Error(
        `Migrated integrity check failed: ${JSON.stringify(integrity)}`,
      );
    }
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) {
      throw new Error(
        `Migrated foreign-key check failed: ${JSON.stringify(foreignKeys)}`,
      );
    }
    console.log(
      `[legacy-fixture] verified packaged schema-v10 to schema-v11 migration ${databaseFile}`,
    );
  }
} finally {
  database.close();
}
