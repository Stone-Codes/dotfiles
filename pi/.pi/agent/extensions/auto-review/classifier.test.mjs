import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Could not find function ${name}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Could not extract function ${name}`);
}

function loadIsReadOnlyBash() {
  const fnSource = extractFunction("isReadOnlyBash")
    .replace(/function isReadOnlyBash\(command: string\): boolean/, "function isReadOnlyBash(command)");
  return Function(`${fnSource}; return isReadOnlyBash;`)();
}

const isReadOnlyBash = loadIsReadOnlyBash();

const safeCommands = [
  "git ls-files .pi/agent/extensions/pi-markdown-preview/node_modules",
  "git status --ignored --short .pi/agent/extensions/pi-permissions/logs",
  "pi --version",
  "pi list",
  "pi --list-models 'sonnet' | head -20",
  "du -sh .pi/agent/extensions/pi-markdown-preview/node_modules",
  "wc -l .pi/agent/extensions/auto-review/index.ts",
  "for f in .pi/agent/agents/*.md; do echo '---' $f; head -20 \"$f\"; done",
  "printf 'tracked node_modules count: '; git ls-files '.pi/agent/extensions/pi-markdown-preview/node_modules/**' | wc -l\nprintf 'tracked permission log? '; git ls-files '.pi/agent/extensions/pi-permissions/logs/permission-review.jsonl'",
  "find ~/.pi/agent/orchestrator -maxdepth 1 -type f -print -exec sh -c 'echo --- $1; sed -n \"1,120p\" \"$1\"' sh {} \\;",
  "find ~/.pi/agent -maxdepth 2 -type d -name extensions -o -name agents -o -name prompts -o -name skills | sort",
  "git -C /Users/adminfd/dev/dotfiles status --short /Users/adminfd/dev/dotfiles/pi /Users/adminfd/dev/dotfiles/.gitignore | head -100",
  "ls -la ~/.pi/agent/extensions 2>/dev/null || true",
];

for (const command of safeCommands) {
  assert.equal(isReadOnlyBash(command), true, `Expected read-only: ${command}`);
}

const unsafeCommands = [
  "git add .",
  "pi update --all",
  "du -sh . && rm -rf /tmp/example",
  "wc -l file > count.txt",
  "python3 - <<'PY'\nprint('still unclassified for now')\nPY",
];

for (const command of unsafeCommands) {
  assert.equal(isReadOnlyBash(command), false, `Expected unclassified/mutating: ${command}`);
}

assert.match(source, /Unclassified bash commands observed:/, "review task should use the neutral label");
assert.doesNotMatch(source, /Potentially mutating bash commands observed:/, "old misleading label should be removed");

console.log("auto-review classifier tests passed");
