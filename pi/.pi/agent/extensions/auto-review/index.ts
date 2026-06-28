/**
 * Auto Review
 *
 * Claude-Code-style review-before-final helper. After a normal TUI/RPC agent
 * turn successfully mutates files, this extension asks whether to run the
 * configured orchestrator review pipeline. It intentionally skips print/json
 * subagent processes to avoid nested review loops.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type AutoReviewMode = "off" | "ask" | "auto";

interface AutoReviewSettings {
  mode: AutoReviewMode;
  pipeline: string;
  minSecondsBetweenRuns: number;
}

interface MutationSummary {
  files: string[];
  bashCommands: string[];
}

const SETTINGS_PATH = path.join(getAgentDir(), "auto-review.json");
const DEFAULT_SETTINGS: AutoReviewSettings = {
  mode: "ask",
  pipeline: "parallel-review",
  minSecondsBetweenRuns: 60,
};

function loadSettings(): AutoReviewSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as Partial<AutoReviewSettings>;
    return {
      mode: parsed.mode === "off" || parsed.mode === "ask" || parsed.mode === "auto" ? parsed.mode : DEFAULT_SETTINGS.mode,
      pipeline: typeof parsed.pipeline === "string" && parsed.pipeline.trim() ? parsed.pipeline.trim() : DEFAULT_SETTINGS.pipeline,
      minSecondsBetweenRuns:
        typeof parsed.minSecondsBetweenRuns === "number" && Number.isFinite(parsed.minSecondsBetweenRuns)
          ? Math.max(0, parsed.minSecondsBetweenRuns)
          : DEFAULT_SETTINGS.minSecondsBetweenRuns,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AutoReviewSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isReadOnlyBash(command: string): boolean {
  const cmd = command
    .trim()
    .replace(/\s+2>\s*\/dev\/null/g, "")
    .replace(/\s+\|\|\s+true\s*$/g, "")
    .trim();
  const dangerous = /\b(rm|mv|cp|chmod|chown|sudo|git\s+(add|commit|push|pull|merge|rebase|checkout|switch|restore|reset)|pi\s+update|npm\s+install|pnpm\s+install|yarn\s+add)\b|>|>>/;
  if (!cmd || dangerous.test(cmd)) return false;

  const splitOutsideQuotes = (text, separators) => {
    const parts = [];
    let current = "";
    let quote;
    let escaped = false;
    for (const char of text) {
      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        current += char;
        escaped = true;
        continue;
      }
      if ((char === "'" || char === '"') && !quote) {
        quote = char;
        current += char;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        current += char;
        continue;
      }
      if (!quote && separators.includes(char)) {
        if (current.trim()) parts.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  const readOnly = [
    /^pwd\b[^;&|<>]*$/,
    /^ls\b[^;&|<>]*$/,
    /^cat\b[^;&|<>]*$/,
    /^head\b[^;&|<>]*$/,
    /^tail\b[^;&|<>]*$/,
    /^grep\b[^;&|<>]*$/,
    /^rg\b[^;&|<>]*$/,
    /^sort\b[^;&|<>]*$/,
    /^echo\b[^;&|<>]*$/,
    /^printf\b[^;&|<>]*$/,
    /^find\b(?!.*\s(-delete|-exec)\b)[^;&|<>]*$/,
    /^find\s+[^<>]*\s-exec\s+sh\s+-c\s+'echo --- \$1; sed -n "1,120p" "\$1"'\s+sh\s+\{\}\s+\\;$/,
    /^du\s+(-[A-Za-z]+\s+)*[^;&|<>]*$/,
    /^wc\s+(-[A-Za-z]+\s+)*[^;&|<>]*$/,
    /^git\s+(?:-C\s+\S+\s+)?(status|diff|log|show|ls-files|branch\s*(-a|--all|-r|--remotes|--list)?|remote\s*(-v|--verbose)?\s*)\b[^;&|<>]*$/,
    /^pi\s+(--version\b|list\b|--list-models\b)[^;&|<>]*$/,
    /^for\s+\w+\s+in\s+[^;&|<>]+;\s*do\s+echo\s+[^;&|<>]+;\s*head\s+-?\d*\s+"?\$\w+"?;\s*done$/,
    /^npm\s+(test|run\s+\S+)[^;&|<>]*$/,
    /^pnpm\s+(test|run\s+\S+)[^;&|<>]*$/,
    /^yarn\s+(test|run\s+\S+)[^;&|<>]*$/,
  ];

  const isReadOnlySingle = (single) => readOnly.some((pattern) => pattern.test(single));
  const isReadOnlyPipeline = (single) => splitOutsideQuotes(single, "|").every(isReadOnlySingle);

  if (isReadOnlySingle(cmd)) return true;
  return splitOutsideQuotes(cmd, ";\n").every(isReadOnlyPipeline);
}

function summarizeMutations(messages: any[]): MutationSummary {
  const successfulToolIds = new Set<string>();
  const files: string[] = [];
  const bashCommands: string[] = [];

  for (const message of messages) {
    if (message?.role === "toolResult" && !message.isError) {
      successfulToolIds.add(message.toolCallId);
    }
  }

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "toolCall") continue;
      const id = part.id;
      if (!id || !successfulToolIds.has(id)) continue;
      const args = part.arguments ?? {};
      if ((part.name === "write" || part.name === "edit") && typeof args.path === "string") {
        files.push(args.path);
      }
      if (part.name === "bash" && typeof args.command === "string" && !isReadOnlyBash(args.command)) {
        bashCommands.push(args.command);
      }
    }
  }

  return { files: unique(files), bashCommands: unique(bashCommands) };
}

function makeSignature(summary: MutationSummary, status: string): string {
  return createHash("sha256")
    .update(JSON.stringify(summary))
    .update("\n")
    .update(status)
    .digest("hex");
}

function buildReviewTask(summary: MutationSummary, gitStatus: string): string {
  const fileList = summary.files.length > 0 ? summary.files.map((file) => `- ${file}`).join("\n") : "- Unknown or bash-generated changes";
  const bashList = summary.bashCommands.length > 0 ? summary.bashCommands.map((cmd) => `- ${cmd}`).join("\n") : "- none";
  const statusBlock = gitStatus.trim() ? gitStatus.trim() : "No git status available or no tracked git changes detected.";

  return [
    "Review the latest code changes from the just-completed agent turn.",
    "Focus on correctness, regressions, security, maintainability, and test coverage.",
    "Use read-only commands only. Do not edit files.",
    "",
    "Changed files observed from tools:",
    fileList,
    "",
    "Unclassified bash commands observed:",
    bashList,
    "",
    "Git status:",
    "```",
    statusBlock,
    "```",
  ].join("\n");
}

function queueReview(pi: ExtensionAPI, settings: AutoReviewSettings, task: string): void {
  pi.sendUserMessage(`/pipeline ${settings.pipeline} ${task}`, { deliverAs: "followUp" });
}

async function getGitStatus(pi: ExtensionAPI): Promise<string> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch {
    return "";
  }
}

async function handleRunCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, settings: AutoReviewSettings): Promise<void> {
  await ctx.waitForIdle();
  const task = args.trim() || "Review the current working tree changes. Use read-only commands only.";
  queueReview(pi, settings, task);
  ctx.ui.notify(`Queued /pipeline ${settings.pipeline}`, "info");
}

export default function autoReviewExtension(pi: ExtensionAPI) {
  let settings = loadSettings();
  let lastRunAt = 0;
  let lastSignature = "";

  pi.registerCommand("auto-review", {
    description: "Configure or run automatic review after changes: /auto-review [status|ask|auto|off|run|pipeline <name>]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [command, ...rest] = trimmed.split(/\s+/).filter(Boolean);

      if (!command || command === "status") {
        ctx.ui.notify(
          [
            `Auto-review mode: ${settings.mode}`,
            `Pipeline: ${settings.pipeline}`,
            `Cooldown: ${settings.minSecondsBetweenRuns}s`,
            `Config: ${SETTINGS_PATH}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (command === "ask" || command === "auto" || command === "off") {
        settings = { ...settings, mode: command };
        saveSettings(settings);
        ctx.ui.notify(`Auto-review mode set to ${settings.mode}`, "info");
        return;
      }

      if (command === "pipeline") {
        const pipeline = rest.join(" ").trim();
        if (!pipeline) {
          ctx.ui.notify("Usage: /auto-review pipeline <pipeline-name>", "error");
          return;
        }
        settings = { ...settings, pipeline };
        saveSettings(settings);
        ctx.ui.notify(`Auto-review pipeline set to ${pipeline}`, "info");
        return;
      }

      if (command === "run") {
        await handleRunCommand(pi, rest.join(" "), ctx, settings);
        return;
      }

      ctx.ui.notify("Usage: /auto-review [status|ask|auto|off|run|pipeline <name>]", "error");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    settings = loadSettings();
    ctx.ui.setStatus("auto-review", settings.mode === "off" ? undefined : `review: ${settings.mode}`);
  });

  pi.on("agent_end", async (event, ctx) => {
    settings = loadSettings();
    ctx.ui.setStatus("auto-review", settings.mode === "off" ? undefined : `review: ${settings.mode}`);

    if (settings.mode === "off") return;
    // Skip print/json mode so subagents and CLI smoke tests do not recursively queue reviews.
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;

    const summary = summarizeMutations(event.messages as any[]);
    const sawMutationThisTurn = summary.files.length > 0 || summary.bashCommands.length > 0;
    if (!sawMutationThisTurn) return;

    const now = Date.now();
    if (settings.minSecondsBetweenRuns > 0 && now - lastRunAt < settings.minSecondsBetweenRuns * 1000) return;

    const gitStatus = await getGitStatus(pi);
    const signature = makeSignature(summary, gitStatus);
    if (signature === lastSignature) return;

    const task = buildReviewTask(summary, gitStatus);

    if (settings.mode === "ask") {
      if (!ctx.hasUI) return;
      const filePreview = summary.files.slice(0, 6).join("\n") || "bash-generated changes";
      const ok = await ctx.ui.confirm(
        "Run review pipeline?",
        `Detected changes from this turn:\n${filePreview}${summary.files.length > 6 ? "\n..." : ""}\n\nRun /pipeline ${settings.pipeline}?`,
      );
      if (!ok) return;
    }

    lastRunAt = now;
    lastSignature = signature;
    queueReview(pi, settings, task);
    ctx.ui.notify(`Queued review pipeline: ${settings.pipeline}`, "info");
  });
}
