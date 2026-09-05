import {
  checkpointDatabase,
  normalizeCheckpointMode,
  type CheckpointMode,
} from "./checkpoint.js";

interface CheckpointArguments {
  readonly dbFile: string;
  readonly mode: CheckpointMode;
  readonly json: boolean;
}

function parseArguments(argv: string[]): CheckpointArguments {
  let dbFile: string | null = null;
  let mode: CheckpointMode = "passive";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--db" && value) {
      dbFile = value;
      index += 1;
      continue;
    }
    if (argument === "--mode" && value) {
      mode = normalizeCheckpointMode(value);
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown or incomplete checkpoint option: ${argument}`);
  }
  if (!dbFile) {
    throw new Error(
      "Usage: db:checkpoint --db <path> [--mode passive|full|restart|truncate] [--json]",
    );
  }
  return { dbFile, mode, json };
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const result = checkpointDatabase(options);
  const output = {
    command: "db:checkpoint",
    status: result.outcome,
    mode: result.mode,
    busyFrames: result.busyFrames,
    logFrames: result.logFrames,
    checkpointedFrames: result.checkpointedFrames,
    durationMs: Math.round(result.durationMs * 1_000) / 1_000,
  };
  if (options.json) {
    console.log(JSON.stringify(output));
  } else {
    console.log(
      `[db:checkpoint] status=${output.status}; mode=${output.mode}; busy=${output.busyFrames}; log=${output.logFrames}; checkpointed=${output.checkpointedFrames}; duration_ms=${output.durationMs}`,
    );
  }
  if (result.outcome === "busy") process.exitCode = 2;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  const json = process.argv.includes("--json");
  if (json) {
    console.error(
      JSON.stringify({
        command: "db:checkpoint",
        status: "failed",
        error: message,
      }),
    );
  } else {
    console.error(`[db:checkpoint][error] ${message}`);
  }
  process.exitCode = 1;
}
