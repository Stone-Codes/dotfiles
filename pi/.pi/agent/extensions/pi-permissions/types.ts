export type PermissionState = "allow" | "deny" | "ask";

export type PermissionMode = "manual" | "auto" | "allow-all";

export interface ClassifierModelRef {
  provider: string;
  id: string;
}

export interface AutoPolicy {
  classifierModel?: ClassifierModelRef;
  hardDeny?: string[];
  softDeny?: string[];
  allow?: string[];
  environment?: string[];
}

export interface PermissionPolicy {
  defaultPolicy: {
    tools: PermissionState;
    bash: PermissionState;
    mcp: PermissionState;
    skills: PermissionState;
  };
  tools?: Record<string, PermissionState>;
  bash?: Record<string, PermissionState>;
  mcp?: Record<string, PermissionState>;
  skills?: Record<string, PermissionState>;
  auto?: AutoPolicy;
}

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  source: "tool" | "bash" | "mcp" | "skill" | "default";
}

export interface PermissionLogEntry {
  timestamp: number;
  toolName?: string;
  command?: string;
  mcpTarget?: string;
  skillName?: string;
  state: PermissionState;
  source: string;
  matchedPattern?: string;
  userAction?: "allowed" | "denied";
  reason?: string;
}

/**
 * Session state for temporary permission overrides
 */
export interface SessionPermissionState {
  allowAll: boolean;
  mode: PermissionMode;
  consecutiveAutoDenials: number;
  totalAutoDenials: number;
  allowedPatterns: string[]; // Patterns approved for this session
}

export function createInitialSessionPermissionState(): SessionPermissionState {
  return {
    allowAll: false,
    mode: "manual",
    consecutiveAutoDenials: 0,
    totalAutoDenials: 0,
    allowedPatterns: [],
  };
}
