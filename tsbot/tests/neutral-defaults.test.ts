import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tsbotRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(tsbotRoot, "..");
const legacyCompatibilityFile = path.join(
  tsbotRoot,
  "src",
  "storage",
  "legacy-v1-settings.ts",
);

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

describe("neutral runtime defaults and bootstrap templates", () => {
  it("quarantines known production snowflakes and greeting targets to v1 migration", () => {
    const legacySource = fs.readFileSync(legacyCompatibilityFile, "utf8");
    const productionSnowflakes = [
      ...new Set(legacySource.match(/\b\d{17,20}\b/g) ?? []),
    ];
    expect(productionSnowflakes.length).toBeGreaterThan(0);

    const activeFiles = [
      ...listFiles(path.join(tsbotRoot, "src")).filter(
        (filePath) => path.resolve(filePath) !== path.resolve(legacyCompatibilityFile),
      ),
      ...listFiles(path.join(repoRoot, "data", "bootstrap")),
    ];
    const violations = activeFiles.flatMap((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return productionSnowflakes
        .filter((snowflake) => source.includes(snowflake))
        .map((snowflake) => ({
          file: path.relative(repoRoot, filePath),
          snowflake,
        }));
    });

    expect(violations).toEqual([]);
    const activeRuntimeText = activeFiles
      .filter((filePath) => filePath.endsWith(".ts"))
      .map((filePath) => fs.readFileSync(filePath, "utf8"))
      .join("\n");
    expect(activeRuntimeText).not.toMatch(/\b(?:rio|taylor)\b/i);
  });

  it("keeps tracked bootstrap JSON parseable and free of live guild state", () => {
    const bootstrapDir = path.join(repoRoot, "data", "bootstrap");
    const state = JSON.parse(
      fs.readFileSync(path.join(bootstrapDir, "state.json"), "utf8"),
    ) as Record<string, unknown>;
    const answers = JSON.parse(
      fs.readFileSync(path.join(bootstrapDir, "answers.json"), "utf8"),
    ) as Record<string, unknown>;
    const questions = JSON.parse(
      fs.readFileSync(path.join(bootstrapDir, "questions.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(state).toMatchObject({
      last_posted_date: null,
      last_dry_run_date: null,
      last_weekly_digest_week: null,
      history: [],
      used_questions: [],
    });
    expect(state).not.toHaveProperty("posts");
    expect(state).not.toHaveProperty("channel_id");
    expect(state).not.toHaveProperty("log_channel_id");
    expect(answers).toEqual({});
    expect(Object.keys(questions).length).toBeGreaterThan(0);
    for (const value of Object.values(questions)) {
      expect(Array.isArray(value)).toBe(true);
      expect((value as unknown[]).every((item) => typeof item === "string")).toBe(
        true,
      );
    }
  });
});
