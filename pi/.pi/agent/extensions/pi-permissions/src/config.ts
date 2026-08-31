import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { PermissionPolicy } from "../types";

export type PolicyDocument = PermissionPolicy & Record<string, unknown>;
export type PolicyUpdater = (policy: PolicyDocument) => void;

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

const LOCK_RETRY_ATTEMPTS = 50;
const LOCK_INITIAL_BACKOFF_MS = 10;
const LOCK_MAX_BACKOFF_MS = 100;

function sleepSync(milliseconds: number): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, milliseconds);
}

function acquireLock(lockPath: string): number {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (attempt === LOCK_RETRY_ATTEMPTS - 1) {
        break;
      }
      const backoff = Math.min(
        LOCK_INITIAL_BACKOFF_MS * 2 ** attempt,
        LOCK_MAX_BACKOFF_MS,
      );
      sleepSync(backoff);
    }
  }

  throw new Error(`Timed out acquiring policy lock ${lockPath}`);
}

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

export function updatePolicyFile(filePath: string, update: PolicyUpdater): void {
  const lockPath = `${filePath}.lock`;
  let lockFd: number | undefined;
  let temporaryPath: string | undefined;
  mkdirSync(dirname(filePath), { recursive: true });

  try {
    lockFd = acquireLock(lockPath);
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
        // Preserve the original error when cleanup cannot remove the temporary file.
      }
    }
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        // The lock file is still removed below even if closing the descriptor fails.
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original error when cleanup cannot remove the lock file.
      }
    }
  }
}
