import { readFileSync, existsSync } from "node:fs";
import { PermissionPolicy, PermissionState, PermissionLogEntry } from "../types";
import { findMatchingPattern } from "./wildcard-matcher";
import { logPermissionCheck } from "./logging";

const DEFAULT_POLICY: PermissionPolicy = {
  defaultPolicy: {
    tools: "ask",
    bash: "ask",
    mcp: "ask",
    skills: "ask",
  },
};

export function loadPolicy(filePath: string): PermissionPolicy {
  if (!existsSync(filePath)) {
    return DEFAULT_POLICY;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    // Simple JSONC support - strip comments
    const cleaned = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const policy = JSON.parse(cleaned);
    return { ...DEFAULT_POLICY, ...policy };
  } catch (e) {
    console.error(`Failed to load policy from ${filePath}:`, e);
    return DEFAULT_POLICY;
  }
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
