import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsbotRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(tsbotRoot, "..");
const opsPath = path.join(repoRoot, "ops.sh");
const bashExecutable =
  process.platform === "win32" &&
  fs.existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe"
    : "bash";
const bashAvailable =
  spawnSync(bashExecutable, ["--version"], { stdio: "ignore" }).status === 0;

function runBash(script: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(bashExecutable, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment, OPS_PATH: opsPath },
  });
}

describe("operations safeguards", () => {
  it("keeps deployment, database, migration, and restore guards enabled", () => {
    const source = fs.readFileSync(opsPath, "utf8");
    const gitIgnore = fs.readFileSync(
      path.join(repoRoot, ".gitignore"),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(tsbotRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };

    expect(source).toContain("umask 077");
    expect(source).toContain("require_supported_node");
    expect(source).toContain("restrict_live_database_permissions");
    expect(source).toContain("git stash push -m");
    expect(source).not.toContain("--include-untracked");
    expect(source).toContain(
      "git merge --ff-only --no-overwrite-ignore FETCH_HEAD",
    );
    expect(source).not.toContain("git pull");
    expect(source).toContain('validate_database "$candidate" 7');
    expect(source).toContain("Database restored atomically");
    expect(source).toContain('rollback_dir="$db_dir/.superior-rollback.$$.d"');
    expect(source).toContain('"$rollback_dir/original.db"');
    expect(source).toContain('"$rollback_dir/rejected-candidate.db"');
    expect(source).not.toContain('for saved in "$rollback_dir"/*');
    expect(source).toContain('"$source" -ef "$DB_FILE"');
    expect(source).toContain("backup-cli.js");
    expect(source).toContain("automatic recovery was incomplete");
    expect(source).toContain("migrate-v7) migrate_database_to_v7 6");
    expect(source).toContain("migrate-v6) migrate_database_to_v7 5");
    expect(source).toContain("migrate-v4) migrate_database_to_v7 4");
    expect(source).toContain("migrate-v3) migrate_database_to_v7 3");
    expect(source).toContain("migrate-v2) migrate_database_to_v7 2");
    expect(source).toContain("migrate-cli.js");
    expect(source).toContain(
      "validated schema-v${source_schema} backup was retained and the service remains stopped",
    );
    expect(gitIgnore).toContain("*.env");
    expect(gitIgnore).toContain("*.db");
    expect(gitIgnore).toContain("*.sqlite3");
    expect(packageJson.engines?.node).toBe(">=22.12.0");
  });

  it.skipIf(!bashAvailable)("passes Bash syntax validation", () => {
    const result = spawnSync(bashExecutable, ["-n", opsPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.skipIf(!bashAvailable)("enforces the exact minimum Node version", () => {
    const result = runBash(String.raw`
      source "$OPS_PATH"
      rejection_log="$(mktemp)"
      trap 'rm -f -- "$rejection_log"' EXIT
      if (node() { printf '%s' '22.11.9'; }; require_supported_node) 2>"$rejection_log"; then
        exit 91
      fi
      grep -q 'Node.js 22.12.0 or newer is required; found 22.11.9' "$rejection_log"
      (node() { printf '%s' '22.12.0'; }; require_supported_node)
      (node() { printf '%s' '23.0.0'; }; require_supported_node)
    `);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.skipIf(!bashAvailable)(
    "stashes tracked changes without moving operator files",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-stash-"),
      );
      try {
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          cd "$test_root"
          git init --quiet
          git config user.email test@example.invalid
          git config user.name "Ops Regression"
          git config core.autocrlf false
          printf 'baseline\n' > tracked.txt
          git add tracked.txt
          git commit --quiet -m initial
          printf 'modified\n' > tracked.txt
          printf 'live database\n' > production.sqlite3
          printf 'secret config\n' > production.env
          ensure_clean_or_handle_changes stash
          grep -qx baseline tracked.txt
          grep -qx 'live database' production.sqlite3
          grep -qx 'secret config' production.env
          git diff --quiet
          git diff --cached --quiet
          git stash list | grep -q deploy-autostash-
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "fails closed when an implicit database has no env file",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-env-"),
      );
      try {
        fs.mkdirSync(path.join(testRoot, "app", "tsbot"), { recursive: true });
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          APP_DIR="$test_root/app"
          TSBOT_DIR=tsbot
          ENV_FILE=missing.env
          BACKUP_DIR=backups
          DB_FILE_EXPLICIT=0
          unset DB_FILE
          prepare_operation_paths
          resolve_runtime_db_file
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Cannot resolve DB_FILE");
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "refuses to strand the former default database",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-upgrade-"),
      );
      try {
        fs.mkdirSync(path.join(testRoot, "app", "tsbot"), { recursive: true });
        fs.writeFileSync(path.join(testRoot, "app", ".env"), "DB_FILE=\n");
        // Synthetic filename-only sentinel; it is never opened as a database.
        fs.writeFileSync(path.join(testRoot, "app", "court.db"), "synthetic\n");
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          APP_DIR="$test_root/app"
          TSBOT_DIR=tsbot
          ENV_FILE=.env
          DB_FILE_EXPLICIT=0
          unset DB_FILE
          prepare_operation_paths
          resolve_runtime_db_file
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Set DB_FILE explicitly");
        expect(
          fs.readFileSync(path.join(testRoot, "app", "court.db"), "utf8"),
        ).toBe("synthetic\n");
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "creates private files and restricts SQLite sidecars",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-mode-"),
      );
      try {
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          database="$test_root/live.sqlite3"
          : > "$database"; : > "$database-wal"; : > "$database-shm"; : > "$database-journal"
          chmod 666 "$database" "$database-wal" "$database-shm" "$database-journal"
          restrict_live_database_permissions "$database"
          for file in "$database" "$database-wal" "$database-shm" "$database-journal"; do
            [[ "$(stat -c '%a' "$file")" == "600" ]]
          done
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "refuses to restore from the live database itself",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-restore-source-"),
      );
      try {
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          APP_DIR="$test_root"
          TSBOT_DIR="$test_root/tsbot"
          BACKUP_DIR="$test_root/backups"
          DB_FILE="$test_root/live.db"
          mkdir -p -- "$TSBOT_DIR" "$BACKUP_DIR"
          : > "$DB_FILE"
          prepare_operation_paths() { :; }
          resolve_runtime_db_file() { :; }
          require_supported_node() { :; }
          acquire_operation_lock() { :; }
          ensure_production_build() { :; }
          if restore_database "$DB_FILE"; then
            exit 91
          fi
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toContain(
          "Restore source must not be the live database",
        );
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "leaves the service stopped after a failed v2-to-v7 migration",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "superior-ops-migrate-failure-"),
      );
      try {
        const result = runBash(
          String.raw`
          source "$OPS_PATH"
          test_root="$TEST_ROOT"
          command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
          DB_FILE="$test_root/live.db"
          TSBOT_DIR="$test_root/tsbot"
          mkdir -p -- "$TSBOT_DIR/dist/src/storage"
          : > "$DB_FILE"
          prepare_operation_paths() { :; }
          resolve_runtime_db_file() { :; }
          require_supported_node() { :; }
          acquire_operation_lock() { :; }
          ensure_production_build() { :; }
          validate_database() { :; }
          create_database_backup() { :; }
          restrict_live_database_permissions() { :; }
          service_is_active() { return 0; }
          stop_service() { :; }
          start_service() { : > "$test_root/restarted"; }
          node() { return 1; }
          if migrate_database_to_v7 2; then
            exit 91
          fi
          [[ ! -e "$test_root/restarted" ]]
        `,
          { TEST_ROOT: testRoot },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("service remains stopped");
        expect(fs.existsSync(path.join(testRoot, "restarted"))).toBe(false);
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  for (const databaseBasename of [".hidden.db", "rejected-restore.db"]) {
    it.skipIf(!bashAvailable)(
      `recovers a prior ${databaseBasename} after restore validation fails`,
      () => {
        const testRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "superior-ops-restore-rollback-"),
        );
        try {
          fs.mkdirSync(path.join(testRoot, "tsbot"), { recursive: true });
          fs.writeFileSync(path.join(testRoot, "backup.db"), "candidate\n");
          fs.writeFileSync(
            path.join(testRoot, databaseBasename),
            "original-main\n",
          );
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            fs.writeFileSync(
              path.join(testRoot, `${databaseBasename}${suffix}`),
              `original${suffix}\n`,
            );
          }

          const result = runBash(
            String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            command -v cygpath >/dev/null 2>&1 && test_root="$(cygpath -u "$TEST_ROOT")"
            APP_DIR="$test_root"
            TSBOT_DIR="$test_root/tsbot"
            BACKUP_DIR="$test_root/backups"
            DB_FILE="$test_root/$DB_BASENAME"
            source_backup="$test_root/backup.db"
            prepare_operation_paths() { :; }
            resolve_runtime_db_file() { :; }
            require_supported_node() { :; }
            acquire_operation_lock() { :; }
            ensure_production_build() { :; }
            service_is_active() { return 1; }
            restrict_live_database_permissions() { :; }
            node() {
              local backup_source="" backup_output=""
              while (( $# > 0 )); do
                case "$1" in
                  --db) backup_source="$2"; shift 2 ;;
                  --out) backup_output="$2"; shift 2 ;;
                  *) shift ;;
                esac
              done
              cp -- "$backup_source" "$backup_output"
            }
            validation_count=0
            validate_database() {
              validation_count=$((validation_count + 1))
              (( validation_count != 2 )) && [[ -f "$1" ]]
            }
            if restore_database "$source_backup"; then
              exit 91
            fi
            grep -qx original-main "$DB_FILE"
            grep -qx original-wal "$DB_FILE-wal"
            grep -qx original-shm "$DB_FILE-shm"
            grep -qx original-journal "$DB_FILE-journal"
            set -- "$test_root"/.superior-rollback.*.d
            (( $# == 1 ))
            rollback_dir="$1"
            [[ -d "$rollback_dir" ]]
            grep -qx candidate "$rollback_dir/rejected-candidate.db"
            [[ ! -e "$rollback_dir/original.db" ]]
          `,
            { DB_BASENAME: databaseBasename, TEST_ROOT: testRoot },
          );
          expect(result.status).toBe(0);
          expect(result.stderr).toContain(
            "Restore failed; the previous database was restored",
          );
        } finally {
          fs.rmSync(testRoot, { recursive: true, force: true });
        }
      },
    );
  }
});
