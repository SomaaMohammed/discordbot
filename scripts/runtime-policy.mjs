import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const tsbotRoot = path.join(repositoryRoot, "tsbot");
const packagePath = path.join(tsbotRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const failures = [];

for (const dependency of ["better-sqlite3", "@types/better-sqlite3", "tsx"]) {
  if (
    Object.hasOwn(packageJson.dependencies ?? {}, dependency) ||
    Object.hasOwn(packageJson.devDependencies ?? {}, dependency)
  ) {
    failures.push(`forbidden compatibility dependency remains: ${dependency}`);
  }
}

if (packageJson.packageManager !== "bun@1.4.0") {
  failures.push("packageManager must pin bun@1.4.0");
}
if (packageJson.engines?.bun !== ">=1.4.0" || packageJson.engines?.node) {
  failures.push("engines must support Bun >=1.4.0 without a Node fallback");
}
if (fs.existsSync(path.join(tsbotRoot, "package-lock.json"))) {
  failures.push("package-lock.json must not coexist with bun.lock");
}

const bunLock = fs.readFileSync(path.join(tsbotRoot, "bun.lock"), "utf8");
if (
  /better-sqlite3|@types\/better-sqlite3/iu.test(bunLock) ||
  /^\s*"tsx":\s*\["tsx@/mu.test(bunLock)
) {
  failures.push("bun.lock contains a removed Node SQLite or tsx dependency");
}

for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
  if (/\b(?:node|npm|npx|tsx)(?:\.cmd|\.exe)?\b/iu.test(String(script))) {
    failures.push(`package script ${name} invokes a forbidden Node tool`);
  }
}

const productionFiles = [];
function collectProductionFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectProductionFiles(absolute);
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      productionFiles.push(absolute);
    }
  }
}
collectProductionFiles(path.join(tsbotRoot, "src"));
for (const fileName of productionFiles) {
  const source = fs.readFileSync(fileName, "utf8");
  if (/better-sqlite3/iu.test(source)) {
    failures.push(
      `production source references better-sqlite3: ${path.relative(repositoryRoot, fileName)}`,
    );
  }
}

const databaseSource = fs.readFileSync(
  path.join(tsbotRoot, "src", "storage", "database.ts"),
  "utf8",
);
if (
  !/import\s+\{[^}]*Database[^}]*\}\s+from\s+["']bun:sqlite["']/su.test(
    databaseSource,
  )
) {
  failures.push(
    "the production database adapter must statically import bun:sqlite",
  );
}
if (/createRequire|require\s*\(\s*["']bun:sqlite/iu.test(databaseSource)) {
  failures.push(
    "the production database adapter contains a dynamic runtime fallback",
  );
}

for (const operatorFile of ["ops.sh"]) {
  const source = fs.readFileSync(
    path.join(repositoryRoot, operatorFile),
    "utf8",
  );
  if (/\b(?:node|npm|npx|tsx)(?:\.cmd|\.exe)?\b/iu.test(source)) {
    failures.push(`${operatorFile} invokes a forbidden Node tool`);
  }
}

if (failures.length > 0) {
  throw new Error(`Runtime policy failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `[runtime-policy] bun:sqlite static import, Bun 1.4.0 metadata, ${productionFiles.length} production TypeScript files, lockfile, scripts, and operator runtimes passed`,
);
