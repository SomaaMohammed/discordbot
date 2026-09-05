import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The production source-identity tool is native ESM JavaScript by design.
// @ts-expect-error It intentionally has no generated declaration file.
import { sourceFiles } from "../../windows/compute-source-identity.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Windows source identity", () => {
  it("rejects symbolic-link or reparse entries in TypeScript sources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-identity-"));
    roots.push(root);
    const sourceRoot = path.join(root, "tsbot", "src");
    const realDirectory = path.join(sourceRoot, "real");
    fs.mkdirSync(realDirectory, { recursive: true });
    fs.writeFileSync(path.join(realDirectory, "entry.ts"), "export {};\n");

    expect(sourceFiles(root, "tsbot/src", ".ts")).toEqual([
      "tsbot/src/real/entry.ts",
    ]);

    fs.symlinkSync(
      realDirectory,
      path.join(sourceRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => sourceFiles(root, "tsbot/src", ".ts")).toThrow(
      /symbolic link or reparse point/,
    );
  });
});
