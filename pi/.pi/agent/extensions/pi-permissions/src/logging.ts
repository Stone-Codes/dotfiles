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

export function logPermissionCheck(entry: PermissionLogEntry): void {
  ensureLogDir();
  const safeEntry = JSON.parse(redactSensitiveText(JSON.stringify(entry))) as PermissionLogEntry;
  const line = JSON.stringify(safeEntry) + "\n";
  fs.appendFileSync(LOG_FILE, line, "utf-8");
}

export function logAutoDenial(
  toolName: string,
  input: unknown,
  reason: string,
  details: Partial<Pick<PermissionLogEntry, "command" | "mcpTarget">> = {},
): void {
  logPermissionCheck({
    timestamp: Date.now(),
    toolName,
    input,
    state: "deny",
    source: "auto",
    reason: redactSensitiveText(reason),
    userAction: "denied",
    ...details,
  });
}

export function getLogPath(): string {
  return LOG_FILE;
}
