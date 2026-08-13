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

describe("Windows portable packaging", () => {
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
        .map((entry) =>
          path.relative(repoRoot, path.join(entry.parentPath, entry.name)),
        ),
    ];

    for (const publicFile of publicFiles) {
      expect(read(publicFile), publicFile).not.toMatch(/mudae/i);
    }
  });

  it("keeps public package identity and version metadata synchronized", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      name: string;
      version: string;
      private?: boolean;
    };
    const packageLock = JSON.parse(read("tsbot/package-lock.json")) as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version?: string }>;
    };
    const constants = read("tsbot/src/constants.ts");
    const generatedVersion = read("tsbot/src/generated-version.ts");

    expect(packageJson).toMatchObject({
      name: "superior-discord-bot",
      private: true,
    });
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageLock).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(packageLock.packages[""]).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(generatedVersion).toContain(
      `export const PACKAGE_VERSION = "${packageJson.version}"`,
    );
    expect(constants).toContain(
      'export { PACKAGE_VERSION } from "./generated-version.js"',
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

  it("provides resumable version and release workflows", () => {
    const packageJson = JSON.parse(read("tsbot/package.json")) as {
      scripts: Record<string, string>;
    };
    const versionTool = read("scripts/version.mjs");
    const releaseBuilder = read("windows/release-build.ps1");
    const releaseVerifier = read("windows/verify-release.ps1");

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
    expect(packageJson.scripts["version:patch"]).toContain("patch");
    expect(packageJson.scripts["version:minor"]).toContain("minor");
    expect(packageJson.scripts["version:major"]).toContain("major");
    expect(packageJson.scripts["release:build"]).toContain("release-build.ps1");
    expect(packageJson.scripts["release:patch"]).toContain("release:build");
    expect(packageJson.scripts["release:minor"]).toContain("release:build");
    expect(packageJson.scripts["release:major"]).toContain("release:build");
    expect(versionTool).toContain("packageJson.version = version");
    expect(releaseBuilder).toContain("format:check");
    expect(releaseBuilder).toContain("docs:links");
    expect(releaseBuilder).toContain("powershell:check");
    expect(releaseBuilder).toContain("security:check");
    expect(releaseBuilder).toContain("package:win:verify");
    expect(releaseBuilder).toContain("test-portable.ps1");
    expect(releaseBuilder).toContain("test-standalone.ps1");
    expect(releaseVerifier).toContain("sourceSha256");
    expect(releaseVerifier).toContain("--diagnostics");
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
      "tsx src/storage/backup-cli.ts",
    );
    expect(packageJson.scripts.build).toBe(
      "npm run version:generate && npm run clean && tsc -p tsconfig.build.json",
    );
    expect(buildConfig.include).toEqual(["src/**/*.ts"]);
    expect(buildConfig.exclude).toContain("tests");
    expect(buildConfig.compilerOptions.types).toEqual(["node"]);
    expect(read(".env.example")).not.toMatch(
      /BOT_OPERATOR_USER_IDS|SCHEDULER_CONCURRENCY/,
    );
  });

  it("pins, checks, and packages the Windows x64 runtime and native addon", () => {
    const builder = read("windows/build-portable.ps1");
    const smokeTest = read("windows/test-portable.ps1");
    const reproducibilityTest = read("windows/test-reproducible.ps1");
    const launcher = read("windows/launcher/Program.cs");
    const standaloneLauncher = read("windows/standalone/Program.cs");
    const standaloneSmokeTest = read("windows/test-standalone.ps1");
    const fallback = read("windows/templates/Start Superior Bot.cmd");
    const launcherSupport = read("windows/launcher/LauncherSupport.cs");
    const diagnostics = read("windows/diagnostics.mjs");
    const releaseVerifier = read("windows/verify-release.ps1");

    expect(builder).toContain('$NodeVersion = "22.12.0"');
    expect(builder).toContain(
      '$NodeArchiveSha256 = "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8"',
    );
    expect(builder).toContain('$CompilerToolsetVersion = "4.12.0"');
    expect(builder).toContain(
      '$CompilerToolsetPackageSha256 = "fe24ef31a6ffcb7c49383d2fd362763dee291ad9b9d98cc0c19ef80203b99ebc"',
    );
    expect(builder).toContain('$ReferenceAssembliesVersion = "1.0.3"');
    expect(builder).toContain(
      '$ReferenceAssembliesPackageSha256 = "8a7e348538e7eb91351696911689f49e3d4f63f8bab517432bbe159b8b1104a2"',
    );
    expect(builder).toContain(
      '$BetterSqlite3BinarySha256 = "8c041ef57dd1bb55b0032306594310625b7a7a374bc48956e0858645f56919c4"',
    );
    expect(builder).toContain("Get-FileHash");
    expect(builder).toContain('"--omit=dev"');
    expect(builder).toContain('"/platform:x64"');
    expect(builder).toContain('"/noconfig"');
    expect(builder).toContain('"/nostdlib+"');
    expect(builder).toContain('"/deterministic+"');
    expect(builder).toContain('"/pathmap:');
    expect(builder).not.toContain("$env:WINDIR");
    expect(builder).toContain('"better_sqlite3.node"');
    expect(builder).toContain("write-deterministic-zip.mjs");
    expect(builder).toContain("MANIFEST.sha256");
    expect(builder).toContain("SuperiorBot.Payload.zip");
    expect(builder).toContain("$StandaloneOutput");
    expect(builder).toContain("AssemblyFileVersion");
    expect(builder).toContain("AssemblyInformationalVersion");
    expect(builder).toContain("SOURCE_SHA256");
    expect(builder).toContain("diagnostics.mjs");
    expect(builder).toContain("Archive entry escapes its extraction directory");
    expect(builder).toContain("Portable staging contains reparse points");
    expect(reproducibilityTest).toContain(
      "Portable rebuild was not byte-for-byte reproducible",
    );
    expect(reproducibilityTest).toContain(
      "Standalone rebuild was not byte-for-byte reproducible",
    );

    for (const source of [launcher, standaloneLauncher]) {
      expect(source).toContain("--version");
      expect(source).toContain("--check");
      expect(source).toContain("--diagnostics");
    }
    expect(fallback).toContain('"%~dp0SuperiorBot.exe" "%~1"');
    expect(fallback).toContain("--diagnostics");
    expect(launcherSupport).toContain("SuperiorInstanceGuard");
    expect(launcherSupport).toContain("AbandonedMutexException");
    expect(launcherSupport).toContain('return @"Global\\SuperiorBot-"');
    expect(launcherSupport).toContain("ValidatePortableManifest");
    expect(launcherSupport).toContain("ValidateTreeHasNoReparsePoints");
    expect(diagnostics).toContain("completed without Discord login");
    expect(diagnostics).not.toContain("fileEnvironment.DISCORD_TOKEN");
    expect(smokeTest).toContain("no Discord login was attempted");
    expect(smokeTest).toContain("better_sqlite3.node");
    expect(smokeTest).toContain("MANIFEST.sha256");
    expect(smokeTest).toContain("undeclared executable payload file");
    for (const identityCheck of [
      smokeTest,
      standaloneSmokeTest,
      releaseVerifier,
    ]) {
      expect(identityCheck).toContain("ProductVersion -ne");
      expect(identityCheck).not.toContain("ProductVersion.StartsWith");
    }
    expect(standaloneLauncher).toContain("SUPERIOR_APPLICATION_ROOT");
    expect(standaloneLauncher).toContain("ExtractArchiveSafely");
    expect(standaloneLauncher).toContain("LocalApplicationData");
    expect(standaloneSmokeTest).toContain(
      "Standalone executable, application-root, database-lock, orphan-child job, and native SQLite smoke checks passed.",
    );
    expect(standaloneSmokeTest).toContain("Another Superior Bot instance");
    expect(standaloneSmokeTest).toContain("JobSmokeHarness.cs");
    expect(standaloneSmokeTest).toContain(
      "Stop-Process -Id $JobParent.Id -Force",
    );
    expect(launcherSupport).toContain("JobObjectLimitKillOnJobClose");
    expect(launcherSupport).toContain("Console.CancelKeyPress");
    expect(standaloneSmokeTest).toContain("already using this database");
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

  it("builds, smoke-tests, and uploads the portable artifact in CI", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("Validate on Linux");
    expect(workflow).toContain("bash -n ops.sh");
    expect(workflow).toContain("git diff --check");
    expect(workflow).toContain("npm run security:check");
    expect(workflow).toContain("npm run docs:links");
    expect(workflow).toContain("npm run powershell:check");
    expect(workflow).toContain("npm run artifact:verify");
    expect(workflow).toContain("Build Windows portable artifact");
    expect(workflow).toContain("npm run package:win:verify");
    expect(workflow).toContain("windows/test-portable.ps1");
    expect(workflow).toContain("windows/test-standalone.ps1");
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
      /process\.env\.(?:BOT_VERSION|npm_package_version)/,
    );
    expect(read(".env.example")).not.toContain("BOT_VERSION=");
  });
});
