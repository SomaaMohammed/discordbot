SUPERIOR BOT FOR WINDOWS (x64)
================================

This folder is portable. Keep every file and subfolder together. A separate
Node.js installation is not required.

FIRST RUN
1. In the Discord Developer Portal, enable Server Members Intent and Message
   Content Intent for the bot.
2. Copy .env.example to a new file named .env in this folder.
3. Open .env in Notepad, set DISCORD_TOKEN, save, and close it.
   Optionally set BOT_OPERATOR_IDS to the deployment owner's Discord ID for
   the visible, audited /operator recovery controls.
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
  Update.exe --source <new SuperiorBot.exe> [--target <folder>]
                              Replace the installed executable safely, preserve
                              .env/database/backups, verify it, and restart it.
  SuperiorBot.exe             Start the bot.
  Start Superior Bot.cmd      Command Prompt fallback with the same options.

DATA AND BACKUPS
- superior.db is created beside the launcher unless DB_FILE selects another
  path. SQLite sidecars can appear while the bot is running.
- A missing or empty database is initialized as schema v10. On normal launch,
  the packaged executable automatically backs up and upgrades supported schema
  v2-v9 databases before Discord login. It never modifies schema v1, unknown,
  malformed, or partial databases.
- Never share .env, a database, a sidecar, export, or backup. Schema-v10 files
  can contain the existing workflow data plus private moderation/review fields,
  rules and welcome/farewell templates, member acceptance/lifecycle timestamps,
  account-age metadata, and automatic/menu-role outcomes. Onboarding stores no
  member-message or DM contents, full profiles, IP/email/phone data, invite
  history, or raw gateway payloads. Raw anti-spam text is not stored.
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
Version 7.2.7 will not start against schema v1, unknown, malformed, or partial
databases. It automatically upgrades exact schema v2-v9 databases when you run
SuperiorBot.exe. Close every old bot, bundled node.exe, and SQLite editor first;
keep the original database untouched; and copy the working database into this
folder as superior.db.

On launch, the executable validates the source, creates a timestamped
SQLite-aware backup under .\backups, performs a complete dry-run, applies the
transactional migration to v10, validates the result, and only then logs in to
Discord. If any step fails, the bot does not start and the backup is retained.
The source remains unchanged if the migration fails. The migration preserves
existing rows and external Discord IDs, adds empty/default-disabled Phase 4
storage, never invents joins, rules, acceptances, menus, deliveries, or role
outcomes, and performs no Discord messages or role changes.

Schema v1 must first be upgraded to v2 with the final 4.0.0 source release.
Unknown, malformed, or partial databases stop with an error rather than being
overwritten. Renaming a file does not change its schema.

After migration, review /config status, /access list, /panel status, existing
panel buttons, ticket department health/recovery, suggestion configuration,
and application form privacy. A restart or migration never requires reposting.
Review /restrictedping list, verify every retained mapping, and test /pingrole
plus both cooldowns. Migration never invents or enables external bindings.
Restart command synchronization must register /pingrole, /restrictedping,
/moderation, /report, /appeal, /automod, /onboarding, and /rolemenu; global
propagation can take time.
Confirm /moderation status and /automod status show new services/rules disabled
and no invented cases. Configure moderation, report, and appeal bindings from
current private Discord resources before testing a safety panel. Test one
conservative anti-spam rule in a disposable channel; message edits are excluded.

Confirm /onboarding status shows welcome/farewell, verification, private member
logging, and human/bot autoroles disabled with no invented member history.
Configure only current channels and safe roles, then test a disposable join,
bot join, rules acknowledgement, and native Membership Screening completion.
Superior never assigns human/verification roles while Discord reports pending;
verified-role addition precedes optional unverified-role removal. DM failure is
best effort, and account-age alerts are informational private-log events only.
Create a disabled /rolemenu with safe roles, inspect, enable, post, exercise its
selection limits/prerequisite, and test bounded recovery. Imported onboarding,
autoroles, verification panels, menu bindings, and menus stay dormant until
current-resource validation and explicit enablement. Legacy role panels retain
their existing component behavior.

UPDATING
1. Build or download a trusted new SuperiorBot.exe and keep its SHA-256 hash.
2. Stop the bot. Do not move or copy .env, superior.db, or the backups.
3. Run `Update.exe --source C:\path\to\new\SuperiorBot.exe` from the
   installed bot folder. Add `--sha256 <hash>` when a checksum is available.
4. The updater creates an executable backup, replaces only SuperiorBot.exe,
   runs --version and --check, and starts the new bot automatically. Use
   `--no-start` when you want to start it manually.
5. Keep the generated executable backup until the new release is verified.

The v10 restore tool intentionally accepts only v10 backups. After this
installation migrates, never start, deploy, test, or recommend a pre-v10
executable for it. For incident recovery, stop every writer, preserve the v10
database and its backups, and use a known-good schema-v10-capable build, current
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
