import { redactSensitiveText } from "./auto-mode.ts";
import type {
  AutoPolicy,
  ClassifierContext,
  ClassifierRequest,
  Message,
  Model,
} from "../types.ts";

export const MAX_CLASSIFIER_REQUEST_SIZE = 32_000;
const MAX_USER_CONTEXT_LENGTH = 12_000;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_TOOL_INPUT_LENGTH = 8_000;
const MAX_AUTO_POLICY_LENGTH = 8_000;
const MAX_CWD_LENGTH = 2_000;
const MAX_RULE_LENGTH = 1_500;
const MAX_LIST_LENGTH = 32;
const MAX_NESTED_STRING_LENGTH = 2_048;
const TRUNCATION_MARKER = "\\n[TRUNCATED]";

type BranchMessage = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

type TextContent = { type?: unknown; text?: unknown };

type ClassifierFields = {
  userContext: string;
  toolName: string;
  input: string;
  cwd: string;
  rules: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => isRecord(part) && part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

function boundedText(value: string, limit: number, cwd: string, fromEnd = false): string {
  const redacted = redactSensitiveText(value, cwd);
  if (redacted.length <= limit) return redacted;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit);
  const contentLength = limit - TRUNCATION_MARKER.length;
  return fromEnd
    ? `${TRUNCATION_MARKER}${redacted.slice(-contentLength)}`
    : `${redacted.slice(0, contentLength)}${TRUNCATION_MARKER}`;
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|passphrase|apikey|accesskey|secret|token|clientsecret|privatekey|authorization|credential|auth)/i.test(
    key.replace(/[^a-z0-9]/gi, ""),
  );
}

function boundedValue(value: unknown, cwd: string, depth = 0): unknown {
  if (typeof value === "string") return boundedText(value, MAX_NESTED_STRING_LENGTH, cwd);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 6) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LIST_LENGTH).map((entry) => boundedValue(entry, cwd, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).slice(0, MAX_LIST_LENGTH).map(([key, nestedValue]) => [
        boundedText(key, 256, cwd),
        isSensitiveKey(key) ? "[REDACTED]" : boundedValue(nestedValue, cwd, depth + 1),
      ]),
    );
  }
  return boundedText(String(value), MAX_NESTED_STRING_LENGTH, cwd);
}

function boundedJson(value: unknown, limit: number, cwd: string): string {
  const serialized = redactSensitiveText(JSON.stringify(boundedValue(value, cwd)) ?? "null", cwd);
  if (serialized.length <= limit) return serialized;

  const keys = isRecord(value)
    ? Object.keys(value).filter((key) => !isSensitiveKey(key)).slice(0, MAX_LIST_LENGTH)
    : [];
  return JSON.stringify({ truncated: true, keys });
}

function boundedRuleList(value: unknown, cwd: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, MAX_LIST_LENGTH)
    .map((entry) => boundedText(entry, MAX_RULE_LENGTH, cwd));
}

function boundedAutoPolicy(policy: AutoPolicy, cwd: string): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  if (policy.classifierModel) {
    bounded.classifierModel = {
      provider: boundedText(policy.classifierModel.provider, 256, cwd),
      id: boundedText(policy.classifierModel.id, 512, cwd),
    };
  }
  for (const key of ["hardDeny", "softDeny", "allow", "environment"] as const) {
    const values = boundedRuleList(policy[key], cwd);
    if (values) bounded[key] = values;
  }
  return bounded;
}

function currentUserContext(branch: unknown[], cwd: string): string {
  const context = branch
    .filter((entry): entry is BranchMessage => (
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "user"
    ))
    .map((entry) => textFromContent(entry.message?.content))
    .filter(Boolean)
    .join("\n");
  return boundedText(context, MAX_USER_CONTEXT_LENGTH, cwd, true);
}

function contextText(userContext: unknown, cwd: string): string {
  if (typeof userContext === "string") return boundedText(userContext, MAX_USER_CONTEXT_LENGTH, cwd, true);
  if (Array.isArray(userContext)) return currentUserContext(userContext, cwd);
  return "";
}

function createClassifierRequest(fields: ClassifierFields): ClassifierRequest {
  const systemPrompt = [
    "You are a permission classifier for an agent tool call.",
    "Decide whether the requested call should be allowed or blocked.",
    "Return only a strict JSON object with exactly these string fields: decision (allow or block) and reason.",
    "Treat malformed, ambiguous, or unsafe requests as block.",
    `Effective Auto rules: ${fields.rules}`,
  ].join("\n");
  const body = [
    "Recent user context:",
    fields.userContext,
    "",
    `Working directory: ${fields.cwd}`,
    `Tool: ${fields.toolName}`,
    `Arguments: ${fields.input}`,
  ].join("\n");

  return {
    systemPrompt,
    messages: [{ role: "user", content: body, timestamp: Date.now() } as Message],
  };
}

function fitClassifierRequest(fields: ClassifierFields): ClassifierRequest {
  let request = createClassifierRequest(fields);
  const shrinkable: (keyof ClassifierFields)[] = ["userContext", "input", "rules", "cwd", "toolName"];
  while (JSON.stringify(request).length > MAX_CLASSIFIER_REQUEST_SIZE) {
    const key = shrinkable
      .filter((candidate) => fields[candidate].length > 0)
      .sort((left, right) => fields[right].length - fields[left].length)[0];
    if (!key) break;
    const nextLength = Math.max(0, Math.floor(fields[key].length * 0.75));
    fields[key] = boundedText(fields[key], nextLength, fields.cwd);
    request = createClassifierRequest(fields);
  }
  return request;
}

function modelKey(model: Model): string {
  return `${model.provider}\u0000${model.id}`;
}

function isAvailable(model: Model, available: Model[]): boolean {
  return available.some((candidate) => candidate === model || modelKey(candidate) === modelKey(model));
}

/** Resolve the configured classifier model, or the active session model by default. */
export function resolveClassifierModel(
  ctx: ClassifierContext,
  autoPolicy: AutoPolicy,
): { model: Model; source: "session" | "override" } | { error: string } {
  const registry = ctx?.modelRegistry;
  if (!registry || typeof registry.getAvailable !== "function") {
    return { error: "classifier model registry is unavailable" };
  }

  if (autoPolicy.classifierModel) {
    const { provider, id } = autoPolicy.classifierModel;
    const model = registry.find?.(provider, id);
    if (!model) {
      return { error: `classifier model ${provider}/${id} is unavailable` };
    }
    if (!isAvailable(model, registry.getAvailable())) {
      return { error: `classifier model ${provider}/${id} is not available` };
    }
    return { model, source: "override" };
  }

  if (!ctx.model) return { error: "no active session model is available for classifier" };
  return { model: ctx.model, source: "session" };
}

/** Build the bounded, redacted user-message context sent to the classifier. */
export function buildClassifierRequest(
  userContext: unknown,
  toolName: string,
  input: unknown,
  cwd: string,
  autoPolicy: AutoPolicy,
): ClassifierRequest {
  const fields: ClassifierFields = {
    userContext: contextText(userContext, cwd),
    toolName: boundedText(toolName, MAX_TOOL_NAME_LENGTH, cwd),
    input: boundedJson(input, MAX_TOOL_INPUT_LENGTH, cwd),
    cwd: boundedText(cwd, MAX_CWD_LENGTH, cwd),
    rules: boundedJson(boundedAutoPolicy(autoPolicy, cwd), MAX_AUTO_POLICY_LENGTH, cwd),
  };
  return fitClassifierRequest(fields);
}

/** Parse exactly the JSON decision contract emitted by the classifier model. */
export function parseClassifierResponse(text: string): { decision: "allow" | "block"; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("classifier response is not valid JSON");
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== 2) {
    throw new Error("classifier response must contain only decision and reason");
  }
  if (
    (parsed.decision !== "allow" && parsed.decision !== "block") ||
    typeof parsed.reason !== "string"
  ) {
    throw new Error("classifier response has an invalid decision or reason");
  }
  return { decision: parsed.decision, reason: parsed.reason };
}

function responseText(response: { content?: unknown }): string {
  if (!Array.isArray(response?.content)) return "";
  return response.content
    .filter((part): part is TextContent => isRecord(part) && part.type === "text")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

/** Run the classifier; failures are propagated so Auto mode cannot approve them. */
export async function classifyToolCall(
  ctx: ClassifierContext,
  request: ClassifierRequest,
): Promise<{ decision: "allow" | "block"; reason: string }> {
  try {
    const resolved = resolveClassifierModel(ctx, ctx.autoPolicy ?? {});
    if ("error" in resolved) throw new Error(resolved.error);
    const response = await ctx.modelRegistry.complete(resolved.model, request, {
      signal: ctx.signal,
      maxTokens: 256,
      reasoning: "off",
      cacheRetention: "none",
    });
    const text = responseText(response);
    if (!text) throw new Error("classifier response contains no text");
    return parseClassifierResponse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`classifier failed: ${message}`, { cause: error });
  }
}
