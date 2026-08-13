import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function trackedFiles() {
  return runGit([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean)
    .map((fileName) => fileName.replaceAll("\\", "/"));
}

const textExtensions = new Set([
  "",
  ".cmd",
  ".cs",
  ".json",
  ".js",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".txt",
  ".yml",
  ".yaml",
]);

function isTextFile(fileName) {
  return textExtensions.has(path.extname(fileName).toLowerCase());
}

function readTracked(fileName) {
  return fs.readFileSync(path.join(repositoryRoot, fileName), "utf8");
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function assertIgnored(samplePath) {
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", samplePath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Sensitive path is not ignored: ${samplePath}`);
  }
}

function main() {
  const files = trackedFiles();
  const failures = [];
  const forbiddenTracked = files.filter(
    (fileName) =>
      fileName !== ".env.example" &&
      (/^(?:backups|release|windows\/(?:\.cache|\.work))\//iu.test(fileName) ||
        /(^|\/)(?:node_modules|dist|coverage)\//iu.test(fileName) ||
        /(^|\/)(?:\.env(?:\..+)?|mudae-watch\.private\.json|[^/]+\.(?:db|db-shm|db-wal|db-journal|sqlite|sqlite3|log|bak|backup))$/i.test(
          fileName,
        )),
  );
  if (forbiddenTracked.length > 0) {
    failures.push(
      `sensitive runtime files are tracked: ${forbiddenTracked.join(", ")}`,
    );
  }

  const privateName = "mudae-watch.private.json";
  const requiredIgnoreEntries = [privateName, "*.bak", "*.backup"];
  for (const ignoreFile of [".gitignore", ".prettierignore"]) {
    const entries = readTracked(ignoreFile)
      .split(/\r?\n/u)
      .map((line) => line.trim().replace(/^\//u, ""));
    for (const requiredEntry of requiredIgnoreEntries) {
      if (!entries.includes(requiredEntry)) {
        failures.push(`${ignoreFile} does not exclude ${requiredEntry}`);
      }
    }
  }

  for (const sample of [
    ".env",
    ".env.production",
    "superior.db",
    "superior.db-wal",
    "backups/security-check.db",
    "operator.log",
    "operator.bak",
    "operator.backup",
    "release/security-check.zip",
    "windows/.cache/security-check.bin",
    "windows/.work/security-check.bin",
    privateName,
  ]) {
    try {
      assertIgnored(sample);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const secretPatterns = [
    {
      name: "Discord token",
      pattern:
        /(?:mfa\.[A-Za-z\d_-]{80,}|[A-Za-z\d_-]{24,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,})/gu,
    },
    { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z\d]{36,}/gu },
    { name: "AWS access key", pattern: /AKIA[A-Z\d]{16}/gu },
    {
      name: "private key",
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    },
  ];
  let testSnowflakes = 0;
  let productionSnowflakes = 0;
  for (const fileName of files.filter(isTextFile)) {
    const text = readTracked(fileName);
    for (const { name, pattern } of secretPatterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        failures.push(
          `${name} pattern in ${fileName}:${lineNumber(text, match.index ?? 0)}`,
        );
      }
    }

    const snowflakes = text.match(/\b\d{17,20}\b/gu) ?? [];
    if (fileName.startsWith("tsbot/tests/")) {
      testSnowflakes += snowflakes.length;
    } else if (snowflakes.length > 0) {
      productionSnowflakes += snowflakes.length;
      failures.push(
        `hard-coded Discord-sized numeric ID outside tests: ${fileName}`,
      );
    }
  }

  for (const fileName of files.filter(
    (fileName) => fileName.startsWith("tsbot/src/") && fileName.endsWith(".ts"),
  )) {
    const text = readTracked(fileName);
    if (/ephemeral\s*:\s*true/gu.test(text)) {
      failures.push(`deprecated ephemeral: true response in ${fileName}`);
    }
  }

  const versionIdentitySources = files.filter(
    (fileName) =>
      (fileName.startsWith("tsbot/src/") ||
        fileName.startsWith("scripts/") ||
        fileName.startsWith("windows/")) &&
      /\.(?:cmd|cs|js|mjs|ps1|ts)$/iu.test(fileName) &&
      fileName !== "scripts/security-check.mjs",
  );
  for (const fileName of versionIdentitySources) {
    const text = readTracked(fileName);
    for (const pattern of [/\bBOT_VERSION\b/gu, /\bnpm_package_version\b/gu]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match) {
        failures.push(
          `unsafe runtime version override in ${fileName}:${lineNumber(text, match.index)}`,
        );
      }
    }
  }

  const environmentTemplate = readTracked(".env.example");
  if (/^BOT_VERSION\s*=/mu.test(environmentTemplate)) {
    failures.push(".env.example still advertises a runtime version override");
  }

  if (failures.length > 0) {
    throw new Error(
      `Static security checks failed:\n- ${[...new Set(failures)].join("\n- ")}`,
    );
  }

  console.log(
    `[security] tracked secret scan passed (${files.length} files); hard-coded snowflakes: ${productionSnowflakes} production, ${testSnowflakes} synthetic test references`,
  );
  console.log(
    "[security] ignore boundaries, private configuration isolation, interaction flags, and version identity passed",
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[security:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
