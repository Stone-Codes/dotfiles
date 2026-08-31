import lockfile from "proper-lockfile";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PermissionPolicy } from "../types";

export type PolicyDocument = PermissionPolicy & Record<string, unknown>;
export type PolicyUpdater = (policy: PolicyDocument) => void;

type LockRelease = () => Promise<void>;

function stripJsoncComments(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        result += character;
      }
      continue;
    }

    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n" || character === "\r") {
        result += character;
      }
      continue;
    }

    if (inString) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      result += character;
    }
  }

  return result;
}

const LOCK_OPTIONS = {
  stale: 30_000,
  update: 15_000,
  retries: { retries: 20, factor: 1, minTimeout: 10, maxTimeout: 50 },
};

function readPolicy(filePath: string): PolicyDocument {
  if (!existsSync(filePath)) {
    return {} as PolicyDocument;
  }

  const parsed: unknown = JSON.parse(stripJsoncComments(readFileSync(filePath, "utf8")));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("permission policy must be a JSON object");
  }
  return parsed as PolicyDocument;
}

/**
 * Serialize policy updates under a cross-process lock.
 * Callers must await the returned Promise<void> before relying on persistence.
 */
export async function updatePolicyFile(filePath: string, update: PolicyUpdater): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });

  let release: LockRelease | undefined;
  let temporaryPath: string | undefined;
  try {
    release = await lockfile.lock(filePath, {
      ...LOCK_OPTIONS,
      // Existing files are canonicalized to prevent symlink aliases from
      // acquiring independent locks. For a first write, proper-lockfile can
      // still atomically lock the resolved path before the file exists.
      realpath: existsSync(filePath),
    });

    const policy = readPolicy(filePath);
    update(policy);

    temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original error when cleanup cannot remove the temp file.
      }
    }
    if (release) {
      await release();
    }
  }
}
