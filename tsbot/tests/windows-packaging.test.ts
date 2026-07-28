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

    expect(packageJson).toMatchObject({
      name: "superior-discord-bot",
      version: "5.0.0",
      private: true,
    });
    expect(packageLock).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(packageLock.packages[""]).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(constants).toContain(
      `export const PACKAGE_VERSION = "${packageJson.version}"`,
    );
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
      "npm run clean && tsc -p tsconfig.build.json",
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
    const fallback = read("windows/templates/Start Superior Bot.cmd");

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
    expect(reproducibilityTest).toContain(
      "Portable rebuild was not byte-for-byte reproducible",
    );

    for (const source of [launcher, fallback]) {
      expect(source).toContain("--version");
      expect(source).toContain("--check");
      expect(source).toContain("runtime");
    }
    expect(smokeTest).toContain("no Discord login was attempted");
    expect(smokeTest).toContain("better_sqlite3.node");
    expect(smokeTest).toContain("MANIFEST.sha256");
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
    expect(workflow).toContain("Build Windows portable artifact");
    expect(workflow).toContain("npm run package:win:verify");
    expect(workflow).toContain("windows/test-portable.ps1");
    expect(workflow).toContain("actions/upload-artifact@v4");
  });
});
