import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourtStorage } from "../src/storage/db.js";
import type { RuntimeConfig } from "../src/types.js";

const temporaryRoots: string[] = [];

function createBootstrapRoot(question: string): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "courtbot-bootstrap-"),
  );
  temporaryRoots.push(repoRoot);

  const bootstrapDir = path.join(repoRoot, "data", "bootstrap");
  fs.mkdirSync(bootstrapDir, { recursive: true });
  fs.writeFileSync(
    path.join(bootstrapDir, "questions.json"),
    JSON.stringify({ general: [question] }),
  );
  fs.writeFileSync(
    path.join(bootstrapDir, "answers.json"),
    JSON.stringify({
      "123": {
        users: {
          "456": {
            answer_message_id: "789",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(bootstrapDir, "state.json"),
    JSON.stringify({
      mode: "manual",
      hour: 10,
      minute: 5,
      channel_id: 999,
      log_channel_id: 0,
      history: [question],
      used_questions: [],
    }),
  );

  return repoRoot;
}

function createStorage(repoRoot: string): CourtStorage {
  const config = {
    dbFile: ":memory:",
    courtChannelId: 1,
    logChannelId: 0,
    timezoneName: "UTC",
  } as unknown as RuntimeConfig;

  return new CourtStorage(config, repoRoot);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("bootstrap JSON migration", () => {
  it("seeds a fresh database from data/bootstrap", () => {
    const repoRoot = createBootstrapRoot("Bootstrap question?");
    const storage = createStorage(repoRoot);

    storage.initStorage();

    expect(storage.getQuestions().general).toEqual(["Bootstrap question?"]);
    expect(storage.getState().history).toEqual(["Bootstrap question?"]);
    expect(storage.countAllAnswerRecords()).toBe(1);
  });

  it("does not overwrite keys already migrated into SQLite", () => {
    const repoRoot = createBootstrapRoot("Original question?");
    const storage = createStorage(repoRoot);
    storage.initStorage();

    fs.writeFileSync(
      path.join(repoRoot, "data", "bootstrap", "questions.json"),
      JSON.stringify({ general: ["Replacement question?"] }),
    );

    storage.initStorage();

    expect(storage.getQuestions().general).toEqual(["Original question?"]);
  });
});
