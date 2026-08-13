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
.\SuperiorBot.exe --diagnostics
```

`--check` loads `.env`, resolves the database path, and opens the bundled native SQLite module against memory. It does not log in to Discord and does not create `superior.db`.

`--diagnostics` also avoids Discord login. It reports the executable path/version, embedded payload version/hash, source identity, bundled Node version, payload-cache result, application root, configuration-file presence, database path and safe schema classification, and command-registration mode. It never prints the Discord token or private watcher values.

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

A missing or empty database is initialized as schema v8 on the first real startup. Normal startup never upgrades an older database.

Schema-v8 data can include Discord identifiers, delegated grants, persistent panel/message/channel/component bindings, ticket questions/answers and closure metadata, suggestion authors/content/votes/reviews, private staff-application answers/decisions, restricted-ping mappings/member cooldowns/audit actors, and bounded internal delivery identifiers. Protect the database, backups, exports, PowerShell history, and host account accordingly. Do not synchronize a live database through a consumer cloud-drive folder.

Run exactly one Superior process for one database. The Windows launcher holds named application-root and database locks for the child process lifetime, recovers locks abandoned by a crashed process, and refuses a second instance with the conflicting safe path. Its kill-on-close Job Object prevents a killed launcher from leaving an orphaned bundled Node writer after those locks release. The first Ctrl+C waits for Node's controlled drain; a second forces the launcher closed and terminates the child. Concurrent interactions inside that process are protected by SQLite constraints and transactions; two executables sharing the file are unsupported. The bot runs only while the process and computer are awake. Disable sleep or use a dedicated always-on host for continuous service.

## Portable ZIP and schema upgrades

The versioned portable ZIP is available from CI for offline database maintenance. It exposes bundled `runtime`, `app`, and `tools` directories plus their manifest and checksums. The single-file launcher exposes start, version, configuration check, safe diagnostics, and help operations.

Superior 6.0.0 refuses schema v7, v6, v5, v4, v3, and v2 during normal startup. Close every old `SuperiorBot.exe`, bundled `node.exe`, SQLite browser, and other process that can write the selected database. Extract the 6.0.0 portable ZIP, copy the database into that folder as `superior.db`, and keep the original untouched.

For the normal schema-v7 upgrade from Superior 5.5.0, run:

```powershell
New-Item -ItemType Directory -Path .\backups -Force
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 7
.\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v6-schema7.db --expect 7
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 8
.\SuperiorBot.exe --check
```

Do not continue if classification, backup, dry-run, migration, or final validation fails. The migration is one transaction; failure leaves the working copy at v7. It preserves every operational row and every stored panel, message, channel, workflow, and component identifier while converting guild settings to the active-by-default v3 model. Keep the validated v7 backup until the new executable and every guild's existing workflow has been reviewed.

Exact schema v6, schema v5, schema v4, schema v3, and the exact supported schema-v2 layout can migrate directly to v8 through the same CLI. Change the source checker and backup expectation to `--expect 6`, `--expect 5`, `--expect 4`, `--expect 3`, or `--expect 2`, use a generation-specific backup name, and keep the final checker at `--expect 8`. A failed transaction leaves the copy at its source generation. Historical conversion stages retain their documented behavior before the final v7-to-v8 settings conversion.

A schema-v1 database must first be upgraded to v2 with the final 4.0.0 source release. Renaming a database file never upgrades its contents. Never test migration against the only copy or against a database still selected by a running process.

## Post-upgrade review

After starting 6.0.0:

1. Check `/config status`; joined guilds should be active immediately unless an administrator intentionally used the emergency bot-state switch.
2. Review `/access list`; legacy migration creates no delegated grants.
3. Review `/panel status` and exercise one existing button for every posted panel type. A normal restart or migration never requires reposting.
4. Check the migrated `General Support` department and recover a representative active ticket before accepting new tickets.
5. Configure suggestions and application forms from current Discord resources; migration does not invent these bindings.
6. Review `/restrictedping list`, verify every retained role/channel pair, and test one disposable `/pingrole` notification plus its user/role cooldowns.
7. Test public suggestion voting and a private application in disposable records, confirming that application answers are visible only in the private review channel.
8. Confirm global command synchronization has registered `/pingrole` and `/restrictedping`; global propagation may take time after restart.

## Updating without a schema change

1. Stop the existing bot and confirm no `SuperiorBot.exe` or bundled `node.exe` remains running.
2. Create and validate a current schema-v8 backup with the portable backup/check tools.
3. Place the new `SuperiorBot.exe` in a new writable folder.
4. Copy only `.env` and the validated active database into the new folder.
5. Run `--version` and `--check`, then start it.
6. Keep the validated backup and prior artifact hash until verification succeeds, but do not start an older executable after migration. Old private runtime caches can be removed after the new version is verified and stopped.

For a 6.0.0 code rollback that retains schema v8, stop the process and use only a known-good 6.0.0 executable with a validated v8 backup. After an installation migrates to v8, never start, deploy, test, or recommend 5.5.0 or another older executable for it, even as part of incident recovery. Preserve the v8 database and use current-version recovery tooling or a forward fix. The 6.0.0 restore tooling accepts only v8 and cannot perform a release-level schema downgrade.

Before replacement, close the old console and confirm in Task Manager that neither the old `SuperiorBot.exe` nor its bundled `node.exe` remains. Keep the migrated database and its validated backups untouched until the replacement current-version build is verified.

## Troubleshooting

- **Missing `.env`:** copy `.env.example` beside the launcher and provide the token.
- **Configuration check fails:** read the single reported selector error; check guild registration mode and IDs without posting `.env` contents.
- **Native SQLite check fails:** remove only the matching private payload directory under `%LOCALAPPDATA%\SuperiorBot\payloads` and rerun the trusted executable. Do not copy `node_modules` from another Node version or operating system.
- **Startup refuses the database:** stop the executable, classify it with `check-cli.js`, and follow the explicit migration workflow. Never delete or rename it merely to make a fresh v8 database appear.
- **Commands look stale:** global Discord commands can take time to propagate. Confirm version and registration mode before changing configuration.
- **A prior database exists under another name:** set `DB_FILE` explicitly and follow the schema workflow. Do not let a fresh database hide the existing one.
- **A workflow binding is stale:** use the relevant health/status and recovery command after verifying current channel/role permissions; do not paste an ID from another guild into the database.
- **Window closes immediately:** run the executable from an already-open PowerShell or Command Prompt window so the error remains visible.
- **Another instance is already using the application root or database:** stop the old `SuperiorBot.exe` and bundled `node.exe`; an abandoned lock is recovered automatically after a crash, so do not delete database sidecars to bypass this message.
- **Build identity is unclear:** run `--version` and `--diagnostics`, inspect PE `FileVersion`/`ProductVersion` in file Properties, and compare `Get-FileHash .\SuperiorBot.exe -Algorithm SHA256` with the trusted release output.
