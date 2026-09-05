import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(windowsDirectory, "..");

const exactInputs = [
  ".env.example",
  "scripts/version.mjs",
  "tsbot/bun.lock",
  "tsbot/package.json",
  "tsbot/tsconfig.build.json",
  "tsbot/tsconfig.json",
  "windows/PORTABLE-README.txt",
  "windows/build-portable.ps1",
  "windows/bun-environment.ps1",
  "windows/clean-dist.mjs",
  "windows/compute-source-identity.mjs",
  "windows/hash-utils.ps1",
  "windows/launcher/AuthenticodeSupport.cs",
  "windows/launcher/LauncherSupport.cs",
  "windows/launcher/Program.cs",
  "windows/package-and-run.ps1",
  "windows/path-safety.ps1",
  "windows/release-build.ps1",
  "windows/signing.ps1",
  "windows/standalone/Program.cs",
  "windows/updater/Program.cs",
  "windows/verify-release.ps1",
  "windows/templates/Start Superior Bot.cmd",
  "windows/write-deterministic-zip.mjs",
];

function inspectRepositoryPath(root, relative) {
  const components = relative.split("/");
  if (
    path.isAbsolute(relative) ||
    components.some(
      (component) =>
        component === "" || component === "." || component === "..",
    )
  ) {
    throw new Error(`Release identity input has an unsafe path: ${relative}`);
  }

  let absolute = path.resolve(root);
  let status;
  for (const component of components) {
    absolute = path.join(absolute, component);
    try {
      status = fs.lstatSync(absolute);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`Release identity input is missing: ${relative}`);
      }
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new Error(
        `Release identity input must not contain a symbolic link or reparse point: ${relative}`,
      );
    }
  }
  return { absolute, status };
}

export function sourceFiles(root, directory, suffix) {
  const inspectedDirectory = inspectRepositoryPath(root, directory);
  if (!inspectedDirectory.status.isDirectory()) {
    throw new Error(
      `Release source directory is not a regular directory: ${directory}`,
    );
  }

  const results = [];
  for (const name of fs.readdirSync(inspectedDirectory.absolute)) {
    const relative = path.posix.join(directory, name);
    const inspectedEntry = inspectRepositoryPath(root, relative);
    if (inspectedEntry.status.isDirectory()) {
      results.push(...sourceFiles(root, relative, suffix));
    } else if (inspectedEntry.status.isFile()) {
      if (name.endsWith(suffix)) {
        results.push(relative);
      }
    } else {
      throw new Error(
        `Release source entry is not a regular file or directory: ${relative}`,
      );
    }
  }
  return results;
}

export function computeSourceIdentity(root = repositoryRoot) {
  const inputs = [
    ...exactInputs,
    ...sourceFiles(root, "tsbot/src", ".ts"),
  ].sort();
  const hash = crypto.createHash("sha256");
  for (const relative of inputs) {
    const inspected = inspectRepositoryPath(root, relative);
    if (!inspected.status.isFile()) {
      throw new Error(
        `Release identity input is not a regular file: ${relative}`,
      );
    }
    const content = fs.readFileSync(inspected.absolute);
    const pathBytes = Buffer.from(relative, "utf8");
    const sizeBytes = Buffer.alloc(8);
    sizeBytes.writeBigUInt64LE(BigInt(content.length));
    hash.update(pathBytes);
    hash.update(Buffer.from([0]));
    hash.update(sizeBytes);
    hash.update(content);
  }
  return hash.digest("hex");
}

if (import.meta.main) {
  process.stdout.write(`${computeSourceIdentity()}\n`);
}
