import {
  existsSync,
  mkdirSync,
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
  const policy = readPolicy(filePath);
  update(policy);

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original error when cleanup cannot remove the temporary file.
    }
    throw error;
  }
}
