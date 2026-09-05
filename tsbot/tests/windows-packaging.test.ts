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

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Windows Bun packaging", () => {
  it("does not publish the private watcher in user-facing documentation", () => {
    const publicFiles = [
      "README.md",
      ".env.example",
      "windows/PORTABLE-README.txt",
      ...fs
        .readdirSync(path.join(repoRoot, "docs"), {
          recursive: true,
          withFileTypes: true,
        })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .filter((entry) => entry.name !== "agent-guide.md")
        .map((entry) =>
          path.relative(repoRoot, path.join(entry.parentPath, entry.name)),
        ),
    ];

    for (const publicFile of publicFiles) {
      expect(read(publicFile), publicFile).not.toMatch(/mudae/iu);
    }
  });

  it("keeps package identity and version metadata synchronized", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      name: string;
      version: string;
      private?: boolean;
      packageManager?: string;
      engines?: Record<string, string>;
    };
    const constants = read("tsbot/src/constants.ts");
    const bunLock = read("tsbot/bun.lock");

    expect(packageJson).toMatchObject({
      name: "superior-discord-bot",
      private: true,
      packageManager: "bun@1.4.0",
      engines: { bun: ">=1.4.0" },
    });
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(Number(packageJson.version.split(".")[0])).toBeGreaterThanOrEqual(8);
    expect(constants).toContain(
      `export const PACKAGE_VERSION = "${packageJson.version}"`,
    );
    expect(fs.existsSync(path.join(tsbotRoot, "package-lock.json"))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(tsbotRoot, "src", "generated-version.ts")),
    ).toBe(false);
    expect(bunLock).not.toMatch(
      /better-sqlite3@|@types\/better-sqlite3@|^\s*"tsx":\s*\["tsx@/mu,
    );

    const verification = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "version.mjs"), "verify"],
      { encoding: "utf8" },
    );
    expect(verification.status, verification.stderr).toBe(0);
    expect(verification.stdout).toContain(
      `[version] verified ${packageJson.version}`,
    );
  });

  it("uses bun:sqlite without compatibility dependencies or aliases", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const database = read("tsbot/src/storage/database.ts");
    const vitestConfig = read("tsbot/vitest.config.ts");

    expect(packageJson.dependencies).not.toHaveProperty("better-sqlite3");
    expect(packageJson.devDependencies).not.toHaveProperty(
      "@types/better-sqlite3",
    );
    expect(packageJson.devDependencies).not.toHaveProperty("tsx");
    expect(database).toContain('from "bun:sqlite"');
    expect(database).not.toMatch(/better-sqlite3|createRequire|fallback/iu);
    expect(vitestConfig).not.toMatch(/alias|better-sqlite3/iu);
  });

  it("runs source, validation, and release workflows through Bun and pwsh", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      scripts: Record<string, string>;
    };
    const versionTool = read("scripts/version.mjs");
    const powershellCheck = read("scripts/check-powershell.mjs");
    const releaseBuilder = read("windows/release-build.ps1");
    const releaseVerifier = read("windows/verify-release.ps1");
    const packageAndRun = read("windows/package-and-run.ps1");
    const packageAndRunWrapper = read("windows/package-and-run.cmd");

    expect(packageJson.scripts["version:verify"]).toContain(
      "version.mjs verify",
    );
    expect(packageJson.scripts["docs:links"]).toContain(
      "check-markdown-links.mjs",
    );
    expect(packageJson.scripts["powershell:check"]).toContain(
      "check-powershell.mjs",
    );
    expect(packageJson.scripts.check).toContain("docs:links");
    expect(packageJson.scripts.check).toContain("powershell:check");
    expect(packageJson.scripts.check).toContain("runtime:check");
    expect(packageJson.scripts.check).toContain("test:policy");
    expect(packageJson.scripts.check).toContain("syntax:check");
    expect(packageJson.scripts["test:focused"]).toContain("test:migration");
    expect(packageJson.scripts["test:focused"]).toContain("test:backup");
    expect(packageJson.scripts["test:focused"]).toContain("test:doctor");
    expect(packageJson.scripts["test:focused"]).toContain("test:rotation");
    expect(packageJson.scripts["test:focused"]).toContain("test:telemetry");
    expect(packageJson.scripts["test:focused"]).toContain("test:row-decoder");
    expect(packageJson.scripts["release:build"]).toContain("release-build.ps1");
    expect(packageJson.scripts["package:win"]).toContain(
      "windows/.artifacts/development",
    );
    expect(packageJson.scripts["package:win"]).not.toMatch(
      /(?:^|\s)-(?:Standalone|Updater)Output\s+(?:SuperiorBot|Update)\.exe(?:\s|$)/u,
    );
    for (const script of Object.values(packageJson.scripts)) {
      expect(script).not.toMatch(/\b(?:node|npm|npx|tsx)(?:\.cmd|\.exe)?\b/iu);
    }
    for (const scriptName of [
      "package:win",
      "package:win:verify",
      "artifact:verify",
      "release:build",
    ]) {
      expect(packageJson.scripts[scriptName]).toMatch(/^pwsh\b/u);
      expect(packageJson.scripts[scriptName]).not.toMatch(/^powershell\b/iu);
    }

    expect(powershellCheck).toContain('["pwsh.exe"]');
    expect(powershellCheck).not.toContain('"powershell.exe"');
    for (const scriptName of fs
      .readdirSync(path.join(repoRoot, "windows"))
      .filter((entry) => entry.endsWith(".ps1"))) {
      expect(read(path.join("windows", scriptName)), scriptName).toMatch(
        /^#Requires -Version 7\.0/u,
      );
    }
    expect(versionTool).toContain("packageJson.version = version");
    expect(versionTool).toContain("PACKAGE_VERSION");
    for (const gate of [
      "format:check",
      "docs:links",
      "powershell:check",
      "security:check",
      "runtime:check",
      "test:policy",
      "test:focused",
      "syntax:check",
      "package:win:verify",
      "test-portable.ps1",
      "test-standalone.ps1",
    ]) {
      expect(releaseBuilder).toContain(gate);
    }
    expect(releaseBuilder).toContain("bun.exe");
    expect(releaseBuilder).toContain("-CommandType Application");
    expect(releaseBuilder).toContain("-OutputDirectory $FinalRelease");
    expect(releaseVerifier).toContain("sourceSha256");
    expect(releaseVerifier).toContain("--diagnostics");
    expect(packageAndRun).toContain("bun.exe");
    expect(packageAndRun).toContain("-CommandType Application");
    expect(packageAndRun).not.toMatch(/npm\.cmd|node\.exe|tsx/iu);
    expect(packageAndRun).toContain("--source");
    expect(packageAndRun).toContain(".artifacts\\development");
    expect(packageAndRunWrapper).toContain(
      "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\pwsh.exe",
    );
    expect(packageAndRunWrapper).toContain("package-and-run.ps1");
    expect(packageAndRunWrapper).not.toMatch(/powershell\.exe/iu);
  });

  it("builds only production source into a freshly cleaned dist directory", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      scripts: Record<string, string>;
    };
    const buildConfig = JSON.parse(read("tsbot/tsconfig.build.json")) as {
      include: string[];
      exclude: string[];
      compilerOptions: { types: string[] };
    };

    expect(packageJson.scripts.clean).toContain("clean-dist.mjs");
    expect(packageJson.scripts["db:backup"]).toBe(
      "bun --no-env-file src/storage/backup-cli.ts",
    );
    expect(packageJson.scripts.build).toContain("bun run version:generate");
    expect(packageJson.scripts.build).toContain(
      "bun --no-env-file ./node_modules/typescript/bin/tsc",
    );
    expect(packageJson.scripts["syntax:check"]).toContain(
      "check-built-javascript.mjs",
    );
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(buildConfig.exclude).toContain("tests");
    expect(buildConfig.compilerOptions.types).toEqual(["bun"]);
    expect(read(".env.example")).not.toMatch(
      /BOT_OPERATOR_USER_IDS|SCHEDULER_CONCURRENCY/u,
    );
  });

  it("packages a compiled Bun runtime inside the hardened launchers", () => {
    const builder = read("windows/build-portable.ps1");
    const sourceIdentity = read("windows/compute-source-identity.mjs");
    const smokeTest = read("windows/test-portable.ps1");
    const standaloneSmokeTest = read("windows/test-standalone.ps1");
    const reproducibilityTest = read("windows/test-reproducible.ps1");
    const launcher = read("windows/launcher/Program.cs");
    const standaloneLauncher = read("windows/standalone/Program.cs");
    const launcherSupport = read("windows/launcher/LauncherSupport.cs");
    const signalHarness = read("windows/launcher/ConsoleSignalHarness.cs");
    const config = read("tsbot/src/config.ts");
    const runtime = read("tsbot/src/windows-runtime.ts");
    const updater = read("windows/updater/Program.cs");
    const releaseBuilder = read("windows/release-build.ps1");
    const releaseVerifier = read("windows/verify-release.ps1");
    const signing = read("windows/signing.ps1");
    const signingTest = read("windows/test-signing.ps1");
    const authenticodeSupport = read("windows/launcher/AuthenticodeSupport.cs");
    const hashUtilities = read("windows/hash-utils.ps1");
    const pathSafety = read("windows/path-safety.ps1");
    const pathSafetyTest = read("windows/test-path-safety.ps1");
    const releaseVerifierTest = read("windows/test-release-verifier.ps1");
    const bunEnvironment = read("windows/bun-environment.ps1");
    const cleanDist = read("windows/clean-dist.mjs");
    const fallback = read("windows/templates/Start Superior Bot.cmd");

    expect(builder).toContain('$BunVersion = "1.4.0"');
    expect(builder).toContain("Get-Command bun.exe");
    expect(builder).toContain("-CommandType Application");
    expect(builder).toContain('"--compile"');
    expect(builder).toContain('"--target=bun-windows-x64-baseline"');
    expect(builder).toContain('"--no-compile-autoload-dotenv"');
    expect(builder).toContain('"--no-compile-autoload-bunfig"');
    expect(builder).toContain("windows-runtime.ts");
    expect(builder).toContain("SuperiorBot.Runtime.exe");
    for (const metadata of [
      "BUN_VERSION",
      "BUN_EXECUTABLE_SHA256",
      "COMPILED_RUNTIME_SHA256",
      "BUN_LOCK_SHA256",
      "SOURCE_SHA256",
    ]) {
      expect(builder).toContain(metadata);
    }
    expect(builder).not.toMatch(/\$NodeVersion|NodeArchive|BetterSqlite3/iu);
    expect(builder).toContain("node_modules|better-sqlite3");
    expect(builder).toContain('"/platform:x64"');
    expect(builder).toContain('"/noconfig"');
    expect(builder).toContain('"/nostdlib+"');
    expect(builder).toContain('"/deterministic+"');
    expect(builder).toContain('"/pathmap:');
    expect(builder).not.toContain("$env:WINDIR");
    expect(builder).toContain("write-deterministic-zip.mjs");
    expect(builder).toContain("MANIFEST.sha256");
    expect(builder).toContain("SuperiorBot.Payload.zip");
    expect(builder).toContain("$StandaloneOutput");
    expect(builder).toContain("$UpdaterOutput");
    expect(builder).toContain("AssemblyFileVersion");
    expect(builder).toContain("AssemblyInformationalVersion");
    expect(builder).toContain("Archive entry escapes its extraction directory");
    expect(builder).toContain("Portable staging contains reparse points");
    expect(builder).toContain("exact release inventory");
    expect(builder).toContain('"bun.exe"');
    expect(builder).toContain("Enter-BunBuildEnvironment");
    expect(builder).toContain("Initialize-ReleaseSigning");
    expect(builder).toContain("Invoke-ReleaseSignature");
    expect(builder).toContain("SIGNATURE_STATUS");
    expect(builder).toContain("SIGNING_SUBJECT");
    expect(builder).toContain("SIGNING_THUMBPRINT");
    expect(builder).toContain("TIMESTAMP_STATUS");
    expect(builder).toContain("AllowUnsignedDevelopment");
    expect(builder).toContain("Assert-PathTreeHasNoReparsePoint");
    expect(sourceIdentity).toContain("tsbot/bun.lock");
    expect(sourceIdentity).toContain("scripts/version.mjs");
    expect(sourceIdentity).toContain("windows/launcher/AuthenticodeSupport.cs");
    expect(sourceIdentity).toContain("windows/signing.ps1");
    expect(sourceIdentity).toContain("windows/verify-release.ps1");
    expect(sourceIdentity).toContain("windows/path-safety.ps1");
    expect(sourceIdentity).toContain("windows/bun-environment.ps1");
    expect(sourceIdentity).toContain("fs.lstatSync");
    expect(sourceIdentity).toContain("status.isSymbolicLink()");
    expect(sourceIdentity).not.toContain("package-lock.json");
    expect(hashUtilities).toContain(
      "[System.Security.Cryptography.SHA256]::Create()",
    );

    for (const source of [launcher, standaloneLauncher]) {
      expect(source).toContain("--version");
      expect(source).toContain("--check");
      expect(source).toContain("--diagnostics");
      expect(source).toContain("--offline-smoke");
      expect(source).toContain("--doctor");
      expect(source).toContain("--checkpoint");
      expect(source).toContain("--backup-rotate");
      expect(source).toContain("SUPERIOR_TEST_MODE");
      expect(source).toContain("SUPERIOR_AUTO_MIGRATE");
      expect(source).toContain("SUPERIOR_APPLICATION_ROOT");
      expect(source).toContain("SuperiorBot.Runtime.exe");
      expect(source).toContain("SanitizeBunRuntimeEnvironment");
      expect(source).toContain("SUPERIOR_DATABASE_LOCK_PATH");
      expect(source).not.toMatch(/node\.exe|node_modules|better-sqlite3/iu);
    }
    expect(fallback).toContain('"%~dp0SuperiorBot.exe" "%~1"');
    expect(fallback).toContain("--diagnostics");

    for (const hardening of [
      "SuperiorInstanceGuard",
      "AbandonedMutexException",
      'return @"Global\\SuperiorBot-"',
      "ValidatePortableManifest",
      "ValidateTreeHasNoReparsePoints",
      "RefuseReparsePath",
      "JobObjectLimitKillOnJobClose",
      "Console.CancelKeyPress",
    ]) {
      expect(launcherSupport).toContain(hardening);
    }
    expect(standaloneLauncher).toContain("ExtractArchiveSafely");
    expect(standaloneLauncher).toContain("LocalApplicationData");
    expect(standaloneLauncher).toContain(
      "LauncherSupport.ValidateTreeHasNoReparsePoints(resolved)",
    );

    expect(runtime).toContain('from "./index.js"');
    expect(runtime).toContain('from "./storage/database.js"');
    expect(runtime).toContain('emit("sqliteBackend", "bun:sqlite")');
    expect(runtime).toContain("databaseState=");
    expect(runtime).toContain("BotStorage");
    expect(runtime).toContain("requireLauncherLock: true");
    expect(config).toContain(
      "packaged Bun runtime requires Windows launcher database-lock attestation",
    );
    expect(runtime).not.toMatch(
      /better-sqlite3|createRequire|synthetic|metric/iu,
    );

    for (const packagedTest of [smokeTest, standaloneSmokeTest]) {
      expect(packagedTest).toContain("sqliteBackend=bun:sqlite");
      expect(packagedTest).toContain("ConsoleSignalHarness.cs");
      expect(packagedTest).toContain("databaseState=$ExpectedDatabaseState");
      expect(packagedTest).toContain("SuperiorBot.Runtime.exe");
      expect(packagedTest).toContain("SUPERIOR_APPLICATION_ROOT");
      expect(packagedTest).toContain("graceful");
      expect(packagedTest).toContain("schema=current-v11");
      expect(packagedTest).toContain("RestrictedPath");
      expect(packagedTest).toContain('"bun.exe", "node.exe"');
      expect(packagedTest).toContain("BUN_OPTIONS");
      expect(packagedTest).toContain("BUN_BE_BUN");
    }
    expect(smokeTest).toContain("undeclared executable payload file");
    expect(smokeTest).toContain("declared external Bun executable");
    expect(smokeTest).toContain("artifact checksum is required");
    expect(smokeTest).toContain("MANIFEST.sha256");
    expect(smokeTest).toContain("Direct packaged runtime bypassed");
    expect(launcherSupport).toContain(
      'Path.Combine(applicationRoot, "court.db")',
    );
    expect(launcherSupport).toContain("DB_FILE must be set explicitly");
    expect(standaloneSmokeTest).toContain(
      "Launcher accepted an implicit superior.db beside legacy court.db",
    );
    expect(standaloneSmokeTest).toContain("Another Superior Bot instance");
    expect(standaloneSmokeTest).toContain("already using this database");
    expect(standaloneSmokeTest).toContain("JobSmokeHarness.cs");
    expect(standaloneSmokeTest).toContain("LegacyUpdateFixture.cs");
    expect(standaloneSmokeTest).toContain(
      "7.2.8 to $ExpectedVersion updater smoke",
    );
    expect(standaloneSmokeTest).toContain("sqliteBackend=bun:sqlite");

    for (const harnessRequirement of [
      "CreateProcess",
      "AttachConsole",
      "SetConsoleCtrlHandler",
      "QueryFullProcessImageName",
      "WaitForSingleObject(childProcess",
      "StopIfRunning",
    ]) {
      expect(signalHarness).toContain(harnessRequirement);
    }
    expect(signalHarness).toContain("expectedRuntime");

    expect(updater).toContain("--allow-downgrade");
    expect(updater).toContain("LauncherSupport.AcquireInstanceGuard");
    expect(updater).toContain("AssertFileHash");
    expect(updater).toContain("RefuseReparsePoint");
    expect(updater).toContain("SHA256.Create()");
    expect(updater).toContain("AuthenticodeSupport.VerifyFile");
    expect(updater).toContain("VerifyInstalledExecutablePostcondition");
    expect(updater).toContain("LauncherSupport.NormalizeRoot");
    expect(updater.indexOf("RefuseReparsePath(activeUpdater")).toBeLessThan(
      updater.indexOf("AuthenticodeSupport.VerifyFile(activeUpdater"),
    );
    expect(updater.indexOf("RefuseReparsePath(source")).toBeLessThan(
      updater.indexOf("string sourceVersion = VerifyExecutable("),
    );
    expect(updater).toContain(".env, database, and backups were preserved");
    expect(authenticodeSupport).toContain("WinVerifyTrust");
    expect(authenticodeSupport).toContain("BuildIdentity.ExpectedPublisher");
    expect(authenticodeSupport).toContain("BuildIdentity.ExpectedThumbprint");
    expect(authenticodeSupport).toContain("Rfc3161TimestampOid");
    expect(signing).toContain("SUPERIOR_SIGNING_PFX_PASSWORD");
    expect(signing).toContain("Get-AuthenticodeSignature");
    expect(signing).toContain("TimeStamperCertificate");
    expect(signingTest).toContain("New-SelfSignedCertificate");
    expect(signingTest).toContain("wrong publisher");
    expect(signingTest).toContain("tampered");
    expect(signingTest).toContain("expired");
    expect(signingTest).toContain("untrusted");
    expect(signingTest).toContain("rollback");
    expect(signingTest).toContain("verify-release.ps1");
    expect(signingTest).toContain(
      "same-subject certificate with the wrong thumbprint",
    );
    expect(releaseVerifier).toContain("ExpectedSignerThumbprint");
    expect(releaseVerifier).toContain(
      "independently configured publisher and thumbprint",
    );
    expect(releaseVerifier).toContain(
      "checksum does not match the published ZIP",
    );
    expect(releaseVerifier).toContain("exact release inventory");
    expect(releaseVerifier).toContain("byte-identical to the updater");
    expect(releaseVerifier).toContain("embedded payload does not match");
    expect(releaseVerifier).not.toContain("Expand-Archive");
    expect(releaseVerifier).toContain("ProductVersion -ne");
    expect(releaseVerifier).not.toContain("ProductVersion.StartsWith");
    expect(reproducibilityTest).toContain(
      "Portable rebuild was not byte-for-byte reproducible",
    );
    expect(reproducibilityTest).toContain(
      "Standalone rebuild was not byte-for-byte reproducible",
    );
    expect(reproducibilityTest).toContain(
      "Updater rebuild was not byte-for-byte reproducible",
    );
    expect(reproducibilityTest).toContain("$UpdaterOutput");
    expect(pathSafety).toContain("Assert-PathHasNoReparsePoint");
    expect(pathSafety).toContain("Remove-SafeOwnedTree");
    expect(pathSafetyTest).toContain("outside sentinel");
    expect(pathSafetyTest).toContain("ItemType Junction");
    expect(releaseVerifierTest).toContain("missing-sidecar");
    expect(releaseVerifierTest).toContain("wrong-root");
    expect(releaseVerifierTest).toContain("missing-inventory");
    expect(releaseVerifierTest).toContain("duplicate-build-info");
    expect(releaseVerifierTest).toContain("different-updater");
    expect(releaseVerifierTest).toContain("different-payload");
    expect(bunEnvironment).toContain("NODE_OPTIONS");
    expect(bunEnvironment).toContain('StartsWith("BUN_"');
    expect(cleanDist).toContain("lstatSync");
    expect(cleanDist).toContain("isSymbolicLink");
    expect(cleanDist).toContain("rmdirSync");
    expect(cleanDist).not.toContain("rmSync");
    expect(releaseBuilder).not.toContain(
      "$ExpectedSignerThumbprint = $SigningCertificateThumbprint",
    );
  });

  it("writes identical ZIP bytes across source paths, mtimes, and creation order", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "superior-deterministic-zip-"),
    );
    try {
      const firstRoot = path.join(temporaryRoot, "first", "Fixture");
      const secondRoot = path.join(temporaryRoot, "second", "Fixture");
      const firstArchive = path.join(temporaryRoot, "first.zip");
      const secondArchive = path.join(temporaryRoot, "second.zip");
      const writer = path.join(
        repoRoot,
        "windows",
        "write-deterministic-zip.mjs",
      );

      fs.mkdirSync(path.join(firstRoot, "nested"), { recursive: true });
      fs.writeFileSync(path.join(firstRoot, "alpha.txt"), "alpha\n");
      fs.writeFileSync(path.join(firstRoot, "nested", "omega.txt"), "omega\n");

      fs.mkdirSync(path.join(secondRoot, "nested"), { recursive: true });
      fs.writeFileSync(path.join(secondRoot, "nested", "omega.txt"), "omega\n");
      fs.writeFileSync(path.join(secondRoot, "alpha.txt"), "alpha\n");

      fs.utimesSync(
        path.join(firstRoot, "alpha.txt"),
        new Date(1),
        new Date(1),
      );
      fs.utimesSync(
        path.join(secondRoot, "alpha.txt"),
        new Date("2030-01-01T00:00:00Z"),
        new Date("2030-01-01T00:00:00Z"),
      );

      for (const [source, archive] of [
        [firstRoot, firstArchive],
        [secondRoot, secondArchive],
      ] as const) {
        const result = spawnSync(process.execPath, [writer, source, archive], {
          encoding: "utf8",
        });
        if (result.status !== 0) {
          throw new Error(result.stderr || result.stdout);
        }
      }

      expect(fs.readFileSync(firstArchive)).toEqual(
        fs.readFileSync(secondArchive),
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("builds, smoke-tests, and uploads the Bun artifact in CI", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("Validate on Linux");
    expect(workflow).toContain("oven-sh/setup-bun@");
    expect(workflow).toMatch(/bun-version:\s*["']?1\.4\.0/u);
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run test:security");
    expect(workflow).toContain("scripts/security-check.mjs");
    expect(workflow).toContain("bun audit --audit-level=high");
    expect(workflow).toContain("bun run docs:links");
    expect(workflow).toContain("bun run powershell:check");
    expect(workflow).toContain("bun run runtime:check");
    expect(workflow).toContain("bun run test:policy");
    expect(workflow).toContain("bun run test:focused");
    expect(workflow).toContain("bun run syntax:check");
    expect(workflow).toContain("bash -n ops.sh");
    expect(workflow).toContain("git diff --check");
    expect(workflow).toContain("Build Windows portable artifact");
    expect(workflow).toContain("windows/test-reproducible.ps1");
    expect(workflow).toContain("windows/test-portable.ps1");
    expect(workflow).toContain("windows/test-standalone.ps1");
    expect(workflow).toContain("windows/test-signing.ps1");
    expect(workflow).toContain("windows/test-path-safety.ps1");
    expect(workflow).toContain("windows/test-release-verifier.ps1");
    expect(workflow).toContain("Build and verify signed Windows release");
    expect(workflow).toContain("WINDOWS_SIGNING_PFX_BASE64");
    expect(workflow).toContain("WINDOWS_SIGNING_PFX_PASSWORD");
    expect(workflow).toContain("expected_signer_thumbprint");
    expect(workflow).toContain("windows/verify-release.ps1");
    expect(workflow).not.toMatch(/setup-node|npm (?:ci|run|test)/iu);
    expect(workflow).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );

    const codeql = read(".github/workflows/codeql.yml");
    expect(codeql).toContain("security-events: write");
    expect(codeql).toContain("javascript-typescript");
    expect(codeql).toContain(
      "github/codeql-action/init@24c7eb380a2dc368f2d129e4c65e51d172983a1e",
    );
  });

  it("keeps private operator files outside formatting, Git, and release tooling", () => {
    expect(read(".gitignore")).toContain("/mudae-watch.private.json");
    expect(read(".gitignore")).toMatch(/^\*\.bak$/mu);
    expect(read(".gitignore")).toMatch(/^\*\.backup$/mu);
    expect(read(".prettierignore")).toContain("mudae-watch.private.json");
    expect(read("windows/build-portable.ps1")).toContain(
      '"mudae-watch.private.json"',
    );
    expect(read("tsbot/package.json")).toContain('"security:check"');
    expect(read("scripts/security-check.mjs")).toContain(
      "tracked secret scan passed",
    );
    expect(read("scripts/security-check.mjs")).toContain('"operator.bak"');
    expect(read("scripts/security-check.mjs")).toContain('"operator.backup"');
    expect(read("scripts/security-check.mjs")).toContain(
      "versionIdentitySources",
    );
    expect(read("tsbot/src/config.ts")).not.toMatch(
      /process\.env\.(?:BOT_VERSION|npm_package_version)/u,
    );
    expect(read(".env.example")).not.toContain("BOT_VERSION=");
  });
});
