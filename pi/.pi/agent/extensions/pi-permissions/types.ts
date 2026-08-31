import type { Message as PiMessage, Model as PiModel } from "@earendil-works/pi-ai";

export type Message = PiMessage;
export type Model = PiModel<any>;

export interface ClassifierRequest {
  systemPrompt: string;
  messages: [Message];
}

export interface ClassifierContext {
  model?: Model;
  modelRegistry: {
    find(provider: string, id: string): Model | undefined;
    getAvailable(): Model[];
    complete(model: Model, request: ClassifierRequest, options: {
      signal?: AbortSignal;
      maxTokens: number;
      reasoning: "off";
      cacheRetention: "none";
    }): Promise<{ content?: unknown }>;
  };
  signal?: AbortSignal;
  autoPolicy?: AutoPolicy;
  sessionManager?: {
    getBranch(): unknown[];
  };
}

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
  input?: unknown;
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
