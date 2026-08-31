import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const extensionDir = new URL(".", import.meta.url);
const source = readFileSync(new URL("./types.ts", extensionDir), "utf8");
const indexSource = readFileSync(new URL("./index.ts", extensionDir), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("./package.json", extensionDir), "utf8"));

assert.equal(packageJson.dependencies["proper-lockfile"], "^4.1.2");
assert.match(indexSource, /mode === "allow-all"/);
assert.match(indexSource, /mode === "manual"/);
assert.match(indexSource, /mode === "auto"/);
assert.match(indexSource, /registerCommand\("auto-model"/);
assert.match(indexSource, /registerCommand\("auto"/);
assert.match(indexSource, /registerCommand\("perms"/);
assert.match(indexSource, /consecutiveAutoDenials/);
assert.match(indexSource, /ctx\.modelRegistry\.complete/);
assert.match(indexSource, /allowedPatterns = \[\]/);
assert.match(indexSource, /resetAutoDenials/);
assert.match(indexSource, /Classifier unavailable; Auto mode did not approve this action\./);
assert.match(indexSource, /function setMode[\s\S]*?sessionState\.allowedPatterns = \[\][\s\S]*?resetAutoDenials/);
assert.doesNotMatch(indexSource, /setMode[\s\S]{0,200}updatePolicyFile/);
assert.equal(source.includes('type PermissionMode = "manual" | "auto" | "allow-all"'), true);
assert.equal(source.includes('mode: "manual"'), true);
assert.equal(source.includes("consecutiveAutoDenials"), true);
assert.equal(source.includes("classifierModel"), true);

const stateScript = `
    import { createInitialSessionPermissionState } from ${JSON.stringify(new URL("./types.ts", extensionDir).pathname)};
    console.log(JSON.stringify(createInitialSessionPermissionState()));
  `;
const stateResult = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--input-type=module", "--eval", stateScript],
  { encoding: "utf8" },
);
assert.equal(stateResult.status, 0, stateResult.stderr || stateResult.stdout);
const initialState = JSON.parse(stateResult.stdout);
assert.equal(initialState.mode, "manual");
assert.equal(initialState.consecutiveAutoDenials, 0);
assert.equal(initialState.totalAutoDenials, 0);

const parserLoaderDir = mkdtempSync(join(tmpdir(), "pi-permissions-parser-"));
const parserLoaderPath = join(parserLoaderDir, "loader.mjs");
writeFileSync(parserLoaderPath, `export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !specifier.match(/\\.[a-z]+$/)) return nextResolve(specifier + ".ts", context);
    return nextResolve(specifier, context);
  }\n`);
const parserScript = `
    import assert from "node:assert/strict";
    import { parsePermissionModeCommand } from ${JSON.stringify(new URL("./index.ts", extensionDir).pathname)};
    assert.equal(parsePermissionModeCommand("mode manual"), "manual");
    assert.equal(parsePermissionModeCommand(" mode AUTO "), "auto");
    assert.equal(parsePermissionModeCommand("mode allow-all"), "allow-all");
    assert.equal(parsePermissionModeCommand("mode nope"), undefined);
    console.log("permission mode parser passed");
  `;
const parserResult = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--experimental-loader", parserLoaderPath, "--input-type=module", "--eval", parserScript],
  { cwd: extensionDir.pathname, encoding: "utf8" },
);
rmSync(parserLoaderDir, { recursive: true, force: true });
assert.equal(parserResult.status, 0, parserResult.stderr || parserResult.stdout);
assert.match(parserResult.stdout, /permission mode parser passed/);

function runExtensionScenario(policy, scenario) {
  const scenarioDir = mkdtempSync(join(tmpdir(), "pi-permissions-extension-"));
  const homeDir = join(scenarioDir, "home");
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "pi-permissions.jsonc"), `${JSON.stringify(policy)}\n`);
  const loaderPath = join(scenarioDir, "loader.mjs");
  writeFileSync(loaderPath, `export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !specifier.match(/\\.[a-z]+$/)) return nextResolve(specifier + ".ts", context);
      return nextResolve(specifier, context);
    }\n`);
  const script = `
    import assert from "node:assert/strict";
    import extension from ${JSON.stringify(new URL("./index.ts", extensionDir).pathname)};
    const handlers = new Map();
    const commands = new Map();
    const statuses = [];
    const notifications = [];
    let completions = 0;
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(name, command) { commands.set(name, command); },
      getAllTools() { return [{ name: "read" }, { name: "write" }, { name: "bash" }]; },
      setActiveTools() {},
    };
    extension(pi);
    const model = { provider: "test", id: "classifier" };
    const ctx = {
      cwd: "/repo",
      hasUI: false,
      model,
      ui: {
        setStatus(_id, text) { statuses.push(text); },
        notify(message) { notifications.push(message); },
        async confirm() { return false; },
        async select() { return "No"; },
      },
      sessionManager: { getBranch() { return []; } },
      modelRegistry: {
        find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
        getAvailable() { return [model]; },
        async complete() {
          completions += 1;
          return { content: [{ type: "text", text: JSON.stringify({ decision: "block", reason: "classifier test denial" }) }] };
        },
      },
    };
    await handlers.get("session_start")({}, ctx);
    ${scenario}
    console.log(JSON.stringify({ statuses, notifications, completions }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--experimental-loader", loaderPath, "--input-type=module", "--eval", script],
    { cwd: extensionDir.pathname, env: { ...process.env, HOME: homeDir }, encoding: "utf8" },
  );
  rmSync(scenarioDir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\\n").at(-1));
}

const dispatch = runExtensionScenario(
  {
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask" },
    tools: { execute: "deny" },
    auto: { softDeny: ["write", "Bash(*)"], allow: ["write", "Bash(*)"] },
  },
  `
    await commands.get("perms").handler("mode auto", ctx);
    const allowed = await handlers.get("tool_call")({ toolName: "write", input: { path: "src/file.ts", content: "x" } }, ctx);
    assert.equal(allowed, undefined);
    const denied = await handlers.get("tool_call")({ toolName: "execute", input: { command: "run" } }, ctx);
    assert.match(denied.reason, /permission policy/);
    const broadBash = await handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install" } }, ctx);
    assert.match(broadBash.reason, /classifier test denial/);
    assert.equal(completions, 1);
  `,
);
assert.equal(dispatch.completions, 1);
assert.match(dispatch.statuses.at(-1), /^AUTO/);

const reset = runExtensionScenario(
  {
    defaultPolicy: { tools: "ask", bash: "ask", mcp: "ask", skills: "ask" },
  },
  `
    await commands.get("perms-allow-similar").handler("write", ctx);
    await commands.get("perms").handler("mode auto", ctx);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await handlers.get("tool_call")({ toolName: "write", input: { path: "src/file.ts", content: "x" } }, ctx);
      assert.match(result.reason, /classifier test denial/);
    }
    await commands.get("perms").handler("mode manual", ctx);
    await commands.get("perms").handler("mode auto", ctx);
    const afterReset = await handlers.get("tool_call")({ toolName: "write", input: { path: "src/file.ts", content: "x" } }, ctx);
    assert.match(afterReset.reason, /classifier test denial/);
    assert.match(statuses.at(-1), /^AUTO/);
  `,
);
assert.match(reset.statuses.at(-1), /^AUTO/);

const fixtureDir = mkdtempSync(join(tmpdir(), "pi-permissions-mode-"));
const policyPath = join(fixtureDir, "pi-permissions.jsonc");
const configPath = new URL("./src/config.ts", extensionDir).pathname;
const configSource = readFileSync(new URL("./src/config.ts", extensionDir), "utf8");
assert.match(
  configSource,
  /PolicyDocument = PermissionPolicy & Record<string, unknown>/,
);
assert.match(configSource, /updatePolicyFile\(filePath: string, update: PolicyUpdater\): Promise<void>/);
assert.doesNotMatch(configSource, /\.recovery|acquireRecoveryMarker|removeStaleLock/);

try {
  writeFileSync(
    policyPath,
    `{
      // Keep this existing policy and unrelated setting.
      "defaultPolicy": { "tools": "ask", "bash": "deny", "mcp": "ask", "skills": "ask" },
      "unrelated": { "keep": true }
    }\n`,
  );

  const loaderPath = join(fixtureDir, "loader.mjs");
  writeFileSync(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && !specifier.match(/\\.[a-z]+$/)) {
        return nextResolve(specifier + ".ts", context);
      }
      return nextResolve(specifier, context);
    }\n`,
  );

  const loadScript = `
    import { loadPolicy } from ${JSON.stringify(new URL("./src/permission-manager.ts", extensionDir).pathname)};
    console.log(JSON.stringify(loadPolicy(${JSON.stringify(policyPath)})));
  `;
  const loadResult = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--experimental-loader",
      loaderPath,
      "--input-type=module",
      "--eval",
      loadScript,
    ],
    { encoding: "utf8" },
  );
  assert.equal(loadResult.status, 0, loadResult.stderr || loadResult.stdout);
  const loaded = JSON.parse(loadResult.stdout);
  assert.equal(loaded.defaultPolicy.bash, "deny");

  const script = `
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    await updatePolicyFile(${JSON.stringify(policyPath)}, (policy) => {
      policy.auto ??= {};
      policy.auto.classifierModel = { provider: "anthropic", id: "claude-sonnet-4-5" };
    });
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const persisted = JSON.parse(readFileSync(policyPath, "utf8"));
  assert.deepEqual(persisted.auto.classifierModel, {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  });
  assert.equal(persisted.defaultPolicy.bash, "deny");
  assert.deepEqual(persisted.unrelated, { keep: true });
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

const invalidPolicyDir = mkdtempSync(join(tmpdir(), "pi-permissions-invalid-policy-"));
const invalidPolicyPath = join(invalidPolicyDir, "pi-permissions.jsonc");
try {
  const originalPolicy = '{ "defaultPolicy": { "bash": "deny" },\n';
  writeFileSync(invalidPolicyPath, originalPolicy);
  const invalidScript = `
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    await updatePolicyFile(${JSON.stringify(invalidPolicyPath)}, (policy) => {
      policy.auto = { shouldNotPersist: true };
    });
  `;
  const invalidResult = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", invalidScript],
    { encoding: "utf8" },
  );
  assert.notEqual(invalidResult.status, 0, "invalid policy unexpectedly persisted");
  assert.equal(readFileSync(invalidPolicyPath, "utf8"), originalPolicy);
} finally {
  rmSync(invalidPolicyDir, { recursive: true, force: true });
}

const staleLockDir = mkdtempSync(join(tmpdir(), "pi-permissions-stale-lock-"));
const stalePolicyPath = join(staleLockDir, "pi-permissions.jsonc");
const staleLockPath = `${stalePolicyPath}.lock`;
try {
  writeFileSync(stalePolicyPath, "{}\n");
  mkdirSync(staleLockPath);
  const staleTime = new Date(0);
  utimesSync(staleLockPath, staleTime, staleTime);

  const staleScript = `
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    await updatePolicyFile(${JSON.stringify(stalePolicyPath)}, (policy) => {
      policy.auto ??= {};
      policy.auto.recovered = true;
    });
  `;
  const staleResult = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", staleScript],
    { encoding: "utf8" },
  );
  assert.equal(staleResult.status, 0, staleResult.stderr || staleResult.stdout);
  assert.equal(JSON.parse(readFileSync(stalePolicyPath, "utf8")).auto.recovered, true);
  assert.equal(existsSync(staleLockPath), false);
  assert.equal(existsSync(`${staleLockPath}.recovery`), false);
} finally {
  rmSync(staleLockDir, { recursive: true, force: true });
}

function assertLockPreserved(label, stale) {
  const fixtureDir = mkdtempSync(join(tmpdir(), `pi-permissions-${label}-`));
  const policyPath = join(fixtureDir, "pi-permissions.jsonc");
  const lockPath = `${policyPath}.lock`;
  try {
    writeFileSync(policyPath, "{}\n");
    mkdirSync(lockPath);
    if (stale) {
      const staleTime = new Date(0);
      utimesSync(lockPath, staleTime, staleTime);
    }

    const blockedScript = `
      import { updatePolicyFile } from ${JSON.stringify(configPath)};
      await updatePolicyFile(${JSON.stringify(policyPath)}, (policy) => {
        policy.auto ??= {};
        policy.auto.shouldNotPersist = true;
      });
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", blockedScript],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${label} lock unexpectedly allowed an update`);
    assert.equal(existsSync(lockPath), true);
    assert.equal(existsSync(`${lockPath}.recovery`), false);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

assertLockPreserved("fresh-lock", false);

const liveLockDir = mkdtempSync(join(tmpdir(), "pi-permissions-live-lock-"));
const livePolicyPath = join(liveLockDir, "pi-permissions.jsonc");
const liveLockPath = `${livePolicyPath}.lock`;
const liveMarkerPath = join(liveLockDir, "holder-ready");
const liveHolderScript = `
    import lockfile from "proper-lockfile";
    import { writeFileSync } from "node:fs";
    const release = await lockfile.lock(${JSON.stringify(livePolicyPath)}, { stale: 5000 });
    writeFileSync(${JSON.stringify(liveMarkerPath)}, "ready");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await release();
  `;
try {
  writeFileSync(livePolicyPath, "{}\n");
  const liveHolder = spawn(
    process.execPath,
    ["--input-type=module", "--eval", liveHolderScript],
    { cwd: extensionDir.pathname, stdio: ["ignore", "ignore", "pipe"] },
  );
  let liveStderr = "";
  liveHolder.stderr.setEncoding("utf8");
  liveHolder.stderr.on("data", (chunk) => {
    liveStderr += chunk;
  });
  for (let attempt = 0; attempt < 200 && !existsSync(liveMarkerPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(liveMarkerPath), true, liveStderr);
  const liveAttemptScript = `
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    await updatePolicyFile(${JSON.stringify(livePolicyPath)}, (policy) => {
      policy.auto ??= {};
      policy.auto.shouldNotPersist = true;
    });
  `;
  const liveAttempt = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", liveAttemptScript],
    { encoding: "utf8" },
  );
  assert.notEqual(liveAttempt.status, 0, "live lock unexpectedly allowed an update");
  assert.equal(liveHolder.exitCode, null);
  assert.equal(existsSync(liveLockPath), true);
  await new Promise((resolve, reject) => {
    liveHolder.once("error", reject);
    liveHolder.once("close", resolve);
  });
} finally {
  rmSync(liveLockDir, { recursive: true, force: true });
}

const concurrentDir = mkdtempSync(join(tmpdir(), "pi-permissions-lock-"));
const concurrentPolicyPath = join(concurrentDir, "pi-permissions.jsonc");
const markerA = join(concurrentDir, "entered-a");
const markerB = join(concurrentDir, "entered-b");
const concurrentScript = (marker, key) => `
    import { writeFileSync } from "node:fs";
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    await updatePolicyFile(${JSON.stringify(concurrentPolicyPath)}, (policy) => {
      writeFileSync(${JSON.stringify(marker)}, "entered");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 150);
      policy.auto ??= {};
      policy.auto[${JSON.stringify(key)}] = true;
    });
  `;
const runConcurrentUpdate = (marker, key) => {
  let child;
  const done = new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        concurrentScript(marker, key),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `concurrent update exited with ${status}`));
      }
    });
  });
  return { done, pid: child.pid };
};

try {
  writeFileSync(concurrentPolicyPath, "{}\n");
  const firstUpdate = runConcurrentUpdate(markerA, "first");
  for (let attempt = 0; attempt < 200 && !existsSync(markerA); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(markerA), true);
  assert.equal(existsSync(`${concurrentPolicyPath}.lock`), true);
  assert.equal(firstUpdate.pid > 0, true);
  const secondUpdate = runConcurrentUpdate(markerB, "second");
  await Promise.all([firstUpdate.done, secondUpdate.done]);

  const persistedConcurrent = JSON.parse(readFileSync(concurrentPolicyPath, "utf8"));
  assert.equal(persistedConcurrent.auto.first, true);
  assert.equal(persistedConcurrent.auto.second, true);
} finally {
  rmSync(concurrentDir, { recursive: true, force: true });
}

console.log("pi-permissions mode/config tests passed");
