import * as os from "node:os";
import * as path from "node:path";
import type { AutoPolicy, SessionPermissionState } from "../types.ts";
import { matchWildcard } from "./wildcard-matcher.ts";

export type AutoGateKind = "allow" | "block" | "classify";

export interface AutoGateResult {
  kind: AutoGateKind;
  reason?: string;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_ONLY_COMMANDS = new Set([
  "[",
  "cat",
  "cut",
  "diff",
  "du",
  "echo",
  "file",
  "fgrep",
  "grep",
  "head",
  "ls",
  "pwd",
  "printf",
  "sort",
  "stat",
  "tail",
  "test",
  "type",
  "uniq",
  "wc",
  "which",
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
]);
const SENSITIVE_DIRECTORY_NAMES = new Set([".ssh", ".aws", ".gnupg", "gpg"]);
const SENSITIVE_FILE_NAME = /^(?:credentials?|secrets?|secret|passwords?|passwd|shadow|known_hosts|id_(?:rsa|dsa|ecdsa|ed25519)|.*(?:credential|secret|password|passwd|private[_-]?key).*)$/i;
const SENSITIVE_PATH_NAME = /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/i;
const SECRET_ASSIGNMENT = /(?:\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)/i;
const AUTHORIZATION_HEADER = /\bauthorization\s*:\s*(?:bearer|basic)\s+/i;
const API_KEY_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,})\b/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalized(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}

function pathCandidates(value: string, cwd: string): string[] {
  const raw = value.trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return [];

  const expanded = raw === "~" || raw.startsWith("~/")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd, expanded);
  return [raw, normalized(raw), normalized(resolved)];
}

function isSensitivePath(value: string, cwd: string): boolean {
  const candidates = pathCandidates(value, cwd);
  if (candidates.length === 0) return false;

  const home = normalized(os.homedir());
  const autoConfig = `${home}/.pi/agent/pi-permissions.jsonc`;
  const extensionPath = "/.pi/agent/extensions/pi-permissions";

  return candidates.some((candidate) => {
    const parts = candidate.split("/").filter(Boolean);
    const basename = parts.at(-1) ?? "";
    return (
      SENSITIVE_PATH_NAME.test(candidate) ||
      parts.some((part) => SENSITIVE_DIRECTORY_NAMES.has(part)) ||
      SENSITIVE_FILE_NAME.test(basename) ||
      candidate === autoConfig ||
      candidate.startsWith(`${autoConfig}/`) ||
      candidate.endsWith("/.pi/agent/auth.json") ||
      candidate.includes(extensionPath)
    );
  });
}

function valuesAtPathKeys(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const values: string[] = [];
  const pathKeys = new Set([
    "path",
    "paths",
    "file",
    "filePath",
    "filename",
    "directory",
    "dir",
    "target",
    "destination",
    "source",
  ]);

  for (const [key, value] of Object.entries(input)) {
    if (!pathKeys.has(key)) continue;
    if (typeof value === "string") values.push(value);
    if (Array.isArray(value)) {
      values.push(...value.filter((entry): entry is string => typeof entry === "string"));
    }
  }
  return values;
}

function shellWords(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function hasShellOperator(command: string, operators: string[]): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (operators.some((operator) => command.startsWith(operator, index))) return true;
  }
  return false;
}

function splitShell(command: string, separators: string[]): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    const separator = separators.find((candidate) => command.startsWith(candidate, index));
    if (separator) {
      segments.push(command.slice(start, index));
      index += separator.length - 1;
      start = index + 1;
    }
  }
  segments.push(command.slice(start));
  return segments;
}

function hasWriteCapableArguments(words: string[]): boolean {
  const executable = words[0].toLowerCase();
  const subcommand = words[1]?.toLowerCase();
  const outputShortOptionCommand = executable === "git" && subcommand === "diff"
    ? true
    : new Set(["sort", "uniq", "diff"]).has(executable);

  return words.slice(1).some((word) => {
    if (/^--(?:output(?:-file)?|in-place|delete|exec(?:dir)?|remove|replace|backup|append|write(?:-to)?|modify|move|copy|rename|unlink)(?:=|$)/i.test(word)) {
      return true;
    }
    if (executable === "find" && /^-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint(?:0)?|fprintf)$/.test(word)) {
      return true;
    }
    if (outputShortOptionCommand && /^-o/i.test(word)) return true;
    return false;
  });
}

function isSafeReadOnlyStage(stage: string): boolean {
  const words = shellWords(stage);
  if (words.length === 0 || hasWriteCapableArguments(words)) return false;

  const executable = words[0].toLowerCase();
  if (executable === "git") {
    const subcommand = words[1]?.toLowerCase();
    if (!subcommand || !READ_ONLY_GIT_COMMANDS.has(subcommand)) return false;
    if (subcommand === "branch") {
      return words.slice(2).every((word) => ["-a", "--all", "-r", "--remotes", "--list"].includes(word));
    }
    if (subcommand === "remote") {
      return words.slice(2).every((word) => ["-v", "--verbose", "show"].includes(word));
    }
    return true;
  }

  return READ_ONLY_COMMANDS.has(executable);
}

function containsAbsoluteOrParentEscape(command: string): boolean {
  return shellWords(command).some((word) => {
    const unquoted = word.replace(/[;,|&]+$/g, "");
    return (
      unquoted.startsWith("/") ||
      unquoted === "~" ||
      unquoted.startsWith("~/") ||
      unquoted.startsWith("$HOME") ||
      unquoted.includes("../") ||
      unquoted === ".."
    );
  });
}

/** Return true only when every shell stage is a local, read-only operation. */
export function isSafeReadOnlyBashCommand(command: string): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  if (hasShellOperator(command, [">", "<", "`", "$(", "${"])) return false;
  if (containsAbsoluteOrParentEscape(command)) return false;

  const commandSegments = splitShell(command, [";", "\n", "&&", "||", "&"]);
  for (const commandSegment of commandSegments) {
    const pipeline = splitShell(commandSegment, ["|"]);
    if (!pipeline.every(isSafeReadOnlyStage)) return false;
  }
  return true;
}

function hardBlockedBashReason(command: string): string | undefined {
  const lower = command.toLowerCase();
  if (/\brm\s+-[^\s]*[rf][^\s]*\s/.test(lower) || /\brm\s+-[^\s]*r[^\s]*f/.test(lower)) {
    return "destructive recursive removal is blocked";
  }
  if (/\bgit\s+reset\b[\s\S]*\s--hard(?:\s|$)/.test(lower)) {
    return "hard git reset is blocked";
  }
  if (/\bgit\s+clean\b/.test(lower) && /-(?=[^\s]*f)(?=[^\s]*d)(?=[^\s]*x)[^\s]*/.test(lower)) {
    return "destructive git clean is blocked";
  }
  if (/\bgit\s+push\b[\s\S]*(?:--force(?:-with-lease)?(?:\s|$)|(?:^|\s)-[^\s]*f(?:\s|$))/.test(lower)) {
    return "force push is blocked";
  }
  if (/\b(?:chmod|chown)\s+(?:-[^\s]*r[^\s]*|--recursive)(?:\s|$)/.test(lower)) {
    return "recursive permission changes are blocked";
  }
  if (/(?:^|[\s;|&])(?:sudo|su)(?:\s|$)/.test(lower)) {
    return "privilege escalation is blocked";
  }
  if (
    /\b(?:pi|node|bun|deno)\b[^\n;|&]*(?:--no-(?:extensions?|permissions?)|(?:^|\s)-e(?:xtension)?(?:\s|$)|--extensions?\b|pi-permissions(?:[\\/]|\.))/i.test(command) ||
    /\b(?:PI_AUTO_MODE|PI_PERMISSIONS)_(?:DISABLE|BYPASS|OFF)\b/i.test(command)
  ) {
    return "permission extension bypass is blocked";
  }
  return undefined;
}

function inputCandidates(toolName: string, input: unknown): string[] {
  const candidates = [toolName];
  if (isRecord(input)) {
    for (const value of Object.values(input)) {
      if (typeof value === "string") candidates.push(value);
    }
  }
  return candidates;
}

export function matchingPolicyPattern(patterns: string[] | undefined, candidates: string[]): string | undefined {
  return patterns?.find((pattern) => candidates.some((candidate) => {
    try {
      return matchWildcard(pattern, candidate) || matchWildcard(pattern.toLowerCase(), candidate.toLowerCase());
    } catch {
      return false;
    }
  }));
}

function matchesPolicy(patterns: string[] | undefined, candidates: string[]): boolean {
  return matchingPolicyPattern(patterns, candidates) !== undefined;
}

/** Keep broad shell grants behind the classifier, even when listed in an allow policy. */
export function isBroadArbitraryExecutionAllow(pattern: string, toolName: string): boolean {
  if (toolName !== "bash") return false;
  const compact = pattern.trim().replace(/\s+/g, "").toLowerCase();
  return compact === "*" || compact === "**" || compact === "bash" || /^bash\*+$/.test(compact) || /^bash\(\*+\)$/.test(compact);
}

function sensitiveInput(toolName: string, input: unknown, cwd: string): boolean {
  if (valuesAtPathKeys(input).some((value) => isSensitivePath(value, cwd))) return true;
  if (toolName === "bash" && isRecord(input) && typeof input.command === "string") {
    const command = input.command;
    if (SECRET_ASSIGNMENT.test(command) || AUTHORIZATION_HEADER.test(command)) return true;
    return command.split(/\s+/).some((word) => isSensitivePath(word, cwd));
  }
  return false;
}

function policyCandidates(toolName: string, input: unknown): string[] {
  const candidates = inputCandidates(toolName, input).map((candidate) => candidate.trim()).filter(Boolean);
  if (toolName === "bash" && isRecord(input) && typeof input.command === "string") {
    candidates.push(`Bash(${input.command})`);
  }
  return candidates;
}

/** Apply only deterministic local rules; all other calls are sent to the classifier. */
export function evaluateAutoGate(
  toolName: string,
  input: unknown,
  cwd: string,
  policy: AutoPolicy,
): AutoGateResult {
  const candidates = policyCandidates(toolName, input);

  // Local hard blocks must run before either allow policy. An allow exception
  // can never authorize destructive commands or sensitive input.
  if (toolName === "bash") {
    const command = isRecord(input) && typeof input.command === "string" ? input.command : "";
    const hardReason = hardBlockedBashReason(command);
    if (hardReason) return { kind: "block", reason: hardReason };
  }
  if (sensitiveInput(toolName, input, cwd)) {
    return { kind: "block", reason: "sensitive path or secret-bearing input is blocked" };
  }
  if (matchesPolicy(policy.hardDeny, candidates)) {
    return { kind: "block", reason: "blocked by Auto hard-deny policy" };
  }

  const autoAllow = matchingPolicyPattern(policy.allow, candidates);
  if (autoAllow && !isBroadArbitraryExecutionAllow(autoAllow, toolName)) {
    return { kind: "allow" };
  }
  if (matchesPolicy(policy.softDeny, candidates)) {
    return { kind: "classify", reason: "matched Auto soft-deny policy" };
  }

  if (toolName === "bash") {
    const command = isRecord(input) && typeof input.command === "string" ? input.command : "";
    if (isSafeReadOnlyBashCommand(command)) return { kind: "allow" };
    return { kind: "classify", reason: "bash command requires classification" };
  }

  if (READ_ONLY_TOOLS.has(toolName)) return { kind: "allow" };
  return { kind: "classify", reason: "tool requires classification" };
}

function isSensitiveObjectKey(key: string): boolean {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:password|passwd|passphrase|apikey|accesskey|secret|token|clientsecret|privatekey|authorization|credential|auth)/.test(normalizedKey);
}

function redactSensitiveJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveObjectKey(key) ? "[REDACTED]" : redactSensitiveJsonValue(nestedValue),
      ]),
    );
  }
  if (typeof value === "string") return redactSensitiveText(value);
  return value;
}

function redactedSecretAssignments(value: string): string {
  return value.replace(
    /(\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*)(["']?)([^\s"'`,;}&]+)(["']?)/gi,
    (_match, prefix: string, openingQuote: string, _secret: string, closingQuote: string) =>
      `${prefix}${openingQuote}[REDACTED]${openingQuote ? (closingQuote || openingQuote) : closingQuote}`,
  );
}

function redactedSensitivePaths(value: string): string {
  return value.replace(
    /(^|[\s"'=:([,{])([^\s"'`;&|,)}\]]+)/g,
    (match, prefix: string, token: string) => (
      isSensitivePath(token, process.cwd()) ? `${prefix}[REDACTED_PATH]` : match
    ),
  );
}

/** Remove credentials while retaining safe labels and command structure. */
export function redactSensitiveText(value: string): string {
  if (typeof value !== "string") return String(value);

  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) || Array.isArray(parsed)) {
      return JSON.stringify(redactSensitiveJsonValue(parsed));
    }
  } catch {
    // Treat non-JSON input as text below.
  }

  let redacted = value.replace(
    /(\bauthorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
    "$1[REDACTED]",
  );
  redacted = redacted.replace(API_KEY_VALUE, "[REDACTED]");
  redacted = redactedSecretAssignments(redacted);
  return redactedSensitivePaths(redacted);
}

/** Increment Auto denials without mutating the caller's session state. */
export function recordAutoDenial(
  state: SessionPermissionState,
): { disable: boolean; state: SessionPermissionState } {
  const nextState: SessionPermissionState = {
    ...state,
    consecutiveAutoDenials: state.consecutiveAutoDenials + 1,
    totalAutoDenials: state.totalAutoDenials + 1,
  };
  return {
    disable: nextState.consecutiveAutoDenials >= 3 || nextState.totalAutoDenials >= 20,
    state: nextState,
  };
}

/** Reset only the consecutive denial streak after an allowed call. */
export function resetAutoDenials(state: SessionPermissionState): SessionPermissionState {
  return { ...state, consecutiveAutoDenials: 0 };
}
