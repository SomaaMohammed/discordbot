import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRoot = path.join(repositoryRoot, "tsbot", "dist", "src");
if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Production build is missing: ${sourceRoot}`);
}

const files = fs
  .readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort((left, right) => left.localeCompare(right, "en"));
if (files.length === 0) {
  throw new Error("Production build contains no JavaScript files");
}

const transpiler = new Bun.Transpiler({ loader: "js", target: "bun" });
for (const fileName of files) {
  transpiler.transformSync(fs.readFileSync(fileName, "utf8"));
}

console.log(`[syntax] Bun parsed ${files.length} production JavaScript files`);
