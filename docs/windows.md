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

You can also double-click the executable. The executable is not code-signed, so Windows SmartScreen may require an operator decision. Verify that it came from the repository or CI artifact before approving it.

## Files and persistence

The first run extracts the immutable application payload into `%LOCALAPPDATA%\SuperiorBot\payloads`. Do not put credentials or databases in that cache. The launcher always uses the directory containing the visible `SuperiorBot.exe` as the writable application root, regardless of its private runtime location or the current shell directory.

By default these writable files sit beside the launcher:

- `.env`: local credentials and selectors; never share it.
- `superior.db`: active SQLite database created on first real startup.
- SQLite sidecars such as `superior.db-wal` and `superior.db-shm` while running.

A missing or empty database is initialized as schema v4 on the first real startup. Normal startup never upgrades an older database.

Back up the database and any sidecars only through a SQLite-aware backup while the bot is running, or after fully stopping the bot. Do not synchronize a live database through a consumer cloud-drive folder.

The bot runs only while the process and laptop are awake. Disable sleep or use a dedicated always-on host for continuous service. Keep Windows and the executable patched, and keep Discord credentials access-controlled.

## Portable ZIP and schema upgrades

The versioned portable ZIP remains available from CI for offline database maintenance. It exposes the bundled `runtime`, `app`, and `tools` directories plus their manifest and checksums; the single-file launcher intentionally exposes only start, version, and configuration-check operations.

Version 5.2.0 refuses schema v3 and v2 during normal startup. Close every process that can write the source database, extract the current portable ZIP, copy the database into that folder as `superior.db`, and keep the original untouched. For the normal schema-v3 upgrade, run the bundled offline tools from PowerShell:

```powershell
New-Item -ItemType Directory -Path .\backups -Force
.\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v5.2-schema3.db --expect 3
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 4
.\SuperiorBot.exe --check
```

Do not continue if backup, dry-run, migration, or validation fails. A transaction failure leaves the copied database at v3. Keep the validated v3 backup until the new bot and every guild configuration, panel, and ticket resource has been reviewed.

The exact supported schema-v2 layout can migrate directly to v4 with the same commands: change the backup name to `pre-v5.2-schema2.db` and its expectation to `--expect 2`; keep the final checker at `--expect 4`. A failed transaction leaves that copy at v2. Schema-v2 conversion can mark unsafe settings for review and discard legacy rows with no active 5.2.0 consumer.

A schema-v1 database must first be upgraded to v2 with the final 4.0.0 source release. Renaming a database file never upgrades its contents.

## Updating

1. Stop the existing bot and confirm no `SuperiorBot.exe` or bundled `node.exe` remains running.
2. Back up and validate the current database.
3. Place the new `SuperiorBot.exe` in a new writable folder.
4. Copy only `.env` and the validated active database into the new folder.
5. Run `--version` and `--check`, then start it.
6. Keep the previous executable and backup until verification succeeds. Old private runtime caches can be removed after the new version is verified and stopped.

For a 5.2.0 rollback, stop the process and return to a known-good 5.2.0 folder with a compatible schema-v4 backup. Returning to 5.1.0 requires restoring the matching pre-migration schema-v3 backup. Returning to a schema-v2 application after a direct legacy migration requires its matching v2 backup. Never mix application and schema generations.

## Troubleshooting

- **Missing `.env`:** copy `.env.example` beside the launcher and provide the token.
- **Configuration check fails:** read the single reported selector error; check guild registration mode and IDs without posting `.env` contents.
- **Native SQLite check fails:** remove the matching private payload directory under `%LOCALAPPDATA%\SuperiorBot\payloads` and rerun the trusted executable. Do not copy `node_modules` from another Node version or operating system.
- **Commands look stale:** global Discord commands can take time to propagate. Confirm version and registration mode before changing configuration.
- **A prior database exists under another name:** set `DB_FILE` explicitly and follow the schema workflow. Do not let a fresh database hide the existing one.
- **Window closes immediately:** run the executable from an already-open PowerShell or Command Prompt window so the error remains visible.
