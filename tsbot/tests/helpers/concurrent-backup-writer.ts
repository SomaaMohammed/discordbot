import fs from "node:fs";
import Database from "../../src/storage/database.js";

const [databaseFile, readyFile, stopFile] = process.argv.slice(2);
if (!databaseFile || !readyFile || !stopFile) {
  throw new Error(
    "Usage: concurrent-backup-writer.ts <database> <ready-file> <stop-file>",
  );
}

const guildId = "111111111111111111";
const firstKey = "command_usage.utility.backup_probe";
const secondKey = "command_failures.utility.backup_probe";
const db = new Database(databaseFile, {
  fileMustExist: true,
  timeout: 30_000,
});
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("wal_autocheckpoint = 0");

const increment = db.transaction(() => {
  const now = new Date().toISOString();
  for (const metricKey of [firstKey, secondKey]) {
    db.prepare(
      `INSERT INTO metrics (guild_id, metric_key, metric_value, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (guild_id, metric_key) DO UPDATE SET
         metric_value = metrics.metric_value + 1,
         updated_at = excluded.updated_at`,
    ).run(guildId, metricKey, now);
  }
});

try {
  for (let index = 0; index < 10; index += 1) increment.immediate();
  fs.writeFileSync(readyFile, "ready", { flag: "wx" });
  while (!fs.existsSync(stopFile)) {
    for (let index = 0; index < 25; index += 1) increment.immediate();
    await Bun.sleep(1);
  }
} finally {
  db.close();
}
