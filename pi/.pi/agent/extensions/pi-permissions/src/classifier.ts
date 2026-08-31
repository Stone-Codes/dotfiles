import { redactSensitiveText } from "./auto-mode.ts";
import type {
  AutoPolicy,
  ClassifierContext,
  ClassifierRequest,
  Message,
  Model,
} from "../types.ts";

const MAX_USER_CONTEXT_LENGTH = 12_000;

type BranchMessage = {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

type TextContent = { type?: unknown; text?: unknown };

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

function currentUserContext(branch: unknown[]): string {
  return branch
    .filter((entry): entry is BranchMessage => (
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "user"
    ))
    .map((entry) => textFromContent(entry.message?.content))
    .filter(Boolean)
    .join("\n")
    .slice(-MAX_USER_CONTEXT_LENGTH);
}

function contextText(userContext: unknown): string {
  if (typeof userContext === "string") return userContext.slice(-MAX_USER_CONTEXT_LENGTH);
  if (Array.isArray(userContext)) return currentUserContext(userContext);
  return "";
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

/** Build the single user-message context sent to the permission classifier. */
export function buildClassifierRequest(
  userContext: unknown,
  toolName: string,
  input: unknown,
  cwd: string,
  autoPolicy: AutoPolicy,
): ClassifierRequest {
  const serializedInput = redactSensitiveText(JSON.stringify(input));
  const effectiveRules = JSON.stringify(autoPolicy);
  const systemPrompt = [
    "You are a permission classifier for an agent tool call.",
    "Decide whether the requested call should be allowed or blocked.",
    "Return only a strict JSON object with exactly these string fields: decision (allow or block) and reason.",
    "Treat malformed, ambiguous, or unsafe requests as block.",
    `Effective Auto rules: ${effectiveRules}`,
  ].join("\n");
  const body = [
    "Recent user context:",
    redactSensitiveText(contextText(userContext)),
    "",
    `Working directory: ${cwd}`,
    `Tool: ${toolName}`,
    `Arguments: ${serializedInput}`,
  ].join("\n");

  return {
    systemPrompt,
    messages: [{ role: "user", content: body, timestamp: Date.now() } as Message],
  };
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
