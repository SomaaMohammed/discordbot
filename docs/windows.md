# Windows guide

The repository-root `SuperiorBot.exe` is designed for a Windows x64 laptop or desktop. It contains a compiled Bun 1.4 application using Bun's built-in `bun:sqlite` in one self-extracting file. It does not require ZIP extraction, Node.js, a native SQLite add-on, or a separate Bun installation.

## First run

1. Put `SuperiorBot.exe` and a copy of `.env.example` in a writable folder.
2. In the Discord Developer Portal, enable Server Members Intent and Message Content Intent and install the application with the permissions described in [Configuration](configuration.md).
3. Rename the copied `.env.example` to `.env` beside `SuperiorBot.exe`.
4. Add `DISCORD_TOKEN` and leave `DB_FILE=superior.db` unless an absolute path is intentional.
5. If you are the deployment owner, set `BOT_OPERATOR_IDS` to your Discord ID to enable the visible, audited `/operator` recovery controls.
6. Open PowerShell 7 (`pwsh`) in that folder and run:

```powershell
.\SuperiorBot.exe --version
.\SuperiorBot.exe --check
.\SuperiorBot.exe --diagnostics
.\SuperiorBot.exe --doctor --json
```

`--check` loads `.env`, resolves the database path, and opens `bun:sqlite` against memory. It does not log in to Discord and does not create `superior.db`.

`--diagnostics` also avoids Discord login. It reports the executable path/version, embedded payload version/hash, source identity, compiled Bun and SQLite versions, `bun:sqlite` backend, payload-cache result, application root, configuration-file presence, database path and safe schema classification, and command-registration mode. It never prints the Discord token or private watcher values.

Start the bot with:

```powershell
.\SuperiorBot.exe
```

You can also double-click the executable. Production release artifacts are Authenticode-signed and timestamped; verify the signature, exact expected publisher, published SHA-256, and release provenance before running them. An explicitly labeled `unsigned-development` build is for local validation only and can trigger Windows SmartScreen. Never treat that development flag as a production exception.

## Files, privacy, and process boundaries

The first run extracts the immutable application payload into `%LOCALAPPDATA%\SuperiorBot\payloads`. Do not put credentials or databases in that cache. The launcher always uses the directory containing the visible `SuperiorBot.exe` as the writable application root, regardless of its private runtime location or the current shell directory.

By default these writable files sit beside the launcher:

- `.env`: local credentials and selectors; never share it.
- `superior.db`: the active SQLite database created on first real startup.
- SQLite sidecars such as `superior.db-wal` and `superior.db-shm` while running.

A missing or empty database is initialized as schema v11 on the first real startup. The packaged executable automatically validates, backs up, dry-runs, and upgrades supported schema v2-v10 databases before Discord login. Schema v1, malformed, partial, and unknown databases are refused without modification.

Schema-v11 data can include every existing Discord identifier and workflow record plus voting content, moderation case reasons/private notes, reporter/appellant identities and explanations, private review decisions, message-link identifiers, anti-spam metadata, administrator-authored rules and welcome/farewell templates, member acceptance/lifecycle timestamps, automatic/menu-role outcomes, and bounded delivery/audit records. It does not persist raw anti-spam message content, copy a report's referenced message, store member-message or direct-message contents for onboarding, or store full member profiles, IP/email/phone data, invite histories, or raw gateway payloads. Protect the database, backups, exports, PowerShell history, and host account accordingly. Do not synchronize a live database through a consumer cloud-drive folder.

Run exactly one Superior process for one database. The Windows launcher holds named application-root and database locks for the child process lifetime, recovers locks abandoned by a crashed process, and refuses a second instance with the conflicting safe path. Its kill-on-close Job Object prevents a killed launcher from leaving an orphaned compiled Bun writer after those locks release. The first Ctrl+C waits for Bun's controlled drain; a second forces the launcher closed and terminates the child. Concurrent interactions inside that process are protected by SQLite constraints and transactions; two executables sharing the file are unsupported. The bot runs only while the process and computer are awake. Disable sleep or use a dedicated always-on host for continuous service.

## Portable ZIP and schema upgrades

The versioned portable ZIP is available from CI for offline database maintenance. Its immutable `app` directory contains only the compiled `SuperiorBot.Runtime.exe`; no interpreter, `node_modules`, or native SQLite add-on is shipped. The single-file launcher exposes start, version, configuration check, safe diagnostics, doctor, WAL checkpoint, backup rotation/restore drill, and help operations. For example:

```powershell
.\SuperiorBot.exe --doctor --json
.\SuperiorBot.exe --doctor --write-probes --json
.\SuperiorBot.exe --checkpoint --mode passive --json
.\SuperiorBot.exe --backup-rotate --retention 7 --json
```

The launcher acquires the same database lock for doctor and maintenance commands as it does for startup, and none of these commands logs in to Discord. Set `SUPERIOR_BACKUP_DIR` in the adjacent `.env` to select a confined backup directory. Doctor is read-only unless `--write-probes` is explicit. Passive checkpointing is the routine diagnostic choice; `full`, `restart`, and `truncate` can wait on readers or disrupt concurrent work and belong in a controlled maintenance window. Backup rotation is suitable for an external scheduler, but the package creates no scheduled task.

The portable release also includes `Update.exe`. It updates an installed `SuperiorBot.exe` from a newly built executable without moving `.env`, the active database, or their backups. In production mode the updater verifies its own signature, the candidate hash/manifest and Authenticode signature, the exact expected publisher, and the installed replacement before it can execute. It refuses to replace a running bot, creates an executable backup, validates the replacement with `--version` and `--check`, rolls back a failed replacement, and starts the new bot unless `--no-start` is supplied.

The packaged executable automatically handles schema upgrades. Close every old `SuperiorBot.exe`, any child runtime from an older release, SQLite browser, and other process that can write the selected database. Put the current `SuperiorBot.exe`, `.env`, and database in a writable folder and keep the original database untouched until the first launch succeeds.

When the database is exact schema v2-v10, launch `SuperiorBot.exe`. Before Discord login it validates the source, creates a timestamped SQLite-aware backup in `backups`, performs a complete dry-run, applies the migration to v11, validates the result, and then starts the bot. A failure stops startup, retains the backup, and leaves the source at its original schema. The migration preserves existing rows and external Discord IDs, adds the applicable empty/default-disabled workflow and voting tables, invents no history or bindings, and performs no Discord delivery or role mutation.

Schema v1 must first be upgraded to v2 with the final 4.0.0 source release. Unknown, malformed, and partial databases are refused without modification. Maintenance CLIs run under Bun from source; the packaged application never invokes Node or a Windows command shim.

Live backups use a readonly `bun:sqlite` connection and bound `VACUUM INTO`, validate the source and result, flush the file, and atomically publish without overwriting an existing destination. The destination must be a trusted local non-reparse directory on a hard-link-capable filesystem such as NTFS. FAT/exFAT and some network shares fail closed. Windows file flushing does not provide a Unix-style directory fsync guarantee, so keep multiple protected generations and perform restore drills.

## Authenticode release policy

`windows/release-build.ps1` is production-only and fails closed unless it receives exactly one externally provisioned signing identity, the exact expected publisher and signer thumbprint, a trusted timestamp URL, and a usable Windows SDK `signtool.exe`. Unsigned reproducibility output and production candidates stay in verified temporary directories; canonical release paths are published only after every production signature and smoke check succeeds. It signs and verifies `SuperiorBot.Runtime.exe`, `Update.exe`, and `SuperiorBot.exe` before packaging and verifies the completed portable and standalone layouts again. Choose either a certificate already installed in the Current User or Local Machine store:

```powershell
pwsh -NoProfile -File .\windows\release-build.ps1 `
  -SigningCertificateThumbprint '<40-hex-thumbprint>' `
  -ExpectedPublisher 'CN=Exact Publisher' `
  -ExpectedSignerThumbprint '<40-hex-thumbprint>' `
  -SigningTimestampUrl 'https://timestamp.digicert.com' `
  -SignToolPath 'C:\Program Files (x86)\Windows Kits\10\bin\<sdk>\x64\signtool.exe'
```

Or provide a PFX path and inject its password through the protected `SUPERIOR_SIGNING_PFX_PASSWORD` environment/CI secret. Set `SUPERIOR_SIGNING_EXPECTED_THUMBPRINT` independently to the trusted certificate's 40-hex SHA-1 thumbprint; the verifier never derives this trust anchor from the PFX or produced artifact. The script never accepts the password as a command-line argument and never records it. A temporarily imported PFX certificate is non-exportable and removed in `finally`; production use should still prefer a short-lived CI runner or managed certificate store.

`BUILD-INFO.txt` records safe toolchain, source, runtime, and signing provenance. Final verification requires the checksum sidecar, exact artifact inventory, strict manifest and build metadata, byte-identical external/portable updater, and a standalone embedded-payload hash equal to the published ZIP. It rejects unsigned, invalid/tampered, untrusted, untimestamped, expired-without-valid-timestamp, wrong-certificate, or wrong-publisher executables. The compiled launcher and updater enforce the exact embedded certificate thumbprint as well as the publisher and timestamp. `bun run package:win` is the explicit unsigned-development path; it writes beneath ignored `windows/.artifacts/development`, never replaces repository-root release executables, remains visibly unsigned, and is not a releasable artifact.

On a signing-enabled Windows CI runner, run `windows/test-signing.ps1` with a Windows SDK signing tool. It creates random ephemeral code-signing certificates, trusts only their public test certificates for the test duration, exercises valid/unsigned/wrong-publisher/wrong-certificate/tampered/expired/untrusted cases and updater rollback, and removes the private certificate material and trust entries in `finally`.

Renaming a database file never upgrades its contents. Never test migration against the only copy or against a database still selected by a running process.

## Post-upgrade review

After starting the schema-v11 release:

1. Check `/config status`; joined guilds should be active immediately unless an administrator intentionally used the emergency bot-state switch.
2. Review `/access list`; legacy migration creates no delegated grants.
3. Review `/panel status` and exercise one existing button for every legacy posted panel type. A normal restart or migration never requires reposting; new `verification` and `roles` presets remain absent or unhealthy until configured from current resources.
4. Check the migrated `General Support` department and recover a representative active ticket before accepting new tickets.
5. Configure suggestions and application forms from current Discord resources; migration does not invent these bindings.
6. Review `/restrictedping list`, verify every retained role/channel pair, and test one disposable `/pingrole` notification plus its user/role cooldowns.
7. Test public suggestion voting and a private application in disposable records, confirming that application answers are visible only in the private review channel.
8. Confirm global command synchronization has registered `/pingrole`, `/restrictedping`, `/moderation`, `/report`, `/appeal`, `/automod`, `/onboarding`, and `/rolemenu`; global propagation may take time after restart.
9. Confirm `/moderation status` and `/automod status` show new services/rules disabled with no invented historical cases.
10. Configure moderation, report, and appeal destinations from current private Discord resources, test disposable review records, then post the safety panel if wanted.
11. Test one conservative anti-spam rule in a disposable channel before enabling it more broadly; verify exemptions, cooldowns, case creation, and that message edits are not enforced.
12. Confirm `/onboarding status` shows welcome/farewell, verification, human/bot automatic roles, and private lifecycle delivery disabled with no invented member history.
13. Configure current lifecycle channels, rules, and safe verification roles. Test a disposable human join, a bot join, and a member pending Discord Membership Screening; no human or verification role may be assigned until native screening completes.
14. Create one disabled disposable `/rolemenu`, add only safe current roles, inspect and enable it, post it, then verify its mode/selection bounds and prerequisite. Confirm role-panel messages posted by older releases retain their prior behavior.

## Updating without a schema change

1. Build or download a production-signed `SuperiorBot.exe`; verify its exact publisher, timestamp, and published SHA-256 hash.
2. Copy `Update.exe` into the installed bot folder if it is not already there.
3. Stop the existing bot and confirm no `SuperiorBot.exe` or child runtime from the prior release remains running.
4. Verify that the adjacent `Update.exe` has the same expected production publisher. From the installed bot folder, run `Update.exe --source C:\path\to\new\SuperiorBot.exe --sha256 <published-hash>`. Use `--no-start` to skip automatic restart.
5. The updater replaces only the executable, preserves `.env` and the active database in place, creates a timestamped executable backup under `backups`, runs `--version` and `--check`, and starts the new release.
6. Keep the generated backup and prior artifact until verification succeeds. Do not start an older executable after migration.

For a code rollback that retains schema v11, stop the process and use only a known-good schema-v11-capable executable with a validated v11 backup. After an installation migrates to v11, never start, deploy, or test a pre-v11 executable against it, even as part of incident recovery. Preserve the v11 database and use current-version recovery tooling or a forward fix. Current restore tooling accepts only v11 and cannot perform a release-level schema downgrade.

Before replacement, close the old console and confirm in Task Manager that neither the old `SuperiorBot.exe` nor its child runtime remains. Keep the migrated database and its validated backups untouched until the replacement current-version build is verified.

## Troubleshooting

- **Missing `.env`:** copy `.env.example` beside the launcher and provide the token.
- **Configuration check fails:** read the single reported selector error; check guild registration mode and IDs without posting `.env` contents.
- **`bun:sqlite` check fails:** remove only the matching private payload directory under `%LOCALAPPDATA%\SuperiorBot\payloads` and rerun the trusted executable. Do not add an external SQLite module or copy files from another build.
- **Startup refuses the database:** keep the generated backup, read the single error, and stop. The executable refuses corrupt, unknown, partial, and schema-v1 files rather than overwriting them. Never delete or rename a database to make a fresh v11 database appear.
- **Commands look stale:** global Discord commands can take time to propagate. Confirm version and registration mode before changing configuration.
- **A prior database exists under another name:** set `DB_FILE` explicitly and follow the schema workflow. Do not let a fresh database hide the existing one.
- **An onboarding or menu binding is stale:** inspect `/onboarding status`, `/rolemenu status`, and `/panel status`; replace deleted resources through configuration, then use the bounded member/menu recovery path. Imported automatic roles, verification, and menus stay disabled until current roles/channels/messages and permissions are verified. Do not paste an ID from another guild into the database.
- **Window closes immediately:** run the executable from an already-open PowerShell 7 or Command Prompt window so the error remains visible.
- **Another instance is already using the application root or database:** stop the old `SuperiorBot.exe` and its child runtime; an abandoned lock is recovered automatically after a crash, so do not delete database sidecars to bypass this message.
- **Build identity is unclear:** run `--version` and `--diagnostics`, inspect PE `FileVersion`/`ProductVersion` in file Properties, and compare `Get-FileHash .\SuperiorBot.exe -Algorithm SHA256` with the trusted release output.
