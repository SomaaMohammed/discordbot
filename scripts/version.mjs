import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const packagePath = path.join(repositoryRoot, "tsbot", "package.json");
const lockPath = path.join(repositoryRoot, "tsbot", "bun.lock");
const constantsPath = path.join(repositoryRoot, "tsbot", "src", "constants.ts");
const readmePath = path.join(repositoryRoot, "README.md");
const portableReadmePath = path.join(
  repositoryRoot,
  "windows",
  "PORTABLE-README.txt",
);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const documentationVersions = [
  {
    fileName: readmePath,
    label: "README current release",
    pattern: /^Superior (\d+\.\d+\.\d+) is /mu,
    replacement: (version) => `Superior ${version} is `,
  },
  {
    fileName: portableReadmePath,
    label: "portable README current release",
    pattern: /^Version (\d+\.\d+\.\d+) will not start/mu,
    replacement: (version) => `Version ${version} will not start`,
  },
];

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(fileName, "utf8"));
}

function writeJson(fileName, value) {
  fs.writeFileSync(fileName, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function constantsSource(version) {
  return [
    "/** Authoritative package identity kept in sync with package.json. */",
    `export const PACKAGE_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n");
}

function updateDocumentationVersions(version) {
  for (const definition of documentationVersions) {
    const original = fs.readFileSync(definition.fileName, "utf8");
    if (!definition.pattern.test(original)) {
      throw new Error(`Could not locate ${definition.label} marker.`);
    }
    fs.writeFileSync(
      definition.fileName,
      original.replace(definition.pattern, definition.replacement(version)),
      "utf8",
    );
  }
}

function readPackageIdentity() {
  const packageJson = readJson(packagePath);
  if (packageJson.name !== "superior-discord-bot") {
    throw new Error(`Unexpected package name: ${String(packageJson.name)}`);
  }
  if (!semverPattern.test(String(packageJson.version))) {
    throw new Error(
      `tsbot/package.json version must be MAJOR.MINOR.PATCH: ${String(packageJson.version)}`,
    );
  }
  if (
    String(packageJson.version)
      .split(".")
      .some((part) => Number(part) > 65_534)
  ) {
    throw new Error(
      `Package version exceeds the Windows assembly metadata limit: ${String(packageJson.version)}`,
    );
  }
  if (packageJson.packageManager !== "bun@1.4.0") {
    throw new Error("packageManager must pin bun@1.4.0");
  }
  return packageJson;
}

function verifyLockfile() {
  if (!fs.existsSync(lockPath)) {
    throw new Error(
      "bun.lock is missing. Run bun install before verification.",
    );
  }
  const lockText = fs.readFileSync(lockPath, "utf8");
  if (!lockText.includes('"superior-discord-bot"')) {
    throw new Error("bun.lock does not identify the root package");
  }
  if (/better-sqlite3|@types\/better-sqlite3/iu.test(lockText)) {
    throw new Error("bun.lock still references better-sqlite3");
  }
}

function verify() {
  const packageJson = readPackageIdentity();
  const mismatches = [];
  const expectedConstants = constantsSource(packageJson.version);
  const actualConstants = fs.existsSync(constantsPath)
    ? fs.readFileSync(constantsPath, "utf8").replaceAll("\r\n", "\n")
    : "";
  if (actualConstants !== expectedConstants) {
    mismatches.push("runtime constant");
  }
  for (const definition of documentationVersions) {
    const match = definition.pattern.exec(
      fs.readFileSync(definition.fileName, "utf8"),
    );
    if (match?.[1] !== packageJson.version) {
      mismatches.push(definition.label);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Version metadata is out of sync (${mismatches.join(", ")}). Run bun run version:generate.`,
    );
  }
  verifyLockfile();
  console.log(`[version] verified ${packageJson.version}`);
}

function generate() {
  const packageJson = readPackageIdentity();
  const originals = new Map(
    [constantsPath, readmePath, portableReadmePath].map((fileName) => [
      fileName,
      fs.readFileSync(fileName),
    ]),
  );
  try {
    fs.writeFileSync(
      constantsPath,
      constantsSource(packageJson.version),
      "utf8",
    );
    updateDocumentationVersions(packageJson.version);
  } catch (error) {
    for (const [fileName, contents] of originals) {
      fs.writeFileSync(fileName, contents);
    }
    throw error;
  }
  console.log(`[version] generated runtime identity ${packageJson.version}`);
}

function nextVersion(current, level) {
  const match = semverPattern.exec(current);
  if (!match) throw new Error(`Invalid current semantic version: ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  switch (level) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
    default:
      throw new Error("Version level must be patch, minor, or major.");
  }
  return `${major}.${minor}.${patch}`;
}

function bump(level) {
  const packageJson = readPackageIdentity();
  const previous = packageJson.version;
  const version = nextVersion(previous, level);
  if (version.split(".").some((part) => Number(part) > 65_534)) {
    throw new Error(
      `The requested version exceeds the Windows assembly metadata limit: ${version}`,
    );
  }
  packageJson.version = version;
  const originals = new Map(
    [packagePath, constantsPath, readmePath, portableReadmePath].map(
      (fileName) => [fileName, fs.readFileSync(fileName)],
    ),
  );
  try {
    writeJson(packagePath, packageJson);
    fs.writeFileSync(constantsPath, constantsSource(version), "utf8");
    updateDocumentationVersions(version);
  } catch (error) {
    for (const [fileName, contents] of originals) {
      fs.writeFileSync(fileName, contents);
    }
    throw error;
  }
  console.log(`[version] bumped ${previous} -> ${version} (${level})`);
}

const [command = "verify", argument] = process.argv.slice(2);
try {
  switch (command) {
    case "verify":
      verify();
      break;
    case "generate":
      generate();
      verify();
      break;
    case "bump":
      bump(argument);
      verify();
      break;
    default:
      throw new Error(
        "Usage: version.mjs verify | generate | bump <patch|minor|major>",
      );
  }
} catch (error) {
  console.error(
    `[version:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
