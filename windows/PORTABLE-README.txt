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
6. In Discord, use Superior immediately. Configure only workflows that need
   real current-server channel and role bindings.

LAUNCHER COMMANDS
  SuperiorBot.exe --version   Show the packaged version without Discord login.
  SuperiorBot.exe --check     Check configuration without Discord login.
  SuperiorBot.exe --diagnostics
                              Show safe build/runtime/database diagnostics
                              without Discord login or secret values.
  SuperiorBot.exe             Start the bot.
  Start Superior Bot.cmd      Command Prompt fallback with the same options.

DATA AND BACKUPS
- superior.db is created beside the launcher unless DB_FILE selects another
  path. SQLite sidecars can appear while the bot is running.
- A missing or empty database is initialized as schema v9. Startup does not
  upgrade an older schema automatically.
- Never share .env, a database, a sidecar, export, or backup. Schema-v9 files
  can contain the existing workflow data plus case reasons/private notes,
  reporter/appellant identities and explanations, review decisions, message
  link IDs, and anti-spam enforcement metadata. Raw anti-spam text is not stored.
- Run only one Superior process for a database. The launcher rejects a second
  instance using the same application root or database and automatically
  recovers an abandoned named lock after a crash. A kill-on-close Job Object
  prevents a killed launcher from leaving an orphaned node.exe after its locks
  release. The first Ctrl+C waits for controlled drain; a second forces exit.
  Sharing live SQLite between processes or through a cloud/network folder is
  unsupported.
- Use the bundled SQLite-aware backup tool while running. Stop every process
  that can write the file before migration, manual replacement, or rollback.
- MANIFEST.sha256 contains a SHA-256 for every shipped file other than the
  manifest itself. Verify the release ZIP checksum before extracting it.
- BUILD-INFO.txt records the package, target, pinned Node archive hash,
  package-lock hash, and deterministic source identity used for this build.

SCHEMA UPGRADE
Version 6.1.0 will not start against schema v8, v7, v6, v5, v4, v3, or v2. Close
every old bot, bundled node.exe, and SQLite editor; keep the original database
untouched; and copy it into this folder as superior.db. For the normal
schema-v8 upgrade from Superior 6.0.0, run these commands in PowerShell:

  New-Item -ItemType Directory -Path .\backups -Force
  .\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 8
  .\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v61-schema8.db --expect 8
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
  .\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 9
  .\SuperiorBot.exe --check

Stop if any command fails. Migration runs in one transaction and a failure
leaves the copied source at v8. It preserves every v8 row and external Discord
ID, extends the delegated-capability constraint, and adds empty/default-disabled
Phase 3 storage. It never invents cases or activates anti-spam. Keep the
validated v8 backup until the migrated copy and workflows have been reviewed.

Exact schema v7, v6, v5, v4, v3, and the exact supported schema-v2 layout can
migrate directly to v9. Use the same commands with --expect 7, 6, 5, 4, 3, or
2 for the source check and backup, a matching backup name, and --expect 9 for
the final check. Historical stages retain their documented behavior. Schema v1
must first be upgraded to v2 with
the final 4.0.0 source release. Renaming a file does not change its schema.

After migration, review /config status, /access list, /panel status, existing
panel buttons, ticket department health/recovery, suggestion configuration,
and application form privacy. A restart or migration never requires reposting.
Review /restrictedping list, verify every retained mapping, and test /pingrole
plus both cooldowns. Migration never invents or enables external bindings.
Restart command synchronization must register /pingrole, /restrictedping,
/moderation, /report, /appeal, and /automod; global propagation can take time.
Confirm /moderation status and /automod status show new services/rules disabled
and no invented cases. Configure moderation, report, and appeal bindings from
current private Discord resources before testing a safety panel. Test one
conservative anti-spam rule in a disposable channel; message edits are excluded.

UPDATING
1. Stop the bot and create a validated schema-v9 backup.
2. Extract the new release into a new folder.
3. Copy only .env and the active database into that folder. Do not merge old
   app, runtime, or tools directories.
4. Run --version and --check, start the bot, and verify it before removing the
   prior folder or backup.

The v9 restore tool intentionally accepts only v9 backups. After this
installation migrates, never start, deploy, test, or recommend a pre-v9
executable for it. For incident recovery, stop every writer, preserve the v9
database and its backups, and use a known-good schema-v9-capable build, current
recovery tooling, or a forward fix. Do not downgrade the application or schema.

NOTES
- This build supports 64-bit Windows 10 and 11.
- The launcher is not code-signed, so Windows SmartScreen may show a warning.
- Closing the console stops the bot. Sleep or shutdown takes a laptop-hosted
  bot offline.
- Global Discord command updates can take time to propagate.
- Privacy and Terms files in the source repository are unpublished drafts.
  Do not publish a bot until operator identity, hosting, retention, contact,
  and Discord-policy requirements have been completed and reviewed.
