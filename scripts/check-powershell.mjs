import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const parserCheck = path.resolve(
  scriptDirectory,
  "..",
  "windows",
  "check-powershell-syntax.ps1",
);
const candidates = process.platform === "win32" ? ["pwsh.exe"] : ["pwsh"];

for (const executable of candidates) {
  const arguments_ = ["-NoLogo", "-NoProfile", "-NonInteractive"];
  if (process.platform === "win32") {
    arguments_.push("-ExecutionPolicy", "Bypass");
  }
  arguments_.push("-File", parserCheck);
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  process.exit();
}

throw new Error(
  "PowerShell 7 (pwsh) is required to parse the Windows release scripts.",
);
