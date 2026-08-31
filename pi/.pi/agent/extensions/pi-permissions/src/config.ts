import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
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
const LOCK_STALE_AFTER_MS = 30_000;
const RECOVERY_MARKER_SUFFIX = ".recovery";

type LockMetadata = {
  pid: number;
  acquiredAt: number;
};

function sleepSync(milliseconds: number): void {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, milliseconds);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM means the process exists but is not signalable. For any other
    // uncertainty, keep the lock rather than risking another owner's lock.
    return true;
  }
}

function isLockMetadata(value: unknown): value is LockMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.pid === "number" &&
    Number.isSafeInteger(metadata.pid) &&
    metadata.pid > 0 &&
    typeof metadata.acquiredAt === "number" &&
    Number.isFinite(metadata.acquiredAt) &&
    metadata.acquiredAt > 0
  );
}

function isStaleLock(lockPath: string): boolean {
  let lockStat;
  let contents: string;
  try {
    lockStat = statSync(lockPath);
    contents = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // A process can briefly leave an empty/malformed file while writing its
    // metadata. Its mtime must therefore prove that it is old first.
    return Date.now() - lockStat.mtimeMs >= LOCK_STALE_AFTER_MS;
  }

  if (!isLockMetadata(parsed)) {
    return Date.now() - lockStat.mtimeMs >= LOCK_STALE_AFTER_MS;
  }

  const metadataIsOld = Date.now() - parsed.acquiredAt >= LOCK_STALE_AFTER_MS;
  return metadataIsOld && !isProcessAlive(parsed.pid);
}

function removeStaleLock(lockPath: string): boolean {
  if (!isStaleLock(lockPath)) {
    return false;
  }

  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

function writeLockMetadata(lockFd: number): void {
  writeFileSync(
    lockFd,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    { encoding: "utf8" },
  );
}

function releaseRecoveryMarker(markerPath: string, markerFd: number): void {
  try {
    closeSync(markerFd);
  } catch {
    // Continue cleanup even if closing the descriptor fails.
  }
  try {
    unlinkSync(markerPath);
  } catch {
    // Preserve the original operation error when cleanup cannot remove the marker.
  }
}

function acquireRecoveryMarker(markerPath: string): number {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    let markerFd: number | undefined;
    try {
      markerFd = openSync(markerPath, "wx", 0o600);
      writeLockMetadata(markerFd);
      return markerFd;
    } catch (error) {
      if (markerFd !== undefined) {
        releaseRecoveryMarker(markerPath, markerFd);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // A crashed claimant can leave the marker behind. Use the same
      // timestamp/PID validation as policy locks before reclaiming it.
      if (removeStaleLock(markerPath)) {
        continue;
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

  throw new Error(`Timed out acquiring policy recovery marker ${markerPath}`);
}

function acquireLock(lockPath: string): number {
  const markerPath = `${lockPath}${RECOVERY_MARKER_SUFFIX}`;
  let markerFd: number | undefined;

  try {
    // Every contender takes this gate before touching the policy lock. This
    // closes the stale-check/unlink gap: only its claimant can remove a stale
    // lock and acquire the replacement while other cooperating contenders wait.
    markerFd = acquireRecoveryMarker(markerPath);

    for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
      let lockFd: number | undefined;
      try {
        lockFd = openSync(lockPath, "wx", 0o600);
        writeLockMetadata(lockFd);
        const acquiredLockFd = lockFd;
        lockFd = undefined;
        releaseRecoveryMarker(markerPath, markerFd);
        markerFd = undefined;
        return acquiredLockFd;
      } catch (error) {
        if (lockFd !== undefined) {
          try {
            closeSync(lockFd);
          } finally {
            try {
              unlinkSync(lockPath);
            } catch {
              // Preserve the metadata write error.
            }
          }
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        // The recovery marker is held for the entire stale takeover attempt,
        // so this unlink is not reachable by another cooperating contender.
        if (removeStaleLock(lockPath)) {
          continue;
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
  } finally {
    if (markerFd !== undefined) {
      releaseRecoveryMarker(markerPath, markerFd);
    }
  }
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
