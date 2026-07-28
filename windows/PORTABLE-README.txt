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
- Never share .env, a database, a sidecar, or a backup.
- Stop the bot before manually copying or restoring its database files.
- MANIFEST.sha256 contains a SHA-256 for every shipped file other than the
  manifest itself. Verify the release ZIP checksum before extracting it.
- BUILD-INFO.txt records the package, target, pinned Node archive hash, and
  package-lock hash used for this build.

SCHEMA-V2 UPGRADE
Version 5 will not start against schema v2. Close every old bot process, keep
the original database untouched, and copy it into this folder as superior.db.
Then run these commands from PowerShell:

  New-Item -ItemType Directory -Path .\backups -Force
  .\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v5-schema2.db --expect 2
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
  .\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
  .\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 3
  .\SuperiorBot.exe --check

Stop if any command fails. Keep the validated v2 backup until the migrated
copy and every server configuration have been reviewed. Schema v1 must first
be upgraded to v2 with the final 4.0.0 source release; renaming a file does not
change its schema.

UPDATING
1. Stop the bot and make a validated backup.
2. Extract the new release into a new folder.
3. Copy only .env and the active database into that folder. Do not merge old
   app, runtime, or tools directories.
4. Run --version and --check, start the bot, and verify it before removing the
   prior folder or backup.

NOTES
- This build supports 64-bit Windows 10 and 11.
- The launcher is not code-signed, so Windows SmartScreen may show a warning.
- Closing the console stops the bot. Sleep or shutdown takes a laptop-hosted
  bot offline.
- Global Discord command updates can take time to propagate.
- Privacy and Terms files in the source repository are unpublished drafts.
  Do not publish a bot until operator identity, hosting, retention, contact,
  and Discord-policy requirements have been completed and reviewed.
