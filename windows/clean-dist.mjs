import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const windowsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(windowsDirectory, "..");
const tsbotRoot = path.join(repositoryRoot, "tsbot");
const distDirectory = path.join(tsbotRoot, "dist");

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertNoSymbolicLinkComponents(target, description) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);

  for (const component of components) {
    current = path.join(current, component);
    const stats = lstatIfPresent(current);
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${description} must not traverse a symbolic link: ${current}`,
      );
    }
  }
}

function removeDirectoryTreeChecked(directory) {
  const initial = lstatIfPresent(directory);
  if (!initial) {
    return;
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    throw new Error(
      `Refusing to recursively clean an unsafe build path: ${directory}`,
    );
  }

  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const stats = lstatIfPresent(entry);
    if (!stats) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to clean a symbolic link in the build tree: ${entry}`,
      );
    }
    if (stats.isDirectory()) {
      removeDirectoryTreeChecked(entry);
      continue;
    }

    const beforeDelete = lstatIfPresent(entry);
    if (!beforeDelete) {
      continue;
    }
    if (beforeDelete.isSymbolicLink() || beforeDelete.isDirectory()) {
      throw new Error(`Build output changed type before cleanup: ${entry}`);
    }
    fs.unlinkSync(entry);
  }

  const beforeDelete = lstatIfPresent(directory);
  if (!beforeDelete) {
    return;
  }
  if (beforeDelete.isSymbolicLink() || !beforeDelete.isDirectory()) {
    throw new Error(`Build output changed type before cleanup: ${directory}`);
  }
  fs.rmdirSync(directory);
}

if (
  path.dirname(distDirectory) !== tsbotRoot ||
  path.basename(distDirectory) !== "dist"
) {
  throw new Error("Refusing to clean an unexpected build directory.");
}

assertNoSymbolicLinkComponents(tsbotRoot, "Build root");
assertNoSymbolicLinkComponents(distDirectory, "Build output");
removeDirectoryTreeChecked(distDirectory);
