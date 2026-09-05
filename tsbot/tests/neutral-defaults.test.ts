import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsbotRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(tsbotRoot, "..");
function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

describe("neutral source boundaries", () => {
  it("keeps production snowflakes out of source", () => {
    const activeSourceFiles = listFiles(path.join(tsbotRoot, "src"));
    const literalSnowflake = /\b\d{17,20}\b/g;
    const snowflakeViolations = activeSourceFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return [...source.matchAll(literalSnowflake)].map((match) => ({
        file: path.relative(repoRoot, filePath),
        snowflake: match[0],
      }));
    });

    expect(snowflakeViolations).toEqual([]);
  });

  it("limits the former database filename to explicit upgrade safeguards", () => {
    const priorDefault = ["court", "db"].join(".");
    const allowed = new Set([
      "ops.sh",
      "tsbot/src/config.ts",
      "tsbot/tests/config.test.ts",
      "tsbot/tests/ops-regression.test.ts",
      "tsbot/tests/storage-multitenancy.test.ts",
      "tsbot/tests/windows-packaging.test.ts",
    ]);
    const inspectedFiles = [
      ...listFiles(path.join(tsbotRoot, "src")),
      ...listFiles(path.join(tsbotRoot, "tests")),
      path.join(repoRoot, "ops.sh"),
      ...listFiles(path.join(repoRoot, "docs")),
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, ".env.example"),
    ];
    const occurrences = inspectedFiles
      .filter((filePath) =>
        fs.readFileSync(filePath, "utf8").toLowerCase().includes(priorDefault),
      )
      .map((filePath) =>
        path.relative(repoRoot, filePath).replaceAll("\\", "/"),
      )
      .sort();

    expect(occurrences.every((filePath) => allowed.has(filePath))).toBe(true);
  });
});
