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
const bashAvailable =
  spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

function runBash(script: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      OPS_PATH: opsPath,
    },
  });
}

describe("operations safeguards", () => {
  it("keeps portable source-level deployment guards enabled", () => {
    const source = fs.readFileSync(opsPath, "utf8");
    const gitIgnore = fs.readFileSync(
      path.join(repoRoot, ".gitignore"),
      "utf8",
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(tsbotRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    const packageLock = JSON.parse(
      fs.readFileSync(path.join(tsbotRoot, "package-lock.json"), "utf8"),
    ) as { packages?: { ""?: { engines?: { node?: string } } } };

    expect(source).toContain("umask 077");
    expect(source).toContain("require_supported_node");
    expect(source).toContain("restrict_live_database_permissions");
    expect(source).toContain("git stash push -m");
    expect(source).not.toContain("--include-untracked");
    expect(source).toContain(
      "git merge --ff-only --no-overwrite-ignore FETCH_HEAD",
    );
    expect(source).not.toContain("git pull");
    expect(gitIgnore).toContain("*.env");
    expect(gitIgnore).toContain("*.db");
    expect(gitIgnore).toContain("*.sqlite3");
    expect(packageJson.engines?.node).toBe(">=22.12.0");
    expect(packageLock.packages?.[""]?.engines?.node).toBe(">=22.12.0");
  });

  it.skipIf(!bashAvailable)("passes Bash syntax validation", () => {
    const result = spawnSync("bash", ["-n", opsPath], {
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
      if (
        node() { printf '%s' '22.11.9'; }
        require_supported_node
      ) 2>"$rejection_log"; then
        exit 91
      fi
      grep -q 'Node.js 22.12.0 or newer is required; found 22.11.9' "$rejection_log"

      (
        node() { printf '%s' '22.12.0'; }
        require_supported_node
      )
      (
        node() { printf '%s' '23.0.0'; }
        require_supported_node
      )
    `);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.skipIf(!bashAvailable)(
    "stashes tracked source changes without moving operator files",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "courtbot-ops-stash-"),
      );
      try {
        const result = runBash(
          String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            if command -v cygpath >/dev/null 2>&1; then
              test_root="$(cygpath -u "$TEST_ROOT")"
            fi
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
            mkdir snapshots
            printf 'validated backup\n' > snapshots/known-good.sqlite3

            ensure_clean_or_handle_changes stash

            grep -qx baseline tracked.txt
            grep -qx 'live database' production.sqlite3
            grep -qx 'secret config' production.env
            grep -qx 'validated backup' snapshots/known-good.sqlite3
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
    "fails closed when an implicit database target has no environment file",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "courtbot-ops-env-"),
      );
      try {
        fs.mkdirSync(path.join(testRoot, "app", "tsbot"), {
          recursive: true,
        });
        const result = runBash(
          String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            if command -v cygpath >/dev/null 2>&1; then
              test_root="$(cygpath -u "$TEST_ROOT")"
            fi
            APP_DIR="$test_root/app"
            TSBOT_DIR=tsbot
            ENV_FILE=missing.env
            BACKUP_DIR=backups
            unset DB_FILE
            prepare_operation_paths
            resolve_runtime_db_file
          `,
          { TEST_ROOT: testRoot },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "Cannot resolve DB_FILE because the selected environment file does not exist",
        );
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "normalizes environment and database selectors exactly as the runtime does",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "courtbot-ops-db-path-"),
      );
      try {
        fs.mkdirSync(path.join(testRoot, "app", "tsbot"), {
          recursive: true,
        });
        const result = runBash(
          String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            if command -v cygpath >/dev/null 2>&1; then
              test_root="$(cygpath -u "$TEST_ROOT")"
            fi
            APP_DIR="$test_root/app"
            TSBOT_DIR=tsbot
            ENV_FILE='   '
            DB_FILE=$'\u00a0court.db\u00a0'
            BACKUP_DIR=backups
            prepare_operation_paths
            resolve_runtime_db_file
            [[ "$DB_FILE" == "$APP_DIR/court.db" ]]
            [[ "$ENV_FILE" == "$APP_DIR/.env" ]]
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
    "refuses to overwrite ignored operator files from a fetched branch",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "courtbot-ops-ignored-merge-"),
      );
      try {
        const result = runBash(
          String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            if command -v cygpath >/dev/null 2>&1; then
              test_root="$(cygpath -u "$TEST_ROOT")"
            fi
            mkdir -p "$test_root/seed"
            cd "$test_root/seed"
            git init --quiet --initial-branch=main
            git config user.email test@example.invalid
            git config user.name "Ops Regression"
            git config core.autocrlf false
            printf '*.sqlite3\n*.env\nbackups/\n' > .gitignore
            printf 'baseline\n' > tracked.txt
            git add .gitignore tracked.txt
            git commit --quiet -m baseline
            git clone --quiet --bare . "$test_root/remote.git"
            git clone --quiet "$test_root/remote.git" "$test_root/deploy"

            cd "$test_root/deploy"
            printf 'live database\n' > production.sqlite3
            printf 'secret config\n' > production.env
            mkdir backups
            printf 'validated backup\n' > backups/known-good.sqlite3

            cd "$test_root/seed"
            printf 'upstream database\n' > production.sqlite3
            printf 'upstream config\n' > production.env
            mkdir backups
            printf 'upstream backup\n' > backups/known-good.sqlite3
            git add -f production.sqlite3 production.env backups/known-good.sqlite3
            git commit --quiet -m collision
            git push --quiet "$test_root/remote.git" main

            cd "$test_root/deploy"
            git fetch --quiet --no-tags origin refs/heads/main
            fast_forward_fetched_branch
          `,
          { TEST_ROOT: testRoot },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Fast-forward refused");
        expect(
          fs.readFileSync(
            path.join(testRoot, "deploy", "production.sqlite3"),
            "utf8",
          ),
        ).toBe("live database\n");
        expect(
          fs.readFileSync(
            path.join(testRoot, "deploy", "production.env"),
            "utf8",
          ),
        ).toBe("secret config\n");
        expect(
          fs.readFileSync(
            path.join(testRoot, "deploy", "backups", "known-good.sqlite3"),
            "utf8",
          ),
        ).toBe("validated backup\n");
      } finally {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!bashAvailable)(
    "creates private files and restricts existing SQLite sidecars",
    () => {
      const testRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "courtbot-ops-mode-"),
      );
      try {
        const result = runBash(
          String.raw`
            source "$OPS_PATH"
            test_root="$TEST_ROOT"
            if command -v cygpath >/dev/null 2>&1; then
              test_root="$(cygpath -u "$TEST_ROOT")"
            fi
            database="$test_root/live.sqlite3"
            : > "$database"
            : > "$database-wal"
            : > "$database-shm"
            : > "$database-journal"
            chmod 666 "$database" "$database-wal" "$database-shm" "$database-journal"
            restrict_live_database_permissions "$database"
            for file in "$database" "$database-wal" "$database-shm" "$database-journal"; do
              [[ "$(stat -c '%a' "$file")" == "600" ]]
            done
            private_file="$test_root/created-under-umask"
            : > "$private_file"
            [[ "$(stat -c '%a' "$private_file")" == "600" ]]
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
});
