import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const extensionDir = new URL(".", import.meta.url);
const source = readFileSync(new URL("./types.ts", extensionDir), "utf8");

assert.equal(source.includes('type PermissionMode = "manual" | "auto" | "allow-all"'), true);
assert.equal(source.includes('mode: "manual"'), true);
assert.equal(source.includes("consecutiveAutoDenials"), true);
assert.equal(source.includes("classifierModel"), true);

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

console.log("pi-permissions mode/config tests passed");
