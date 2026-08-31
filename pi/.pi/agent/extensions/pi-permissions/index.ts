import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadPolicy, checkToolPermission, checkBashPermission, checkSkillPermission, checkMcpPermission, deriveMcpTarget } from "./src/permission-manager";
import { updatePolicyFile } from "./src/config";
import { evaluateAutoGate, recordAutoDenial, resetAutoDenials } from "./src/auto-mode";
import { buildClassifierRequest, classifyToolCall } from "./src/classifier";
import { getLogPath, logAutoDenial } from "./src/logging";
import { createInitialSessionPermissionState, type PermissionMode, type SessionPermissionState, type ClassifierContext } from "./types";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const POLICY_FILE = path.join(os.homedir(), ".pi", "agent", "pi-permissions.jsonc");
const IS_SUBAGENT = process.env.PI_SUBAGENT === "1" || !process.stdin.isTTY;

export function parsePermissionModeCommand(args: string): PermissionMode | undefined {
  const modeMatch = args.trim().match(/^mode(?:\s+(manual|auto|allow-all))?$/i);
  return modeMatch?.[1]?.toLowerCase() as PermissionMode | undefined;
}

/**
 * Check if a bash command is read-only and safe to auto-allow.
 * Allows commands like ls, cat, grep, find, git status, etc.
 * Only allows operations within the current working directory.
 */
function isReadOnlyBashCommand(command: string, cwd: string): boolean {
  const cmd = command.trim().toLowerCase();
  
  // List of read-only command patterns
  const readOnlyPatterns = [
    /^ls(\s|$)/,
    /^cat\s/,
    /^head\s/,
    /^tail\s/,
    /^grep\s/,
    /^find\s/,
    /^file\s/,
    /^stat\s/,
    /^wc\s/,
    /^diff\s/,
    /^git\s+status/,
    /^git\s+log/,
    /^git\s+diff/,
    /^git\s+show/,
    /^git\s+branch(\s+(-a|--all|-r|--remotes|--list))*(\s|$)/,
    /^git\s+remote(\s+(-v|--verbose|show)(\s|$)|\s*$)/,
    /^pwd(\s|$)/,
    /^echo\s/,
    /^which\s/,
    /^type\s/,
    /^test\s/,
    /^\[\s/,
  ];
  
  // Check if it matches a read-only pattern
  const isReadOnly = readOnlyPatterns.some(pattern => pattern.test(cmd));
  if (!isReadOnly) return false;
  
  // Must not contain writes, pipes to writes, or directory traversal
  const dangerousPatterns = [
    /\|\s*(write|tee|cat\s*>.)/,
    />>/,
    />\s*[^>&]/,
    /<\s*[^&]/,
    /rm\s/,
    /mkfs/,
    /dd\s/,
    /sudo/,
    /su\s/,
    /\bfind\b.*\s-delete\b/,
    /\bfind\b.*\s-exec\b/,
    /\bgit\s+branch\s+(-d|-D|--delete|--move|--copy|--set-upstream-to)\b/,
    /\bgit\s+remote\s+(add|remove|rm|rename|set-url|prune|update)\b/,
    /\.\.\//,
    /^\s*\//,
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(cmd));
}

export default function (pi: ExtensionAPI) {
  let policy = loadPolicy(POLICY_FILE);
  
  // Session state for temporary permission overrides. The selected mode is
  // intentionally session-only; only the classifier model is persisted.
  const sessionState: SessionPermissionState = createInitialSessionPermissionState();

  function classifierLabel(ctx?: { model?: { provider: string; id: string } }): string {
    const configured = policy.auto?.classifierModel;
    if (configured) return `${configured.provider}/${configured.id}`;
    if (ctx?.model) return `${ctx.model.provider}/${ctx.model.id}`;
    return "default";
  }

  function updateStatus(ctx: { ui: { setStatus(id: string, text: string | undefined): void }; model?: { provider: string; id: string } }): void {
    const label = sessionState.mode === "auto" ? `AUTO (${classifierLabel(ctx)})` : sessionState.mode === "manual" ? "MANUAL" : "ALLOW-ALL";
    ctx.ui.setStatus("pi-permissions", label);
  }

  function setMode(mode: PermissionMode, ctx: { ui: { setStatus(id: string, text: string | undefined): void; notify(message: string, level: "info" | "warning" | "error"): void }; model?: { provider: string; id: string } }): void {
    sessionState.mode = mode;
    sessionState.allowedPatterns = [];
    Object.assign(sessionState, resetAutoDenials(sessionState));
    updateStatus(ctx);

    if (mode === "auto") {
      ctx.ui.notify(`Auto mode enabled. Classifier: ${classifierLabel(ctx)}`, "info");
    } else if (mode === "allow-all") {
      ctx.ui.notify("WARNING: Allow-all mode bypasses all permission checks for this session", "warning");
    } else {
      ctx.ui.notify("Manual permission mode enabled", "info");
    }
  }

  // Reload policy on session start (catches external changes) and reset the
  // session-only mode to Manual rather than persisting a selected mode.
  pi.on("session_start", async (_event, ctx) => {
    policy = loadPolicy(POLICY_FILE);
    sessionState.mode = "manual";
    sessionState.allowedPatterns = [];
    Object.assign(sessionState, resetAutoDenials(sessionState));
    updateStatus(ctx);
  });

  // Filter tools and sanitize system prompt before agent starts
  pi.on("before_agent_start", async (event, ctx) => {
    const toolPerms = policy.tools || {};
    const defaultToolPolicy = policy.defaultPolicy.tools;

    // Get current active tools
    const allTools = pi.getAllTools();
    
    // Determine which tools to keep active
    const toolsToKeep: string[] = [];
    
    for (const tool of allTools) {
      // Auto must be able to classify tools that Manual policy would deny;
      // Allow-all likewise keeps the complete tool set available.
      if (sessionState.mode === "auto" || sessionState.mode === "allow-all") {
        toolsToKeep.push(tool.name);
        continue;
      }
      const check = checkToolPermission(policy, tool.name);
      if (check.state !== "deny") {
        toolsToKeep.push(tool.name);
      }
    }
    
    // Set active tools (this affects what the agent can call)
    if (toolsToKeep.length > 0) {
      pi.setActiveTools(toolsToKeep);
    }

    return {
      systemPrompt: event.systemPrompt,
    };
  });

  function autoBlock(
    event: { toolName: string; input?: unknown },
    reason: string,
    details: Partial<{ command: string; mcpTarget: string }> = {},
    prefixReason = true,
  ): { block: true; reason: string } {
    logAutoDenial(event.toolName, event.input, reason, details);
    return { block: true, reason: prefixReason ? `Blocked by Auto mode: ${reason}` : reason };
  }

  async function handleAutoToolCall(event: { toolName: string; input?: any }, ctx: any): Promise<{ block: true; reason: string } | undefined> {
    const toolName = event.toolName;
    const input = event.input;
    const command = toolName === "bash" && typeof input?.command === "string" ? input.command : undefined;
    const mcpTarget = toolName === "mcp" && input ? deriveMcpTarget(input) : undefined;

    // Explicit policy denies remain authoritative in Auto mode, while asks
    // are delegated to the deterministic gate and classifier below.
    const explicitDeny = toolName === "mcp" && mcpTarget
      ? checkMcpPermission(policy, mcpTarget)
      : toolName === "bash" && command !== undefined
        ? checkBashPermission(policy, command)
        : toolName !== "mcp"
          ? checkToolPermission(policy, toolName)
          : undefined;
    if (explicitDeny?.state === "deny") {
      const reason = toolName === "mcp"
        ? `MCP target '${mcpTarget}' is denied by permission policy${explicitDeny.matchedPattern ? ` (matched: ${explicitDeny.matchedPattern})` : ""}`
        : toolName === "bash"
          ? `Bash command blocked by permission policy${explicitDeny.matchedPattern ? ` (matched: ${explicitDeny.matchedPattern})` : ""}`
          : `Tool '${toolName}' is denied by permission policy${explicitDeny.matchedPattern ? ` (matched: ${explicitDeny.matchedPattern})` : ""}`;
      return autoBlock(event, reason, { command, mcpTarget });
    }

    const gate = evaluateAutoGate(toolName, input, ctx.cwd, policy.auto ?? {});
    if (gate.kind === "allow") {
      Object.assign(sessionState, resetAutoDenials(sessionState));
      return;
    }
    if (gate.kind === "block") {
      return autoBlock(event, gate.reason ?? "deterministic Auto policy blocked this action", { command, mcpTarget });
    }

    const autoPolicy = policy.auto ?? {};
    // classifyToolCall invokes ctx.modelRegistry.complete with the bounded request.
    const classifierContext = { ...ctx, autoPolicy } as ClassifierContext;
    const request = buildClassifierRequest(
      ctx.sessionManager?.getBranch?.() ?? [],
      toolName,
      input,
      ctx.cwd,
      autoPolicy,
    );

    try {
      const result = await classifyToolCall(classifierContext, request);
      if (result.decision === "allow") {
        Object.assign(sessionState, resetAutoDenials(sessionState));
        return;
      }

      const reason = result.reason || "classifier blocked this action";
      const denial = recordAutoDenial(sessionState);
      Object.assign(sessionState, denial.state);
      const blocked = autoBlock(event, reason, { command, mcpTarget });
      if (denial.disable) {
        sessionState.mode = "manual";
        updateStatus(ctx);
        ctx.ui.notify(`Auto mode disabled after ${sessionState.consecutiveAutoDenials} consecutive denials; switched to Manual`, "warning");
      }
      return blocked;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Classifier unavailable",
          `Auto mode could not classify this action (${message}). Allow this action once?`,
        );
        if (ok) {
          Object.assign(sessionState, resetAutoDenials(sessionState));
          return;
        }
      }

      const reason = ctx.hasUI
        ? "User denied action after classifier failure"
        : "Classifier unavailable; Auto mode did not approve this action.";
      return autoBlock(event, reason, { command, mcpTarget }, ctx.hasUI);
    }
  }

  // Enforce permissions on tool calls
  pi.on("tool_call", async (event, ctx) => {
    // Allow-all is deliberately the first check and bypasses every permission
    // check, preserving the existing session-wide full bypass semantics.
    if (sessionState.mode === "allow-all") {
      return;
    }

    if (sessionState.mode === "auto") {
      return handleAutoToolCall(event, ctx);
    }

    if (sessionState.mode === "manual") {
      const toolName = event.toolName;

    // Check if it's an MCP tool call
    if (toolName === "mcp" && event.input) {
      const mcpTarget = deriveMcpTarget(event.input);
      const check = checkMcpPermission(policy, mcpTarget);

      if (check.state === "deny") {
        return {
          block: true,
          reason: `MCP target '${mcpTarget}' is denied by permission policy${check.matchedPattern ? ` (matched: ${check.matchedPattern})` : ""}`,
        };
      }

      if (check.state === "ask") {
        if (IS_SUBAGENT) {
          return; // Delegated agents run non-interactively; preserve explicit deny rules above.
        }

        if (ctx.hasUI) {
          const choice = await ctx.ui.select(
            `Permission Required: Allow MCP target: ${mcpTarget}${check.matchedPattern ? ` (matched: ${check.matchedPattern})` : ""}`,
            ["Yes", "Allow Similar", "No"]
          );
          
          if (choice === "Yes") {
            return; // Allow once
          }
          
          if (choice === "Allow Similar") {
            // Remember this pattern for similar commands
            sessionState.allowedPatterns.push(mcpTarget);
            ctx.ui.notify(`Now allowing similar to: ${mcpTarget}`, "info");
            return; // Allow
          }
          
          return {
            block: true,
            reason: "User denied MCP target",
          };
        } else {
          return {
            block: true,
            reason: "Cannot prompt for permission in non-interactive mode",
          };
        }
      }
    }

    // Check if it's a bash command
    if (toolName === "bash" && event.input.command) {
      const command = event.input.command;
      const check = checkBashPermission(policy, command);

      // Auto-allow read-only commands in current directory
      if (isReadOnlyBashCommand(command, ctx.cwd)) {
        return; // Allow silently
      }

      if (check.state === "deny") {
        return {
          block: true,
          reason: `Bash command blocked by permission policy${check.matchedPattern ? ` (matched: ${check.matchedPattern})` : ""}`,
        };
      }

      if (check.state === "ask") {
        if (IS_SUBAGENT) {
          return; // Delegated agents run non-interactively; preserve explicit deny rules above.
        }

        // Check if we've already allowed similar commands
        const isSimilar = sessionState.allowedPatterns.some(pattern => {
          const basePattern = pattern.split(' ')[0];
          const baseCommand = command.trim().split(' ')[0];
          return basePattern === baseCommand || command.includes(pattern);
        });
        
        if (isSimilar) {
          return; // Allow similar command
        }
        
        if (ctx.hasUI) {
          const choice = await ctx.ui.select(
            `Permission Required: Allow bash command: ${command}${check.matchedPattern ? ` (matched: ${check.matchedPattern})` : ""}`,
            ["Yes", "Allow Similar", "No"]
          );
          
          if (choice === "Yes") {
            return; // Allow once
          }
          
          if (choice === "Allow Similar") {
            // Remember this command pattern for similar ones
            const baseCommand = command.trim().split(' ')[0];
            sessionState.allowedPatterns.push(baseCommand);
            ctx.ui.notify(`Now allowing similar ${baseCommand} commands`, "info");
            return; // Allow
          }
          
          return {
            block: true,
            reason: "User denied bash command",
          };
        } else {
          return {
            block: true,
            reason: "Cannot prompt for permission in non-interactive mode",
          };
        }
      }
    } else {
      // Regular tool permission check (skip mcp as it's handled above)
      if (toolName !== "mcp") {
        const check = checkToolPermission(policy, toolName);

        if (check.state === "deny") {
          return {
            block: true,
            reason: `Tool '${toolName}' is denied by permission policy${check.matchedPattern ? ` (matched: ${check.matchedPattern})` : ""}`,
          };
        }

        if (check.state === "ask") {
          if (IS_SUBAGENT) {
            return; // Delegated agents run non-interactively; preserve explicit deny rules above.
          }

          // Check if we've already allowed similar tools
          const isSimilar = sessionState.allowedPatterns.some(pattern => {
            return toolName.includes(pattern) || pattern.includes(toolName);
          });
          
          if (isSimilar) {
            return; // Allow similar tool
          }
          
          if (ctx.hasUI) {
            const choice = await ctx.ui.select(
              `Permission Required: Allow tool: ${toolName}?`,
              ["Yes", "Allow Similar", "No"]
            );
            
            if (choice === "Yes") {
              return; // Allow once
            }
            
            if (choice === "Allow Similar") {
              // Remember this tool for similar ones
              sessionState.allowedPatterns.push(toolName);
              ctx.ui.notify(`Now allowing similar to: ${toolName}`, "info");
              return; // Allow
            }
            
            return {
              block: true,
              reason: "User denied tool call",
            };
          } else {
            return {
              block: true,
              reason: "Cannot prompt for permission in non-interactive mode",
            };
          }
        }
      }
    }

      // Allow the tool call to proceed
      return;
    }
  });

  // Handle skill loading via input interception
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("/skill:")) {
      const skillName = event.text.slice(7).trim();
      const check = checkSkillPermission(policy, skillName);

      if (check.state === "deny") {
        ctx.ui.notify(`Skill '${skillName}' is blocked by permission policy`, "error");
        return { action: "handled" };
      }

      if (check.state === "ask") {
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Permission Required",
            `Allow loading skill: ${skillName}?`
          );
          if (!ok) {
            ctx.ui.notify("Skill loading cancelled", "info");
            return { action: "handled" };
          }
        } else {
          ctx.ui.notify("Cannot prompt for skill permission in non-interactive mode", "error");
          return { action: "handled" };
        }
      }
    }

    return { action: "continue" };
  });

  // Register a command to show current policy
  pi.registerCommand("perms", {
    description: "Show or change the current permission mode and policy",
    handler: async (args, ctx) => {
      const command = args?.trim() ?? "";
      const parsedMode = parsePermissionModeCommand(command);
      if (command.startsWith("mode")) {
        if (!parsedMode) {
          ctx.ui.notify("Usage: /perms mode <manual|auto|allow-all>", "error");
          return;
        }
        setMode(parsedMode, ctx);
        return;
      }
      if (command) {
        ctx.ui.notify("Usage: /perms [mode <manual|auto|allow-all>]", "error");
        return;
      }

      const lines = [
        `Mode: ${sessionState.mode.toUpperCase()}`,
        `Policy file: ${POLICY_FILE}`,
        ` exists: ${fs.existsSync(POLICY_FILE)}`,
        "",
        "Log file: " + getLogPath(),
        " exists: " + fs.existsSync(getLogPath()),
        "",
        "Default policies:",
        "",
        "  tools:  " + policy.defaultPolicy.tools,
        "  bash:   " + policy.defaultPolicy.bash,
        "  mcp:    " + policy.defaultPolicy.mcp,
        "  skills: " + policy.defaultPolicy.skills,
        "",
      ];

      if (policy.tools && Object.keys(policy.tools).length > 0) {
        lines.push("Tool permissions:");
        for (const [name, state] of Object.entries(policy.tools)) {
          lines.push("  " + name + ": " + state);
        }
        lines.push("");
      }

      if (policy.bash && Object.keys(policy.bash).length > 0) {
        lines.push("Bash permissions:");
        for (const [pattern, state] of Object.entries(policy.bash)) {
          lines.push('  "' + pattern + '": ' + state);
        }
        lines.push("");
      }

      if (policy.mcp && Object.keys(policy.mcp).length > 0) {
        lines.push("MCP permissions:");
        for (const [pattern, state] of Object.entries(policy.mcp)) {
          lines.push('  "' + pattern + '": ' + state);
        }
        lines.push("");
      }

      if (policy.skills && Object.keys(policy.skills).length > 0) {
        lines.push("Skill permissions:");
        for (const [pattern, state] of Object.entries(policy.skills)) {
          lines.push('  "' + pattern + '": ' + state);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Register the Auto aliases.
  pi.registerCommand("auto", {
    description: "Show or change Auto permission mode",
    handler: async (args, ctx) => {
      const command = args?.trim().toLowerCase() ?? "";
      if (!command) {
        ctx.ui.notify(`Auto mode is ${sessionState.mode === "auto" ? "on" : "off"}`, "info");
        updateStatus(ctx);
        return;
      }
      if (command === "on") {
        setMode("auto", ctx);
        return;
      }
      if (command === "off") {
        setMode("manual", ctx);
        return;
      }
      ctx.ui.notify("Usage: /auto [on|off]", "error");
    },
  });

  async function setClassifierModel(args: string | undefined, ctx: any): Promise<void> {
    const available = await Promise.resolve(ctx.modelRegistry.getAvailable());
    const requested = args?.trim();
    const defaultLabel = "default (active session model)";
    let selection = requested;
    if (!selection) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Cannot select an Auto classifier model in non-interactive mode", "error");
        return;
      }
      selection = await ctx.ui.select(
        "Select Auto classifier model",
        [defaultLabel, ...available.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`)],
      );
      if (!selection) return;
    }

    const reference = selection === "default" || selection === defaultLabel
      ? undefined
      : (() => {
          const separator = selection.indexOf("/");
          if (separator <= 0 || separator === selection.length - 1) return null;
          return { provider: selection.slice(0, separator), id: selection.slice(separator + 1) };
        })();

    if (reference === null) {
      ctx.ui.notify("Usage: /auto-model [default|provider/model]", "error");
      return;
    }

    if (reference) {
      const model = ctx.modelRegistry.find(reference.provider, reference.id);
      const authenticated = model && available.some((candidate: { provider: string; id: string }) => (
        candidate === model || (candidate.provider === reference.provider && candidate.id === reference.id)
      ));
      if (!model || !authenticated) {
        ctx.ui.notify(`Auto classifier model ${selection} is missing or unauthenticated`, "error");
        return;
      }
    }

    try {
      await updatePolicyFile(POLICY_FILE, (document) => {
        document.auto ??= {};
        if (reference) document.auto.classifierModel = reference;
        else delete document.auto.classifierModel;
      });
      policy = loadPolicy(POLICY_FILE);
      updateStatus(ctx);
      ctx.ui.notify(reference ? `Auto classifier model set to ${selection}` : "Auto classifier model reset to the active session model", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not persist Auto classifier model: ${message}`, "error");
    }
  }

  pi.registerCommand("auto-model", {
    description: "Select or show the Auto classifier model",
    handler: async (args, ctx) => {
      try {
        await setClassifierModel(args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not list Auto classifier models: ${message}`, "error");
      }
    },
  });

  // Register command to toggle session-wide allow-all mode.
  pi.registerCommand("perms-allow-all", {
    description: "Toggle session-wide allow all permissions",
    handler: async (_args, ctx) => {
      setMode(sessionState.mode === "allow-all" ? "manual" : "allow-all", ctx);
    },
  });

  // Register command to allow similar commands
  pi.registerCommand("perms-allow-similar", {
    description: "Add a pattern to allow similar commands for this session",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /perms-allow-similar <pattern>", "error");
        return;
      }
      sessionState.allowedPatterns.push(args);
      ctx.ui.notify(`Added pattern to session allowlist: ${args}`, "info");
    },
  });

  // Register command to clear session allowances
  pi.registerCommand("perms-clear", {
    description: "Clear session allowances and allowed patterns",
    handler: async (_args, ctx) => {
      setMode("manual", ctx);
      ctx.ui.notify("Session allowances cleared", "info");
    },
  });

  // Register a command to view permission logs
  pi.registerCommand("perms-log", {
    description: "Show permission log (last N entries)",
    handler: async (args, ctx) => {
      const logPath = getLogPath();
      if (!fs.existsSync(logPath)) {
        ctx.ui.notify("No permission log found", "info");
        return;
      }

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.trim());
      const numEntries = args ? parseInt(args) || 10 : 10;
      const recent = lines.slice(-numEntries);

      const formatted = recent.map(line => {
        try {
          const entry = JSON.parse(line);
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const target = entry.toolName || entry.command || entry.mcpTarget || entry.skillName || "unknown";
          return `[${time}] ${entry.source}:${target} -> ${entry.state}`;
        } catch {
          return line;
        }
      }).join("\n");

      ctx.ui.notify(formatted || "No entries", "info");
    },
  });
}
