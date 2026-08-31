import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const modulePath = new URL("./src/auto-mode.ts", import.meta.url).pathname;
const script = `
  import assert from "node:assert/strict";
  import {
    evaluateAutoGate,
    isSafeReadOnlyBashCommand,
    redactSensitiveText,
    recordAutoDenial,
    resetAutoDenials,
  } from ${JSON.stringify(modulePath)};
  import { createInitialSessionPermissionState } from ${JSON.stringify(new URL("./types.ts", import.meta.url).pathname)};

  const isSafeReadOnlyBash = isSafeReadOnlyBashCommand;

  assert.equal(isSafeReadOnlyBash("git status --short"), true);
  assert.equal(isSafeReadOnlyBash("git status --short > status.txt"), false);
  assert.equal(isSafeReadOnlyBash("git reset --hard"), false);
  assert.equal(isSafeReadOnlyBash("sort -oout.txt input.txt"), false);
  assert.equal(isSafeReadOnlyBash("sort --output=out.txt input.txt"), false);
  assert.equal(isSafeReadOnlyBash("uniq -ofile input.txt"), false);
  assert.equal(isSafeReadOnlyBash("git diff --output=out.txt"), false);
  assert.equal(isSafeReadOnlyBash("git diff -o out.txt"), false);
  assert.equal(isSafeReadOnlyBash("find . -exec cat {} \\;"), false);
  assert.equal(isSafeReadOnlyBash("find . -delete"), false);
  assert.equal(isSafeReadOnlyBash("sed -i s/old/new/ input.txt"), false);
  assert.equal(evaluateAutoGate("read", { path: ".env" }, "/repo", {}).kind, "block");
  assert.equal(evaluateAutoGate("grep", { pattern: "x", path: "src" }, "/repo", {}).kind, "allow");
  assert.equal(redactSensitiveText("Authorization: Bearer abc123"), "Authorization: Bearer [REDACTED]");

  const redactedJson = redactSensitiveText(JSON.stringify({
    password: "nested-password",
    nested: {
      apiKey: "nested-api-key",
      metadata: { token: "nested-token", safe: "visible" },
    },
    authorization: "Bearer nested-bearer-token",
  }));
  const parsedRedactedJson = JSON.parse(redactedJson);
  assert.deepEqual(parsedRedactedJson, {
    password: "[REDACTED]",
    nested: {
      apiKey: "[REDACTED]",
      metadata: { token: "[REDACTED]", safe: "visible" },
    },
    authorization: "[REDACTED]",
  });
  assert.doesNotMatch(redactedJson, /nested-(?:password|api-key|token|bearer-token)/);

  assert.equal(evaluateAutoGate("ls", { path: ".pi/agent/auth.json" }, "/repo", {}).kind, "block");
  assert.equal(evaluateAutoGate("bash", { command: "git clean -fdx" }, "/repo", {}).kind, "block");
  assert.equal(evaluateAutoGate("write", { path: "src/file.ts", content: "x" }, "/repo", {}).kind, "classify");
  assert.equal(evaluateAutoGate("mcp", { server: "docs", tool: "search" }, "/repo", {}).kind, "classify");
  assert.equal(evaluateAutoGate("bash", { command: "git push --force" }, "/repo", {}).kind, "block");
  assert.equal(evaluateAutoGate("bash", { command: "npm install" }, "/repo", {}).kind, "classify");

  const initial = createInitialSessionPermissionState();
  const first = recordAutoDenial(initial);
  assert.equal(first.disable, false);
  assert.equal(first.state.totalAutoDenials, 1);
  assert.equal(first.state.consecutiveAutoDenials, 1);
  const second = recordAutoDenial(first.state);
  const third = recordAutoDenial(second.state);
  assert.equal(third.disable, true);
  assert.equal(third.state.consecutiveAutoDenials, 3);

  const nineteenth = { ...initial, totalAutoDenials: 19, consecutiveAutoDenials: 1 };
  const twentieth = recordAutoDenial(nineteenth);
  assert.equal(twentieth.disable, true);
  assert.equal(twentieth.state.totalAutoDenials, 20);

  const reset = resetAutoDenials(twentieth.state);
  assert.equal(reset.consecutiveAutoDenials, 0);
  assert.equal(reset.totalAutoDenials, 20);
  assert.equal(twentieth.state.consecutiveAutoDenials, 2);

  console.log("pi-permissions auto-mode classifier tests passed");
`;

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "--eval", script],
  { encoding: "utf8" },
);

assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
