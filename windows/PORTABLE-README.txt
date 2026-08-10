SUPERIOR BOT FOR WINDOWS (x64)
================================

This folder is portable. Keep every file and subfolder together. A separate
Node.js installation is not required.

FIRST RUN
1. In the Discord Developer Portal, enable Server Members Intent and Message
   Content Intent for the bot.
2. Copy .env.example to a new file named .env in this folder.
3. Open .env in Notepad, set DISCORD_TOKEN, save, and close it.
4. Run SuperiorBot.exe --check. This checks configuration and native SQLite in
   memory without connecting to Discord or creating a database.
5. Double-click SuperiorBot.exe to start the bot.
6. In Discord, use /setup to configure, validate, and enable each server.

LAUNCHER COMMANDS
  SuperiorBot.exe --version   Show the packaged version without Discord login.
  SuperiorBot.exe --check     Check configuration without Discord login.
  SuperiorBot.exe             Start the bot.
  Start Superior Bot.cmd      Command Prompt fallback with the same options.

DATA AND BACKUPS
- superior.db is created beside the launcher unless DB_FILE selects another
  path. SQLite sidecars can appear while the bot is running.
- A missing or empty database is initialized as schema v7. Startup does not
  upgrade an older schema automatically.
- Never share .env, a database, a sidecar, export, or backup. Schema-v7 files
  can contain ticket answers, public suggestions and voter IDs, private
  staff-application answers, and restricted-ping member/audit records.
- Run only one Superior process for a database. Sharing live SQLite between
  processes or through a cloud/network folder is unsupported.
- Use the bundled SQLite-aware backup tool while running. Stop every process
  that can write the file before migration, manual replacement, or rollback.
- MANIFEST.sha256 contains a SHA-256 for every shipped file other than the
  manifest itself. Verify the release ZIP checksum before extracting it.
- BUILD-INFO.txt records the package, target, pinned Node archive hash, and
  package-lock hash used for this build.

SCHEMA UPGRADE
Version 5.5.0 will not start against schema v6, v5, v4, v3, or v2. Close every old bot,
bundled node.exe, and SQLite editor; keep the original database untouched; and
copy it into this folder as superior.db. For the normal schema-v6 upgrade, run
these commands in PowerShell:

  New-Item -ItemType Directory -Path .\backups -Force
  .\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 6
  .\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v5.5-schema6.db --expect 6
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
  .\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 7
  .\SuperiorBot.exe --check

Stop if any command fails. Migration runs in one transaction and a failure
leaves the copied source at v6. It preserves every existing row and adds empty
bounded internal delivery-deduplication state. Keep the validated v6 backup
until the migrated copy and existing workflows have been reviewed.

Exact schema v5, v4, v3, and the exact supported schema-v2 layout can migrate
directly to v7. Use the same commands with --expect 5, --expect 4, --expect 3,
or --expect 2 for the source check and backup, a matching backup name, and
--expect 7 for the final check. Historical conversion stages retain their
documented behavior. Schema v1 must first be upgraded to v2 with
the final 4.0.0 source release. Renaming a file does not change its schema.

After migration, review /setup status, /access list, /panel status, ticket
department health/recovery, suggestion setup, and application form privacy.
Review /restrictedping list, verify every retained mapping, and test /pingrole
plus both cooldowns. Migration never invents or enables external bindings.
Restart command synchronization must register /pingrole and /restrictedping;
global propagation can take time.

UPDATING
1. Stop the bot and create a validated schema-v7 backup.
2. Extract the new release into a new folder.
3. Copy only .env and the active database into that folder. Do not merge old
   app, runtime, or tools directories.
4. Run --version and --check, start the bot, and verify it before removing the
   prior folder or backup.

For a release rollback from schema v7 to an older application, stop every
writer and restore that release's original generation-matched pre-migration
backup through a controlled file replacement. The v7 restore tool intentionally
accepts only v7 backups. Internal delivery-deduplication state cannot be carried
back to v6.
Never mix application and schema generations.

NOTES
- This build supports 64-bit Windows 10 and 11.
- The launcher is not code-signed, so Windows SmartScreen may show a warning.
- Closing the console stops the bot. Sleep or shutdown takes a laptop-hosted
  bot offline.
- Global Discord command updates can take time to propagate.
- Privacy and Terms files in the source repository are unpublished drafts.
  Do not publish a bot until operator identity, hosting, retention, contact,
  and Discord-policy requirements have been completed and reviewed.
