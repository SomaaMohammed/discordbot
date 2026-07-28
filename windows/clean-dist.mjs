import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(windowsDirectory, "..");
const tsbotRoot = path.join(repositoryRoot, "tsbot");
const distDirectory = path.join(tsbotRoot, "dist");

if (
  path.dirname(distDirectory) !== tsbotRoot ||
  path.basename(distDirectory) !== "dist"
) {
  throw new Error("Refusing to clean an unexpected build directory.");
}

fs.rmSync(distDirectory, { recursive: true, force: true });
