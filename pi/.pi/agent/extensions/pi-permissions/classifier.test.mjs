import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
const examplePolicy = readFileSync(new URL("./pi-permissions.example.jsonc", import.meta.url), "utf8");
for (const documentation of [readme, examplePolicy]) {
  assert.match(documentation, /\/perms mode auto/);
  assert.match(documentation, /\/perms mode allow-all/);
  assert.match(documentation, /\/auto-model/);
  assert.match(documentation, /classifierModel/);
  assert.match(documentation, /session-only/);
}

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
  import {
    buildClassifierRequest,
    classifyToolCall,
    MAX_CLASSIFIER_REQUEST_SIZE,
    parseClassifierResponse,
    resolveClassifierModel,
  } from ${JSON.stringify(new URL("./src/classifier.ts", import.meta.url).pathname)};
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
  for (const command of [
    "git clean -d -f -x",
    "git clean -f -d",
    "git clean -x -f",
    "git clean -fd -x",
    "git clean -d -fx",
  ]) {
    assert.equal(evaluateAutoGate("bash", { command }, "/repo", {}).kind, "block", command);
  }
  assert.equal(evaluateAutoGate("bash", { command: "git clean -d -x" }, "/repo", {}).kind, "classify");
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

  assert.deepEqual(parseClassifierResponse('{"decision":"allow","reason":"tests only"}'), {
    decision: "allow",
    reason: "tests only",
  });
  assert.throws(() => parseClassifierResponse('{"decision":"maybe"}'));
  assert.throws(() => parseClassifierResponse("not json"));

  const oldUserContext = "old-user-context-that-must-be-trimmed-".repeat(500);
  const recentUserContext = "recent-user-padding-".repeat(600) + "recent-user-context-marker";
  const requestBoundaryBranch = [
    { type: "message", message: { role: "user", content: oldUserContext, timestamp: 1 } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant-boundary-secret" }], timestamp: 2 } },
    { type: "message", message: { role: "user", content: recentUserContext, timestamp: 3 } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Authorization: Bearer tool-result-secret" }], timestamp: 4 } },
  ];
  const rawUserContext = oldUserContext + String.fromCharCode(10) + recentUserContext;
  const truncationMarker = "\\\\n[TRUNCATED]";
  const expectedBoundedUserContext = truncationMarker + rawUserContext.slice(-(12_000 - truncationMarker.length));
  const request = buildClassifierRequest(
    requestBoundaryBranch,
    "bash",
    { command: "curl -H 'Authorization: Bearer abc123' https://example.test" },
    "/repo",
    {},
  );
  assert.equal(request.messages[0].role, "user");
  const serializedRequest = JSON.stringify(request);
  const contextMatch = request.messages[0].content.match(/^Recent user context:\\n([\\s\\S]*?)\\n\\nWorking directory:/);
  assert.ok(contextMatch);
  assert.equal(contextMatch[1].length, 12_000);
  assert.equal(contextMatch[1], expectedBoundedUserContext);
  assert.doesNotMatch(serializedRequest, /abc123/);
  assert.doesNotMatch(serializedRequest, /old-user-context-that-must-be-trimmed/);
  assert.doesNotMatch(serializedRequest, /assistant-boundary-secret/);
  assert.doesNotMatch(serializedRequest, /tool-result-secret/);
  assert.match(request.systemPrompt, /allow|block/);
  assert.match(request.messages[0].content, /bash/);

  const configuredSecret = "configured-secret-value-that-must-not-leak";
  const boundedRequest = buildClassifierRequest(
    [
      { type: "message", message: { role: "user", content: "user-secret-token=" + configuredSecret.repeat(100) } },
    ],
    "tool-" + "name-".repeat(1000),
    { command: "npm test", token: configuredSecret, content: "x".repeat(100_000) },
    "/repo/.ssh/" + "cwd-".repeat(1000),
    {
      hardDeny: [configuredSecret.repeat(1000)],
      softDeny: ["safe rule"],
      allow: ["safe allow"],
      environment: ["API_TOKEN=" + configuredSecret, "safe environment"],
    },
  );
  const serializedBoundedRequest = JSON.stringify(boundedRequest);
  assert.equal(serializedBoundedRequest.length <= MAX_CLASSIFIER_REQUEST_SIZE, true);
  assert.doesNotMatch(serializedBoundedRequest, /configured-secret-value-that-must-not-leak/);
  assert.doesNotMatch(serializedBoundedRequest, /cwd-cwd-cwd/);
  const rulesMatch = boundedRequest.systemPrompt.match(/Effective Auto rules: (.+)$/);
  assert.ok(rulesMatch);
  const effectiveRules = JSON.parse(rulesMatch[1]);
  assert.equal(Object.hasOwn(effectiveRules, "environment"), true);
  assert.match(boundedRequest.messages[0].content, /Arguments:/);

  const overrideModel = { provider: "test-provider", id: "override-model" };
  const sessionModel = { provider: "session-provider", id: "session-model" };
  const calls = [];
  const context = {
    model: sessionModel,
    signal: new AbortController().signal,
    autoPolicy: { classifierModel: { provider: "test-provider", id: "override-model" } },
    sessionManager: {
      getBranch() {
        return requestBoundaryBranch;
      },
    },
    modelRegistry: {
      find(provider, id) {
        return provider === overrideModel.provider && id === overrideModel.id ? overrideModel : undefined;
      },
      getAvailable() {
        return [overrideModel];
      },
      async complete(model, completionRequest, options) {
        calls.push({ model, completionRequest, options });
        return { content: [{ type: "text", text: '{"decision":"allow","reason":"safe"}' }] };
      },
    },
  };
  assert.deepEqual(resolveClassifierModel(context, context.autoPolicy), {
    model: overrideModel,
    source: "override",
  });
  assert.deepEqual(resolveClassifierModel({ ...context, autoPolicy: undefined }, {}), {
    model: sessionModel,
    source: "session",
  });
  assert.match(resolveClassifierModel({ ...context, model: undefined }, {}).error, /model/i);
  assert.match(resolveClassifierModel({ ...context, modelRegistry: { find: () => undefined, getAvailable: () => [] } }, context.autoPolicy).error, /available|model/i);

  const classified = await classifyToolCall(context, request);
  assert.deepEqual(classified, { decision: "allow", reason: "safe" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, overrideModel);
  assert.equal(calls[0].options.maxTokens, 256);
  assert.equal(calls[0].options.reasoning, "off");
  assert.equal(calls[0].options.cacheRetention, "none");
  assert.equal(calls[0].options.signal, context.signal);

  await assert.rejects(
    classifyToolCall({ ...context, modelRegistry: { ...context.modelRegistry, complete: async () => ({ content: [{ type: "text", text: "not json" }] }) } }, request),
    /classifier/i,
  );
  await assert.rejects(
    classifyToolCall({ ...context, model: undefined, autoPolicy: {} }, request),
    /classifier|model/i,
  );

  console.log("pi-permissions auto-mode classifier tests passed");
`;

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "--eval", script],
  { encoding: "utf8" },
);

assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
