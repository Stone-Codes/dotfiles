import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadPolicy, checkToolPermission, checkBashPermission, checkSkillPermission, checkMcpPermission, deriveMcpTarget } from "./src/permission-manager";
import { getLogPath } from "./src/logging";
import type { SessionPermissionState } from "./types";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const POLICY_FILE = path.join(os.homedir(), ".pi", "agent", "pi-permissions.jsonc");

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
    /^git\s+branch/,
    /^git\s+remote/,
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
    /\.\.\//,
    /^\s*\//,
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(cmd));
}

export default function (pi: ExtensionAPI) {
  let policy = loadPolicy(POLICY_FILE);
  
  // Session state for temporary permission overrides
  const sessionState: SessionPermissionState = {
    allowAll: false,
    allowedPatterns: [],
  };

  // Reload policy on session start (catches external changes)
  pi.on("session_start", async (_event, _ctx) => {
    policy = loadPolicy(POLICY_FILE);
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

  // Enforce permissions on tool calls
  pi.on("tool_call", async (event, ctx) => {
    // Check session-wide allow-all mode
    if (sessionState.allowAll) {
      return; // Allow silently
    }

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
    description: "Show current permission policy",
    handler: async (_args, ctx) => {
      const lines = [
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

  // Register command to toggle session-wide allow-all mode
  pi.registerCommand("perms-allow-all", {
    description: "Toggle session-wide allow all permissions",
    handler: async (_args, ctx) => {
      sessionState.allowAll = !sessionState.allowAll;
      const status = sessionState.allowAll ? "ENABLED" : "DISABLED";
      ctx.ui.notify(`Session allow-all mode: ${status}`, sessionState.allowAll ? "info" : "warning");
      if (sessionState.allowAll) {
        ctx.ui.notify("All permission checks will be bypassed for this session", "warning");
      }
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
      sessionState.allowAll = false;
      sessionState.allowedPatterns = [];
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
