export type PermissionState = "allow" | "deny" | "ask";

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
  allowedPatterns: string[]; // Patterns approved for this session
}
