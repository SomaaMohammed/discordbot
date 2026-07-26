# Imperial Court Bot Operations

This runbook covers the TypeScript deployment for systemd service `imperial-court-bot`.

## 1) SSH to VM

```bash
gcloud compute ssh YOUR_VM_NAME --zone YOUR_ZONE
```

## 2) Deploy Latest Code

```bash
cd ~/imperial-court-bot
RUN_TESTS=1 RUN_TYPECHECK=1 bash ./ops.sh deploy main
```

What this does:

- pulls latest branch tip (`git fetch` + `git pull --ff-only`)
- installs npm dependencies in `tsbot/`
- builds TypeScript (`npm run build`)
- optionally runs typecheck/tests
- restarts `imperial-court-bot`
- prints service status and recent logs

Useful deployment flags:

```bash
# safer local-change handling before pull
LOCAL_CHANGES_POLICY=stash bash ./ops.sh deploy main

# rollout current checkout only (skip fetch/pull)
SKIP_PULL=1 RUN_TESTS=1 RUN_TYPECHECK=1 bash ./ops.sh deploy

# preflight build/validation only (no systemd restart)
SKIP_PULL=1 SKIP_SERVICE_RESTART=1 RUN_TESTS=1 RUN_TYPECHECK=1 bash ./ops.sh deploy
```

## 3) Service Control

Restart service:

```bash
sudo systemctl restart imperial-court-bot
```

Check status:

```bash
sudo systemctl status imperial-court-bot --no-pager
```

Live logs:

```bash
sudo journalctl -u imperial-court-bot -f
```

Recent logs:

```bash
sudo journalctl -u imperial-court-bot -n 120 --no-pager
```

## 4) SQLite Health Checks

Go to app directory:

```bash
cd ~/imperial-court-bot
```

List tables:

```bash
sqlite3 court.db ".tables"
```

Expected tables:

- `kv`
- `posts`
- `answers`
- `metrics`
- `anon_cooldowns`

## 5) Backups

Create validated backup:

```bash
bash ./ops.sh backup
```

Backup location:

- `~/imperial-court-bot/backups/`

Daily backup cron example (03:15 UTC):

```cron
15 3 * * * cd ~/imperial-court-bot && bash ./ops.sh backup >> backup.log 2>&1
```

## 6) Restore From Backup

1. Stop bot service:

```bash
sudo systemctl stop imperial-court-bot
```

2. Restore from backup:

```bash
bash ./ops.sh restore ~/imperial-court-bot/backups/court-YYYYMMDD-HHMMSS.db
```

3. Start service:

```bash
sudo systemctl start imperial-court-bot
```

4. Verify status/logs:

```bash
sudo systemctl status imperial-court-bot --no-pager
sudo journalctl -u imperial-court-bot -n 120 --no-pager
```

## 7) Quick Incident Checklist

1. `sudo systemctl status imperial-court-bot --no-pager`
2. `sudo journalctl -u imperial-court-bot -n 120 --no-pager`
3. `cd ~/imperial-court-bot && RUN_TESTS=1 RUN_TYPECHECK=1 bash ./ops.sh deploy main`
4. `sqlite3 court.db ".tables"`
5. If DB corruption is suspected, restore latest validated backup and restart service.

## 8) Optional GCS Upload for Backups

If `gsutil` is installed:

```bash
export GCS_BUCKET=your-bucket-name
bash ./ops.sh backup
```
