import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CourtStorage } from "../src/storage/db.js";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";
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
  return repoRoot;
}

function createStorage(repoRoot: string): CourtStorage {
  const storage = new CourtStorage({ dbFile: ":memory:" }, repoRoot);
  storage.initStorage();
  return storage;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("per-guild bootstrap", () => {
  it("copies questions only when a guild initializes the court feature", () => {
    const repoRoot = createBootstrapRoot("Bootstrap question?");
    const storage = createStorage(repoRoot);
    storage.ensureGuild(GUILD_A, "A");
    const guild = storage.forGuild(GUILD_A);

    expect(guild.getQuestions().general).toEqual([]);
    expect(guild.initializeCourtQuestions()).toBe(true);
    expect(guild.initializeCourtQuestions()).toBe(false);
    expect(guild.getQuestions().general).toEqual(["Bootstrap question?"]);
    expect(guild.getState().history).toEqual([]);
    expect(guild.countAllAnswerRecords()).toBe(0);
    storage.close();
  });

  it("gives two guilds independent copies of the same template", () => {
    const repoRoot = createBootstrapRoot("Shared seed?");
    const storage = createStorage(repoRoot);
    storage.ensureGuild(GUILD_A);
    storage.ensureGuild(GUILD_B);
    const guildA = storage.forGuild(GUILD_A);
    const guildB = storage.forGuild(GUILD_B);
    guildA.initializeCourtQuestions();
    guildB.initializeCourtQuestions();

    guildA.setQuestions({ general: ["Only A?"] });

    expect(guildA.getQuestions().general).toEqual(["Only A?"]);
    expect(guildB.getQuestions().general).toEqual(["Shared seed?"]);
    storage.close();
  });
});
