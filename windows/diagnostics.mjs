import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function safe(value, maximumLength = 2048) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, maximumLength);
  return normalized || "(none)";
}

function emit(name, value) {
  console.log(`[diagnostics] ${name}=${safe(value)}`);
}

function resolveFromRoot(root, configured, fallback) {
  const value = String(configured ?? "").trim() || fallback;
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(root, value);
}

function readEnvironment(environmentFile) {
  if (!fs.existsSync(environmentFile)) {
    return {};
  }
  const values = {};
  for (const rawLine of fs
    .readFileSync(environmentFile, "utf8")
    .split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^export\s+/u, "");
    const separator = line.indexOf("=");
    if (separator <= 0 || line.startsWith("#")) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trimEnd();
    }
    values[key] = value;
  }
  return values;
}

async function classifyDatabase(portableRoot, databaseFile) {
  if (process.env.SUPERIOR_DIAGNOSTICS_SKIP_DATABASE === "1") {
    return "skipped";
  }
  if (!fs.existsSync(databaseFile)) {
    return "missing (not opened)";
  }
  const sqliteModuleUrl = pathToFileURL(
    path.join(
      portableRoot,
      "app",
      "node_modules",
      "better-sqlite3",
      "lib",
      "index.js",
    ),
  ).href;
  const schemaModuleUrl = pathToFileURL(
    path.join(portableRoot, "app", "dist", "src", "storage", "schema.js"),
  ).href;
  const [{ default: Database }, { detectDatabaseSchema }] = await Promise.all([
    import(sqliteModuleUrl),
    import(schemaModuleUrl),
  ]);
  const database = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return detectDatabaseSchema(database);
  } finally {
    database.close();
  }
}

async function main() {
  const portableRoot = path.resolve(
    process.env.SUPERIOR_PAYLOAD_ROOT ??
      path.resolve(import.meta.dirname, ".."),
  );
  const applicationRoot = path.resolve(
    process.env.SUPERIOR_APPLICATION_ROOT ?? portableRoot,
  );
  const environmentFile = resolveFromRoot(
    applicationRoot,
    process.env.ENV_FILE,
    ".env",
  );
  const fileEnvironment = readEnvironment(environmentFile);
  const databaseFile = resolveFromRoot(
    applicationRoot,
    process.env.DB_FILE ?? fileEnvironment.DB_FILE,
    "superior.db",
  );
  const registrationMode = String(
    process.env.COMMAND_REGISTRATION_MODE ??
      fileEnvironment.COMMAND_REGISTRATION_MODE ??
      "global",
  )
    .trim()
    .toLowerCase();
  const safeRegistrationMode = ["global", "guild"].includes(registrationMode)
    ? registrationMode
    : "invalid";
  const devGuildCount = String(
    process.env.DEV_GUILD_IDS ?? fileEnvironment.DEV_GUILD_IDS ?? "",
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean).length;

  emit("executableVersion", process.env.SUPERIOR_EXECUTABLE_VERSION);
  emit("executablePath", process.env.SUPERIOR_EXECUTABLE_PATH);
  emit("payloadVersion", process.env.SUPERIOR_PAYLOAD_VERSION);
  emit("payloadSha256", process.env.SUPERIOR_PAYLOAD_SHA256);
  emit("sourceSha256", process.env.SUPERIOR_SOURCE_SHA256);
  emit("payloadCache", process.env.SUPERIOR_PAYLOAD_CACHE);
  emit("nodeVersion", process.version);
  emit("applicationRoot", applicationRoot);
  emit("configFile", environmentFile);
  emit("configPresent", fs.existsSync(environmentFile));
  emit("databasePath", databaseFile);
  try {
    emit("databaseSchema", await classifyDatabase(portableRoot, databaseFile));
  } catch (error) {
    emit(
      "databaseSchema",
      `unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  emit("commandRegistrationMode", safeRegistrationMode);
  emit("developmentGuildCount", devGuildCount);
  console.log(
    "[diagnostics] completed without Discord login; token and private watcher values were not displayed",
  );
}

main().catch((error) => {
  console.error(
    `[diagnostics:error] ${safe(error instanceof Error ? error.message : error)}`,
  );
  process.exitCode = 1;
});
