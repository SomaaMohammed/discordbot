import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function trackedMarkdownFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((fileName) => fileName.replaceAll("\\", "/"));
}

function withoutFencedCode(markdown) {
  let fence;
  const withoutFences = markdown
    .split("\n")
    .map((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (!fence && match) {
        fence = { character: match[1][0], length: match[1].length };
        return "";
      }
      if (
        fence &&
        new RegExp(
          `^ {0,3}${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
          "u",
        ).test(line)
      ) {
        fence = undefined;
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
  return withoutFences.replace(/<!--[\s\S]*?-->/gu, (comment) =>
    comment.replace(/[^\n]/gu, ""),
  );
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function markdownDestinations(markdown) {
  const text = withoutFencedCode(markdown);
  const destinations = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`") {
      let ticks = 1;
      while (text[index + ticks] === "`") ticks += 1;
      const closing = text.indexOf("`".repeat(ticks), index + ticks);
      if (closing >= 0) index = closing + ticks - 1;
      continue;
    }
    if (text[index] !== "]" || text[index + 1] !== "(") continue;

    let cursor = index + 2;
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
    const destinationOffset = cursor;
    let destination = "";
    if (text[cursor] === "<") {
      cursor += 1;
      const start = cursor;
      while (cursor < text.length && text[cursor] !== ">") cursor += 1;
      if (cursor < text.length) destination = text.slice(start, cursor);
    } else {
      const start = cursor;
      let nestedParentheses = 0;
      while (cursor < text.length) {
        const character = text[cursor];
        if (character === "\\") {
          cursor += 2;
          continue;
        }
        if (character === "(") nestedParentheses += 1;
        if (character === ")") {
          if (nestedParentheses === 0) break;
          nestedParentheses -= 1;
        }
        if (/\s/u.test(character) && nestedParentheses === 0) break;
        cursor += 1;
      }
      destination = text.slice(start, cursor);
    }
    if (destination) {
      destinations.push({
        destination: destination.replaceAll(/\\([() ])/gu, "$1"),
        line: lineNumber(text, destinationOffset),
      });
    }
  }

  for (const match of text.matchAll(
    /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gmu,
  )) {
    destinations.push({
      destination: match[1] ?? match[2],
      line: lineNumber(text, match.index ?? 0),
    });
  }
  for (const match of text.matchAll(
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu,
  )) {
    destinations.push({
      destination: match[1],
      line: lineNumber(text, match.index ?? 0),
    });
  }
  return destinations;
}

function githubSlug(heading) {
  return heading
    .replace(/<[^>]*>/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

const anchorCache = new Map();

function markdownAnchors(fileName) {
  const cached = anchorCache.get(fileName);
  if (cached) return cached;

  const text = withoutFencedCode(fs.readFileSync(fileName, "utf8"));
  const lines = text.split("\n");
  const anchors = new Set();
  const occurrences = new Map();
  const addHeading = (heading) => {
    const base = githubSlug(heading);
    if (!base) return;
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const atx = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u.exec(lines[index]);
    if (atx) addHeading(atx[1]);
    if (
      index > 0 &&
      /^ {0,3}(?:=+|-+)\s*$/u.test(lines[index]) &&
      lines[index - 1].trim()
    ) {
      addHeading(lines[index - 1].trim());
    }
  }
  for (const match of text.matchAll(
    /\b(?:id|name)\s*=\s*["']([^"']+)["']/giu,
  )) {
    anchors.add(match[1]);
  }
  anchorCache.set(fileName, anchors);
  return anchors;
}

function decode(value, source, line, failures) {
  try {
    return decodeURIComponent(value);
  } catch {
    failures.push(
      `${source}:${line}: malformed percent-encoding in '${value}'`,
    );
    return undefined;
  }
}

function main() {
  const markdownFiles = trackedMarkdownFiles();
  const failures = [];
  let checkedLinks = 0;

  for (const source of markdownFiles) {
    const sourcePath = path.join(repositoryRoot, source);
    const markdown = fs.readFileSync(sourcePath, "utf8");
    for (const { destination, line } of markdownDestinations(markdown)) {
      if (
        /^[a-z][a-z\d+.-]*:/iu.test(destination) ||
        destination.startsWith("//")
      ) {
        continue;
      }

      const hashIndex = destination.indexOf("#");
      const rawFragment =
        hashIndex >= 0 ? destination.slice(hashIndex + 1) : "";
      const beforeFragment =
        hashIndex >= 0 ? destination.slice(0, hashIndex) : destination;
      const rawPath = beforeFragment.split("?", 1)[0];
      const decodedPath = decode(rawPath, source, line, failures);
      const fragment = decode(rawFragment, source, line, failures);
      if (decodedPath === undefined || fragment === undefined) continue;

      const targetPath = rawPath
        ? decodedPath.startsWith("/")
          ? path.resolve(
              repositoryRoot,
              decodedPath.slice(1).replaceAll("/", path.sep),
            )
          : path.resolve(
              path.dirname(sourcePath),
              decodedPath.replaceAll("/", path.sep),
            )
        : sourcePath;
      const relativeTarget = path.relative(repositoryRoot, targetPath);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        failures.push(
          `${source}:${line}: local link escapes the repository: '${destination}'`,
        );
        continue;
      }
      if (!fs.existsSync(targetPath)) {
        failures.push(
          `${source}:${line}: missing local link target: '${destination}'`,
        );
        continue;
      }
      checkedLinks += 1;

      if (
        fragment &&
        fs.statSync(targetPath).isFile() &&
        path.extname(targetPath).toLowerCase() === ".md" &&
        !markdownAnchors(targetPath).has(fragment)
      ) {
        failures.push(
          `${source}:${line}: missing Markdown anchor '#${fragment}' in '${destination}'`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Local Markdown link check failed:\n- ${failures.join("\n- ")}`,
    );
  }
  console.log(
    `[docs] verified ${checkedLinks} local links across ${markdownFiles.length} tracked Markdown files`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[docs:error] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
