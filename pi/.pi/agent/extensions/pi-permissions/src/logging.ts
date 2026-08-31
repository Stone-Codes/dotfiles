import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PermissionLogEntry } from "../types.ts";
import { redactSensitiveText } from "./auto-mode";

const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-permissions", "logs");
const LOG_FILE = path.join(LOG_DIR, "permission-review.jsonl");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, redactLogValue(nestedValue)]),
    );
  }
  return value;
}

export function logPermissionCheck(entry: PermissionLogEntry): void {
  ensureLogDir();
  const safeEntry = redactLogValue(entry) as PermissionLogEntry;
  const line = JSON.stringify(safeEntry) + "\n";
  fs.appendFileSync(LOG_FILE, line, "utf-8");
}

export function getLogPath(): string {
  return LOG_FILE;
}
