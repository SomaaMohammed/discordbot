import fs from "node:fs";
import path from "node:path";

export interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface TrustedDirectory {
  readonly resolvedPath: string;
  readonly canonicalPath: string;
  readonly identity: FileIdentity;
}

export function inspectTrustedDirectory(
  directory: string,
  label: string,
): TrustedDirectory {
  const resolvedPath = path.resolve(directory);
  assertExistingPathComponentsAreDirect(resolvedPath, label);
  const metadata = fs.lstatSync(resolvedPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a direct, non-reparse directory`);
  }
  const canonicalPath = fs.realpathSync.native(resolvedPath);
  if (!samePath(canonicalPath, resolvedPath)) {
    throw new Error(`${label} must not traverse a reparse point`);
  }
  return {
    resolvedPath,
    canonicalPath,
    identity: identityFromStats(metadata),
  };
}

export function recheckTrustedDirectory(
  trusted: TrustedDirectory,
  label: string,
): void {
  const current = inspectTrustedDirectory(trusted.resolvedPath, label);
  if (
    !samePath(current.canonicalPath, trusted.canonicalPath) ||
    !sameIdentity(current.identity, trusted.identity)
  ) {
    throw new Error(`${label} changed during the operation`);
  }
}

export function inspectRegularFile(
  fileName: string,
  label: string,
): FileIdentity {
  const metadata = fs.lstatSync(fileName, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a direct regular file`);
  }
  return identityFromStats(metadata);
}

export function assertSameRegularFile(
  fileName: string,
  expected: FileIdentity,
  label: string,
): void {
  const current = inspectRegularFile(fileName, label);
  if (!sameIdentity(current, expected)) {
    throw new Error(`${label} changed during the operation`);
  }
}

export function assertPathConfinedToDirectory(
  trusted: TrustedDirectory,
  candidate: string,
  label: string,
): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(trusted.resolvedPath, resolved);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${label} must be a file inside the configured directory`);
  }
  return resolved;
}

export function assertPathsVacant(
  fileNames: readonly string[],
  label: string,
): void {
  const occupied = fileNames.find(pathEntryExists);
  if (occupied) {
    throw new Error(`${label} already exists: ${occupied}`);
  }
}

export function pathEntryExists(fileName: string): boolean {
  try {
    fs.lstatSync(fileName);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function unlinkVerifiedFile(
  fileName: string,
  expected: FileIdentity,
): void {
  try {
    assertSameRegularFile(fileName, expected, "Cleanup artifact");
    fs.unlinkSync(fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/^\\\\\?\\/u, "");
    return process.platform === "win32"
      ? resolved.toLocaleLowerCase("en-US")
      : resolved;
  };
  return normalize(left) === normalize(right);
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function isSecureEnvironmentFileMode(
  mode: number,
  platform: string = process.platform,
): boolean {
  if (platform === "win32") return true;
  if (!Number.isInteger(mode) || mode < 0) return false;
  const permissions = mode & 0o7777;
  return (
    (permissions & 0o400) !== 0 &&
    (permissions & 0o037) === 0 &&
    (permissions & 0o7000) === 0
  );
}

function assertExistingPathComponentsAreDirect(
  target: string,
  label: string,
): void {
  const root = path.parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a reparse point`);
    }
  }
}

function identityFromStats(metadata: fs.BigIntStats): FileIdentity {
  if (metadata.ino <= 0n) {
    throw new Error(
      "The filesystem does not expose a stable file identity; refusing the safety-sensitive operation",
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
  };
}
