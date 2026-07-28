# Windows portable guide

The Windows x64 ZIP is designed for a laptop or desktop and includes `SuperiorBot.exe`, a command-file fallback, an exact Node.js runtime, compiled application files, production dependencies, `.env.example`, a guide, and checksums. It does not require a separate Node.js installation.

## First run

1. Extract the entire `SuperiorBot-5.0.0-win-x64` folder to a writable location. Do not run directly inside the ZIP.
2. In the Discord Developer Portal, enable Server Members Intent and Message Content Intent and install the application with the permissions described in [Configuration](configuration.md).
3. Copy `.env.example` to `.env` in the extracted folder.
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

You can also double-click the executable. If local application-control policy blocks it, use `Start Superior Bot.cmd`; both launchers run the same bundled application. The executable is not code-signed, so Windows SmartScreen may require an operator decision. Verify the ZIP SHA-256 and `MANIFEST.sha256` before approving it.

## Files and persistence

Keep `SuperiorBot.exe`, `Start Superior Bot.cmd`, `runtime/`, `app/`, and `tools/` together. The launcher always uses its own directory as the application root, regardless of the current shell directory.

By default these writable files sit beside the launcher:

- `.env`: local credentials and selectors; never share it.
- `superior.db`: active SQLite database created on first real startup.
- SQLite sidecars such as `superior.db-wal` and `superior.db-shm` while running.

Back up the database and any sidecars only through a SQLite-aware backup while the bot is running, or after fully stopping the bot. Do not synchronize a live database through a consumer cloud-drive folder.

The bot runs only while the process and laptop are awake. Disable sleep or use a dedicated always-on host for continuous service. Keep Windows, the ZIP, and Discord credentials patched and access-controlled.

## Upgrade an existing schema-v2 database

Version 5 refuses schema v2 during normal startup. Close every process that can write the source database, copy it into the extracted v5 folder as `superior.db`, and keep the original untouched. Then run the bundled offline tools from PowerShell:

```powershell
New-Item -ItemType Directory -Path .\backups -Force
.\runtime\node.exe .\app\dist\src\storage\backup-cli.js --db .\superior.db --out .\backups\pre-v5-schema2.db --expect 2
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db --dry-run
.\runtime\node.exe .\app\dist\src\storage\migrate-cli.js --db .\superior.db
.\runtime\node.exe .\app\dist\src\storage\check-cli.js --db .\superior.db --expect 3
.\SuperiorBot.exe --check
```

Do not continue if backup, dry-run, migration, or validation fails. A transaction failure leaves the copied database at v2. Keep the validated v2 backup until the new bot and every guild configuration have been reviewed.

A schema-v1 database must first be upgraded to v2 with the final 4.0.0 source release. Renaming a database file never upgrades its contents.

## Updating the portable folder

1. Stop the existing bot and confirm no `SuperiorBot.exe` or bundled `node.exe` remains running.
2. Back up and validate the current database.
3. Extract the new release to a new folder.
4. Copy only `.env` and the validated active database into the new folder. Do not merge old `app/`, `runtime/`, or `tools/` directories.
5. Verify the new archive/checksum, run `--version` and `--check`, then start it.
6. Keep the previous complete folder and backup until verification succeeds.

For a v5 rollback, stop the process and return to a known-good v5 folder with a compatible schema-v3 backup. Returning to v4 also requires restoring the matching pre-migration schema-v2 backup; never mix application and schema generations.

## Troubleshooting

- **Missing `.env`:** copy `.env.example` beside the launcher and provide the token.
- **Configuration check fails:** read the single reported selector error; check guild registration mode and IDs without posting `.env` contents.
- **Native SQLite check fails:** re-extract the full x64 ZIP. Do not copy `node_modules` from another Node version or operating system.
- **Commands look stale:** global Discord commands can take time to propagate. Confirm version and registration mode before changing configuration.
- **A prior database exists under another name:** set `DB_FILE` explicitly and follow the schema workflow. Do not let a fresh database hide the existing one.
- **Window closes immediately:** run either launcher from an already-open PowerShell or Command Prompt window so the error remains visible.
