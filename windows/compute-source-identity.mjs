import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(windowsDirectory, "..");

const exactInputs = [
  ".env.example",
  "tsbot/package-lock.json",
  "tsbot/package.json",
  "tsbot/tsconfig.build.json",
  "tsbot/tsconfig.json",
  "windows/PORTABLE-README.txt",
  "windows/build-portable.ps1",
  "windows/check-portable.mjs",
  "windows/clean-dist.mjs",
  "windows/compute-source-identity.mjs",
  "windows/diagnostics.mjs",
  "windows/launcher/LauncherSupport.cs",
  "windows/launcher/Program.cs",
  "windows/standalone/Program.cs",
  "windows/templates/Start Superior Bot.cmd",
  "windows/write-deterministic-zip.mjs",
];

function sourceFiles(directory, suffix) {
  const absolute = path.join(repositoryRoot, directory);
  const results = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...sourceFiles(relative, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      results.push(relative);
    }
  }
  return results;
}

const inputs = [...exactInputs, ...sourceFiles("tsbot/src", ".ts")].sort();
const hash = crypto.createHash("sha256");
for (const relative of inputs) {
  const absolute = path.join(repositoryRoot, ...relative.split("/"));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`Release identity input is missing: ${relative}`);
  }
  const content = fs.readFileSync(absolute);
  const pathBytes = Buffer.from(relative, "utf8");
  const sizeBytes = Buffer.alloc(8);
  sizeBytes.writeBigUInt64LE(BigInt(content.length));
  hash.update(pathBytes);
  hash.update(Buffer.from([0]));
  hash.update(sizeBytes);
  hash.update(content);
}

process.stdout.write(`${hash.digest("hex")}\n`);
