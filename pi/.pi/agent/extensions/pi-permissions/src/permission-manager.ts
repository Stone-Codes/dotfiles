import { readFileSync, existsSync } from "node:fs";
import type { AutoPolicy, PermissionPolicy, PermissionState } from "../types";
import { findMatchingPattern } from "./wildcard-matcher";
import { logPermissionCheck } from "./logging";

const DEFAULT_PERMISSION_POLICY = {
  tools: "ask" as const,
  bash: "ask" as const,
  mcp: "ask" as const,
  skills: "ask" as const,
};

function createDefaultPolicy(): PermissionPolicy {
  return {
    defaultPolicy: { ...DEFAULT_PERMISSION_POLICY },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function validateAutoPolicy(value: unknown): AutoPolicy {
  if (!isRecord(value)) {
    return {};
  }

  const auto: AutoPolicy = {};
  const classifierModel = value.classifierModel;
  if (
    isRecord(classifierModel) &&
    typeof classifierModel.provider === "string" &&
    classifierModel.provider.length > 0 &&
    typeof classifierModel.id === "string" &&
    classifierModel.id.length > 0
  ) {
    auto.classifierModel = {
      provider: classifierModel.provider,
      id: classifierModel.id,
    };
  }

  for (const key of ["hardDeny", "softDeny", "allow", "environment"] as const) {
    const valueForKey = value[key];
    if (Array.isArray(valueForKey)) {
      auto[key] = valueForKey.filter((entry): entry is string => typeof entry === "string");
    }
  }

  return auto;
}

export function loadPolicy(filePath: string): PermissionPolicy {
  const defaultPolicy = createDefaultPolicy();
  if (!existsSync(filePath)) {
    return defaultPolicy;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(stripJsoncComments(content));
    if (!isRecord(parsed)) {
      throw new Error("permission policy must be a JSON object");
    }

    const policy: PermissionPolicy = {
      ...defaultPolicy,
      ...parsed,
      defaultPolicy: {
        ...defaultPolicy.defaultPolicy,
        ...(isRecord(parsed.defaultPolicy) ? parsed.defaultPolicy : {}),
      },
    };
    if (Object.prototype.hasOwnProperty.call(parsed, "auto")) {
      policy.auto = validateAutoPolicy(parsed.auto);
    }
    return policy;
  } catch (e) {
    console.error(`Failed to load policy from ${filePath}:`, e);
    return createDefaultPolicy();
  }
}

export function loadAutoPolicy(filePath: string): AutoPolicy {
  return loadPolicy(filePath).auto ?? {};
}

export function checkToolPermission(
  policy: PermissionPolicy,
  toolName: string
): { state: PermissionState; source: "tool" | "default"; matchedPattern?: string } {
  const toolPerms = policy.tools || {};
  
  if (toolName in toolPerms) {
    const result = {
      state: toolPerms[toolName],
      source: "tool" as const,
      matchedPattern: toolName,
    };
    logPermissionCheck({
      timestamp: Date.now(),
      toolName,
      state: result.state,
      source: result.source,
      matchedPattern: result.matchedPattern,
    });
    return result;
  }
  
  const result = {
    state: policy.defaultPolicy.tools,
    source: "default" as const,
  };
  logPermissionCheck({
    timestamp: Date.now(),
    toolName,
    state: result.state,
    source: result.source,
  });
  return result;
}

export function checkBashPermission(
  policy: PermissionPolicy,
  command: string
): { state: PermissionState; source: "bash" | "default"; matchedPattern?: string } {
  const bashPerms = policy.bash || {};
  
  const match = findMatchingPattern(bashPerms, command);
  if (match) {
    const result = {
      state: match.value as PermissionState,
      source: "bash" as const,
      matchedPattern: match.pattern,
    };
    logPermissionCheck({
      timestamp: Date.now(),
      command,
      state: result.state,
      source: result.source,
      matchedPattern: result.matchedPattern,
    });
    return result;
  }
  
  const result = {
    state: policy.defaultPolicy.bash,
    source: "default" as const,
  };
  logPermissionCheck({
    timestamp: Date.now(),
    command,
    state: result.state,
    source: result.source,
  });
  return result;
}

export function checkSkillPermission(
  policy: PermissionPolicy,
  skillName: string
): { state: PermissionState; source: "skill" | "default"; matchedPattern?: string } {
  const skillPerms = policy.skills || {};
  
  const match = findMatchingPattern(skillPerms, skillName);
  if (match) {
    const result = {
      state: match.value as PermissionState,
      source: "skill" as const,
      matchedPattern: match.pattern,
    };
    logPermissionCheck({
      timestamp: Date.now(),
      skillName,
      state: result.state,
      source: result.source,
      matchedPattern: result.matchedPattern,
    });
    return result;
  }
  
  const result = {
    state: policy.defaultPolicy.skills,
    source: "default" as const,
  };
  logPermissionCheck({
    timestamp: Date.now(),
    skillName,
    state: result.state,
    source: result.source,
  });
  return result;
}

export function checkMcpPermission(
  policy: PermissionPolicy,
  mcpTarget: string
): { state: PermissionState; source: "mcp" | "default"; matchedPattern?: string } {
  const mcpPerms = policy.mcp || {};
  
  const match = findMatchingPattern(mcpPerms, mcpTarget);
  if (match) {
    const result = {
      state: match.value as PermissionState,
      source: "mcp" as const,
      matchedPattern: match.pattern,
    };
    logPermissionCheck({
      timestamp: Date.now(),
      mcpTarget,
      state: result.state,
      source: result.source,
      matchedPattern: result.matchedPattern,
    });
    return result;
  }
  
  const result = {
    state: policy.defaultPolicy.mcp,
    source: "default" as const,
  };
  logPermissionCheck({
    timestamp: Date.now(),
    mcpTarget,
    state: result.state,
    source: result.source,
  });
  return result;
}

/**
 * Derive MCP target from tool input
 * Handles formats like: server:tool, server_tool, or mcp_call
 */
export function deriveMcpTarget(input: Record<string, any>): string {
  if (input.server && input.tool) {
    return `${input.server}:${input.tool}`;
  }
  if (input.server) {
    return input.server;
  }
  if (input.tool) {
    return input.tool;
  }
  if (input.operation) {
    return `mcp_${input.operation}`;
  }
  return "mcp_call";
}
