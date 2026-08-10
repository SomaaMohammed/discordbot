# Windows guide

The repository-root `SuperiorBot.exe` is designed for a Windows x64 laptop or desktop. It contains the exact Node.js runtime, compiled application, production dependencies, and native SQLite module in one self-extracting file. It does not require ZIP extraction or a separate Node.js installation.

## First run

1. Put `SuperiorBot.exe` and a copy of `.env.example` in a writable folder.
2. In the Discord Developer Portal, enable Server Members Intent and Message Content Intent and install the application with the permissions described in [Configuration](configuration.md).
3. Rename the copied `.env.example` to `.env` beside `SuperiorBot.exe`.
4. Add `DISCORD_TOKEN` and leave `DB_FILE=superior.db` unless an absolute path is intentional.
5. Open PowerShell in that folder and run:

```powershell
.\SuperiorBot.exe --version
.\SuperiorBot.exe --check
```

`--check` loads `.env`, resolves the database path, and opens the bundled native SQLite module against memory. It does not log in to Discord and does not create `superior.db`.

Start the bot with:

```powershell
.\SuperiorBot.exe
```

You can also double-click the executable. The executable is not code-signed, so Windows SmartScreen may require an operator decision. Verify that it came from the repository or a trusted CI artifact before approving it.

## Files, privacy, and process boundaries

The first run extracts the immutable application payload into `%LOCALAPPDATA%\SuperiorBot\payloads`. Do not put credentials or databases in that cache. The launcher always uses the directory containing the visible `SuperiorBot.exe` as the writable application root, regardless of its private runtime location or the current shell directory.

By default these writable files sit beside the launcher:

- `.env`: local credentials and selectors; never share it.
- `superior.db`: the active SQLite database created on first real startup.
- SQLite sidecars such as `superior.db-wal` and `superior.db-shm` while running.

A missing or empty database is initialized as schema v6 on the first real startup. Normal startup never upgrades an older database.

Schema-v6 data can include Discord identifiers, delegated grants, ticket questions/answers and closure metadata, suggestion authors/content/votes/reviews, private staff-application answers/decisions, and restricted-ping mappings/member cooldowns/audit actors. Protect the database, backups, exports, PowerShell history, and host account accordingly. Do not synchronize a live database through a consumer cloud-drive folder.

Run exactly one Superior process for one database. Concurrent interactions inside that process are protected by SQLite constraints and transactions; two executables sharing the file are unsupported. The bot runs only while the process and computer are awake. Disable sleep or use a dedicated always-on host for continuous service.

## Portable ZIP and schema upgrades

The versioned portable ZIP is available from CI for offline database maintenance. It exposes bundled `runtime`, `app`, and `tools` directories plus their manifest and checksums. The single-file launcher intentionally exposes only start, version, and configuration-check operations.

Superior 5.4.0 refuses schema v5, v4, v3, and v2 during normal startup. Close every `SuperiorBot.exe`, bundled `node.exe`, SQLite browser, and other process that can write the selected database. Extract the 5.4.0 portable ZIP, copy the database into that folder as `superior.db`, and keep the original untouched.

For the normal schema-v5 upgrade from Superior 5.3.0, run:

```powershell
New-Item -ItemType Directory -Path .\backups -Force
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 5
.\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v5.4-schema5.db --expect 5
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 6
.\SuperiorBot.exe --check
```

Do not continue if classification, backup, dry-run, migration, or final validation fails. The migration is one transaction; failure leaves the working copy at v5. It preserves every existing row and adds four empty restricted-ping tables and their indexes. Keep the validated v5 backup until the new executable and every guild's existing workflow plus new restricted-ping command surface has been reviewed.

Exact schema v4, schema v3, and the exact supported schema-v2 layout can migrate directly to v6 through the same CLI. Change the source checker and backup expectation to `--expect 4`, `--expect 3`, or `--expect 2`, use a generation-specific backup name, and keep the final checker at `--expect 6`. A failed transaction leaves the copy at its source generation. The historical v4-to-v5 stage preserves panels/tickets/events and converts ticket configuration/history into a `General Support` department with Subject/Details responses before the additive v6 step. V3 preserves guild/settings/metrics; v2 applies its documented compatibility conversion and may disable unsafe settings for review or drop obsolete rows. Every legacy migration starts with no restricted-ping mappings.

A schema-v1 database must first be upgraded to v2 with the final 4.0.0 source release. Renaming a database file never upgrades its contents. Never test migration against the only copy or against a database still selected by a running process.

## Post-upgrade review

After starting 5.4.0:

1. Check `/setup status`, `/setup validate`, and guild enablement.
2. Review `/access list`; legacy migration creates no delegated grants.
3. Review `/panel status` and refresh missing launchers.
4. Check the migrated `General Support` department and recover a representative active ticket before accepting new tickets.
5. Configure suggestions and application forms from current Discord resources; migration does not invent these bindings.
6. Confirm `/restrictedping list` is empty after migration, add only reviewed safe role/channel pairs, and test one disposable `/pingrole` notification plus its user/role cooldowns.
7. Test public suggestion voting and a private application in disposable records, confirming that application answers are visible only in the private review channel.
8. Confirm global command synchronization has registered `/pingrole` and `/restrictedping`; global propagation may take time after restart.

## Updating without a schema change

1. Stop the existing bot and confirm no `SuperiorBot.exe` or bundled `node.exe` remains running.
2. Create and validate a current schema-v6 backup with the portable backup/check tools.
3. Place the new `SuperiorBot.exe` in a new writable folder.
4. Copy only `.env` and the validated active database into the new folder.
5. Run `--version` and `--check`, then start it.
6. Keep the previous executable and backup until verification succeeds. Old private runtime caches can be removed after the new version is verified and stopped.

For a 5.4.0 code rollback, stop the process and use a known-good 5.4.0 executable with a validated v6 backup. To return to 5.3.0 after the v5-to-v6 migration, preserve the v6 database separately, restore the validated pre-v5.4 schema-v5 backup through a controlled replacement, and use the exact 5.3.0 executable. Restricted-ping state cannot be carried back to v5. Returning to an older generation likewise requires its original generation-matched backup. The 5.4.0 restore tooling accepts only v6 and cannot perform a release-level schema downgrade. Never mix application and schema generations.

## Troubleshooting

- **Missing `.env`:** copy `.env.example` beside the launcher and provide the token.
- **Configuration check fails:** read the single reported selector error; check guild registration mode and IDs without posting `.env` contents.
- **Native SQLite check fails:** remove only the matching private payload directory under `%LOCALAPPDATA%\SuperiorBot\payloads` and rerun the trusted executable. Do not copy `node_modules` from another Node version or operating system.
- **Startup refuses the database:** stop the executable, classify it with `check-cli.js`, and follow the explicit migration workflow. Never delete or rename it merely to make a fresh v6 database appear.
- **Commands look stale:** global Discord commands can take time to propagate. Confirm version and registration mode before changing configuration.
- **A prior database exists under another name:** set `DB_FILE` explicitly and follow the schema workflow. Do not let a fresh database hide the existing one.
- **A workflow binding is stale:** use the relevant health/status and recovery command after verifying current channel/role permissions; do not paste an ID from another guild into the database.
- **Window closes immediately:** run the executable from an already-open PowerShell or Command Prompt window so the error remains visible.
