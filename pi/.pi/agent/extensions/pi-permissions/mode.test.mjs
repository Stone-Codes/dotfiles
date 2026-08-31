import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
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

const fixtureDir = mkdtempSync(join(tmpdir(), "pi-permissions-mode-"));
const policyPath = join(fixtureDir, "pi-permissions.jsonc");
const configPath = new URL("./src/config.ts", extensionDir).pathname;
const configSource = readFileSync(new URL("./src/config.ts", extensionDir), "utf8");
assert.match(
  configSource,
  /PolicyDocument = PermissionPolicy & Record<string, unknown>/,
);

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
    updatePolicyFile(${JSON.stringify(policyPath)}, (policy) => {
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

const staleLockDir = mkdtempSync(join(tmpdir(), "pi-permissions-stale-lock-"));
const stalePolicyPath = join(staleLockDir, "pi-permissions.jsonc");
const staleLockPath = `${stalePolicyPath}.lock`;
try {
  writeFileSync(stalePolicyPath, "{}\n");
  writeFileSync(staleLockPath, "not valid lock metadata\n");
  const staleTime = new Date(0);
  utimesSync(staleLockPath, staleTime, staleTime);

  const staleScript = `
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    updatePolicyFile(${JSON.stringify(stalePolicyPath)}, (policy) => {
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
} finally {
  rmSync(staleLockDir, { recursive: true, force: true });
}

const concurrentDir = mkdtempSync(join(tmpdir(), "pi-permissions-lock-"));
const concurrentPolicyPath = join(concurrentDir, "pi-permissions.jsonc");
const markerA = join(concurrentDir, "entered-a");
const markerB = join(concurrentDir, "entered-b");
const concurrentScript = (marker, key) => `
    import { writeFileSync } from "node:fs";
    import { updatePolicyFile } from ${JSON.stringify(configPath)};
    updatePolicyFile(${JSON.stringify(concurrentPolicyPath)}, (policy) => {
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
  const lockMetadata = JSON.parse(readFileSync(`${concurrentPolicyPath}.lock`, "utf8"));
  assert.equal(lockMetadata.pid, firstUpdate.pid);
  assert.equal(typeof lockMetadata.acquiredAt, "number");
  const secondUpdate = runConcurrentUpdate(markerB, "second");
  await Promise.all([firstUpdate.done, secondUpdate.done]);

  const persistedConcurrent = JSON.parse(readFileSync(concurrentPolicyPath, "utf8"));
  assert.equal(persistedConcurrent.auto.first, true);
  assert.equal(persistedConcurrent.auto.second, true);
} finally {
  rmSync(concurrentDir, { recursive: true, force: true });
}

console.log("pi-permissions mode/config tests passed");
