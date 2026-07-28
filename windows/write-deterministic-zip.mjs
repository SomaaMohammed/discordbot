import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [sourceArgument, archiveArgument] = process.argv.slice(2);
if (!sourceArgument || !archiveArgument || process.argv.length !== 4) {
  throw new Error(
    "Usage: node write-deterministic-zip.mjs <source-directory> <archive.zip>",
  );
}

const sourceDirectory = path.resolve(sourceArgument);
const archivePath = path.resolve(archiveArgument);
const archiveBase = path.dirname(sourceDirectory);

if (!fs.statSync(sourceDirectory).isDirectory()) {
  throw new Error(`ZIP source is not a directory: ${sourceDirectory}`);
}
if (
  archivePath === sourceDirectory ||
  archivePath.startsWith(`${sourceDirectory}${path.sep}`)
) {
  throw new Error("The ZIP output must be outside the source directory.");
}
if (fs.existsSync(archivePath)) {
  throw new Error(`Refusing to overwrite an existing ZIP: ${archivePath}`);
}

const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const ZIP_VERSION = 20;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function collectFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`ZIP input contains a non-file entry: ${absolutePath}`);
    }
    files.push(absolutePath);
  }
  return files;
}

function toEntryName(filePath) {
  const relative = path
    .relative(archiveBase, filePath)
    .split(path.sep)
    .join("/");
  if (
    !relative ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`ZIP input escaped its expected root: ${filePath}`);
  }
  return relative;
}

function checkedUInt32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${label} exceeds the non-ZIP64 archive limit.`);
  }
  return value;
}

const files = collectFiles(sourceDirectory)
  .map((filePath) => ({ filePath, entryName: toEntryName(filePath) }))
  .sort((left, right) =>
    left.entryName < right.entryName
      ? -1
      : left.entryName > right.entryName
        ? 1
        : 0,
  );

if (files.length > UINT16_MAX) {
  throw new Error(
    "The portable artifact has too many files for non-ZIP64 output.",
  );
}

fs.mkdirSync(path.dirname(archivePath), { recursive: true });
const archive = fs.openSync(archivePath, "wx");
const centralEntries = [];
let archiveOffset = 0;

function write(buffer) {
  let written = 0;
  while (written < buffer.length) {
    const count = fs.writeSync(
      archive,
      buffer,
      written,
      buffer.length - written,
    );
    if (count <= 0) {
      throw new Error("Unable to finish writing the deterministic ZIP.");
    }
    written += count;
  }
  archiveOffset += buffer.length;
}

try {
  for (const { filePath, entryName } of files) {
    const name = Buffer.from(entryName, "utf8");
    if (name.length > UINT16_MAX) {
      throw new Error(`ZIP entry name is too long: ${entryName}`);
    }

    const contents = fs.readFileSync(filePath);
    const compressed = zlib.deflateRawSync(contents, {
      level: 9,
      memLevel: 8,
      strategy: zlib.constants.Z_DEFAULT_STRATEGY,
      windowBits: 15,
    });
    const checksum = crc32(contents);
    const uncompressedSize = checkedUInt32(contents.length, entryName);
    const compressedSize = checkedUInt32(compressed.length, entryName);
    const localOffset = checkedUInt32(archiveOffset, "ZIP local-header offset");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    write(localHeader);
    write(name);
    write(compressed);
    centralEntries.push({
      checksum,
      compressedSize,
      entryName,
      localOffset,
      name,
      uncompressedSize,
    });
  }

  const centralOffset = checkedUInt32(
    archiveOffset,
    "ZIP central-directory offset",
  );
  for (const entry of centralEntries) {
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(entry.checksum, 16);
    centralHeader.writeUInt32LE(entry.compressedSize, 20);
    centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
    centralHeader.writeUInt16LE(entry.name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(entry.localOffset, 42);
    write(centralHeader);
    write(entry.name);
  }

  const centralSize = checkedUInt32(
    archiveOffset - centralOffset,
    "ZIP central-directory size",
  );
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(centralEntries.length, 8);
  endRecord.writeUInt16LE(centralEntries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  write(endRecord);
} catch (error) {
  fs.closeSync(archive);
  fs.rmSync(archivePath, { force: true });
  throw error;
}

fs.closeSync(archive);
