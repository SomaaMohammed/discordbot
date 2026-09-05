import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProcessConfig,
  resolveDatabaseFile,
  resolveEnvironmentFile,
} from "../src/config.js";
import { isSecureEnvironmentFileMode } from "../src/storage/filesystem-safety.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const linuxDeploymentRoot = path.join(repositoryRoot, "deploy", "linux");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Linux deployment boundary", () => {
  it("resolves database and environment paths from the application root", () => {
    const root = makeRoot();
    const otherWorkingDirectory = makeRoot();
    const originalWorkingDirectory = process.cwd();
    const previousDatabase = process.env.DB_FILE;
    const previousEnvironment = process.env.ENV_FILE;
    try {
      process.env.DB_FILE = "state/superior.db";
      process.env.ENV_FILE = "config/production.env";
      process.chdir(otherWorkingDirectory);

      expect(resolveDatabaseFile(root)).toBe(
        path.join(root, "state", "superior.db"),
      );
      expect(resolveEnvironmentFile(root)).toBe(
        path.join(root, "config", "production.env"),
      );
    } finally {
      process.chdir(originalWorkingDirectory);
      restoreEnvironment("DB_FILE", previousDatabase);
      restoreEnvironment("ENV_FILE", previousEnvironment);
    }
  });

  it("fails closed for missing and malformed environment files", () => {
    const root = makeRoot();
    const previous = snapshotEnvironment([
      "DISCORD_TOKEN",
      "COMMAND_REGISTRATION_MODE",
      "DEV_GUILD_IDS",
      "BOT_OPERATOR_IDS",
      "ENV_FILE",
    ]);
    try {
      delete process.env.DISCORD_TOKEN;
      delete process.env.COMMAND_REGISTRATION_MODE;
      delete process.env.DEV_GUILD_IDS;
      delete process.env.BOT_OPERATOR_IDS;
      process.env.ENV_FILE = path.join(root, "missing.env");
      expect(() => loadProcessConfig(root)).toThrow(/DISCORD_TOKEN/u);

      const malformed = path.join(root, "malformed.env");
      fs.writeFileSync(
        malformed,
        "DISCORD_TOKEN=offline-test-token\nCOMMAND_REGISTRATION_MODE=remote\n",
        "utf8",
      );
      process.env.ENV_FILE = malformed;
      expect(() => loadProcessConfig(root)).toThrow(
        /COMMAND_REGISTRATION_MODE must be global or guild/u,
      );
    } finally {
      restoreEnvironmentSnapshot(previous);
    }
  });

  it("rejects unsafe POSIX environment-file permissions", () => {
    expect(isSecureEnvironmentFileMode(0o600, "linux")).toBe(true);
    expect(isSecureEnvironmentFileMode(0o640, "linux")).toBe(true);
    expect(isSecureEnvironmentFileMode(0o644, "linux")).toBe(false);
    expect(isSecureEnvironmentFileMode(0o660, "linux")).toBe(false);
    expect(isSecureEnvironmentFileMode(0o4000, "linux")).toBe(false);
  });

  it("keeps offline health checks away from the Discord entrypoint", () => {
    const validator = fs.readFileSync(
      path.join(linuxDeploymentRoot, "validate-service.sh"),
      "utf8",
    );
    expect(validator).toContain("config-check-cli.js");
    expect(validator).toContain("storage/check-cli.js");
    expect(validator).toContain("storage/doctor-cli.js");
    expect(validator).toContain("--no-env-file");
    expect(validator).not.toMatch(
      /ExecStart|systemctl\s+start|systemctl\s+restart/u,
    );
  });

  it("pins the service to Bun 1.4.0, absolute state, and graceful signals", () => {
    const service = fs.readFileSync(
      path.join(linuxDeploymentRoot, "superior.service"),
      "utf8",
    );
    const shutdown = fs.readFileSync(
      path.join(repositoryRoot, "tsbot", "src", "shutdown.ts"),
      "utf8",
    );
    expect(service).toContain("ExecStart=@BUN_PATH@ --no-env-file");
    expect(service).toContain("Environment=SUPERIOR_AUTO_MIGRATE=0");
    expect(service).toContain(
      "Environment=SUPERIOR_RELEASE_ROOT=@INSTALL_ROOT@/current",
    );
    expect(service).toContain("KillSignal=SIGTERM");
    expect(service).toContain("UMask=0077");
    expect(shutdown).toContain('for (const signal of ["SIGINT", "SIGTERM"]');
  });

  it("keeps deployment scripts fail-closed and production-only", () => {
    for (const fileName of [
      "install.sh",
      "update.sh",
      "verify-backup.sh",
      "validate-service.sh",
      "export.sh",
      "import.sh",
      "rollback.sh",
    ]) {
      const source = fs.readFileSync(
        path.join(linuxDeploymentRoot, fileName),
        "utf8",
      );
      expect(source, fileName).toContain("set -Eeuo pipefail");
      expect(source, fileName).not.toContain("rm -rf");
    }
    const update = fs.readFileSync(
      path.join(linuxDeploymentRoot, "update.sh"),
      "utf8",
    );
    expect(update).toContain("install --frozen-lockfile --production");
    expect(update).toContain("--activate");
    expect(update).toContain("--no-start");
    expect(
      fs.readFileSync(path.join(linuxDeploymentRoot, "export.sh"), "utf8"),
    ).toContain("discord_login_attempted=false");
    expect(
      fs.readFileSync(path.join(linuxDeploymentRoot, "import.sh"), "utf8"),
    ).toContain("Refusing to overwrite target database");
    expect(
      fs.readFileSync(
        path.join(repositoryRoot, "tsbot", "package.json"),
        "utf8",
      ),
    ).not.toContain("better-sqlite3");
    expect(
      fs.readFileSync(path.join(repositoryRoot, "tsbot", "bun.lock"), "utf8"),
    ).not.toMatch(/better-sqlite3|@types\/better-sqlite3/u);
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-linux-deploy-"));
  temporaryRoots.push(root);
  return root;
}

function snapshotEnvironment(
  names: readonly string[],
): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironmentSnapshot(
  snapshot: Map<string, string | undefined>,
): void {
  for (const [name, value] of snapshot) restoreEnvironment(name, value);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
