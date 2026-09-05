# Linux operations checklist

Use this with [Linux deployment](linux-deployment.md). Check every item for the environment being operated; development, staging, and production must not share secrets, databases, or service users.

## Before first production start

- [ ] Debian 12 or Ubuntu 24.04, systemd, local ext4/XFS, and required packages are installed.
- [ ] `/opt/superior/.bun/bin/bun --version` prints `1.4.0`.
- [ ] `bun install --frozen-lockfile`, formatting, typecheck, tests, build, and security checks passed on Linux.
- [ ] `superior` is a non-root service account; releases are immutable and mutable data is outside the release.
- [ ] `/etc/superior/superior.env` is root-owned, `superior`-group-readable, mode `0640`, and contains no placeholder token.
- [ ] `validate-service.sh --health-only` passes without attempting Discord login.
- [ ] The existing database is validated, backed up, and explicitly migrated to schema 11 if required.
- [ ] A restore drill has been completed with a disposable staging database.
- [ ] The sanitized doctor/manifest report contains no secret, hostname, IP,
      username, or database content.

## Every upgrade

- [ ] Build and test the candidate on Linux; do not reuse Windows `node_modules` or `dist`.
- [ ] Stage with `update.sh` and confirm the release contains production dependencies only.
- [ ] Keep a validated pre-deploy schema-11 backup.
- [ ] Activate once, inspect `systemctl` and `journalctl`, then run service validation.
- [ ] Keep the previous release and rollback link until the application and guild checks pass.
- [ ] If unhealthy, run the explicit schema-compatible rollback and preserve logs for review.

## Server migration

- [ ] Export is run with the service stopped; no live main file or SQLite sidecar is copied.
- [ ] The standalone backup and `.manifest` are hash-verified before and after transfer.
- [ ] The new server has a separately created protected environment file.
- [ ] Import targets an empty data directory and refuses to overwrite any existing file.
- [ ] The imported database passes offline schema, integrity, and doctor checks before cutover.
- [ ] The old server is retained until the new backup, service, and guild checks pass.

## Daily/periodic operations

- [ ] Check service active state, restart-loop counters, journal errors, and disk/free-inode capacity.
- [ ] Run the offline doctor/readiness check; do not use the bot entrypoint as a health probe.
- [ ] Run a validated backup and verify it with `verify-backup.sh`.
- [ ] Rotate only validated managed backups with an explicit retention policy; preserve off-host copies.
- [ ] Run a checkpoint when WAL growth warrants it; treat a busy passive checkpoint as an active-reader signal.
- [ ] Review environment, database, sidecar, and backup permissions after migrations or restores.

## Incident guardrails

- [ ] Stop the service before restore or migration; never copy a live SQLite main file without its SQLite-aware backup path.
- [ ] Never run more than one writer against the database.
- [ ] Never log, paste, or attach `DISCORD_TOKEN`, `.env`, database, backup, or private workflow content.
- [ ] Never use a pre-v11 executable against a schema-11 database.
- [ ] Preserve the current database, rollback directory, validated backup, release directories, and journal evidence until recovery is verified.
