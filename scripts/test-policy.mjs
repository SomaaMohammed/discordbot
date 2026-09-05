import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const testsRoot = path.resolve(scriptDirectory, "..", "tsbot", "tests");

function collectTestFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(absolute));
    else if (entry.isFile() && /\.(?:test|spec)\.ts$/u.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

const forbidden = [
  {
    description: "skipped, todo, skipIf, or runIf test API",
    pattern:
      /\b(?:describe|suite|it|test)\s*\.\s*(?:skip|todo|skipIf|runIf)\b/gu,
  },
  {
    description: "x-prefixed disabled test API",
    pattern: /\b(?:xdescribe|xsuite|xit|xtest)\s*\(/gu,
  },
  {
    description: "conditional test-function alias",
    pattern:
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*[^;\n]+\?\s*(?:describe|suite|it|test)\s*:\s*(?:describe|suite|it|test)\b/gu,
  },
];

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

const files = collectTestFiles(testsRoot);
const failures = [];
for (const fileName of files) {
  const text = fs.readFileSync(fileName, "utf8");
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      failures.push(
        `${path.relative(testsRoot, fileName)}:${lineNumber(text, match.index ?? 0)} uses ${rule.description}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `Test policy failed; regression coverage may not be disabled or platform-pseudo-skipped:\n- ${failures.join("\n- ")}`,
  );
}

console.log(
  `[test-policy] ${files.length} test files contain zero skip/todo/skipIf/runIf/x-prefixed or conditional-alias tests`,
);
