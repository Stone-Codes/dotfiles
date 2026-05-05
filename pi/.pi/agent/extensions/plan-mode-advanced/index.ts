/**
 * Advanced Plan Mode Extension
 *
 * Features:
 * - Sub-agent architecture (scout + planner agents)
 * - Plans written to PLAN.md with checkbox format
 * - Interactive step-by-step approval
 * - Progress tracking with TUI widget
 * - Session persistence
 * - Support for both coding and general plans
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage, ToolCallContent } from "@mariozechner/pi-ai";
import { Key } from "@mariozechner/pi-tui";
import { z } from "zod";
import { writeFile, readFile, existsSync } from "node:fs";
import { join } from "node:path";

// Tool sets
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXECUTE_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
  approved: boolean;
}

interface PlanData {
  goal: string;
  steps: PlanStep[];
  files: string[];
  risks: string[];
  createdAt: number;
  filePath: string;
}

export default function advancedPlanMode(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executionMode = false;
  let currentPlan: PlanData | null = null;
  let currentStepIndex = 0;

  // ==================== State Management ====================

  function getPlanFilePath(): string {
    return join(process.cwd(), "PLAN.md");
  }

  function savePlanToDisk(plan: PlanData): Promise<void> {
    const markdown = generatePlanMarkdown(plan);
    return new Promise((resolve, reject) => {
      writeFile(plan.filePath, markdown, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function loadPlanFromDisk(): Promise<PlanData | null> {
    const filePath = getPlanFilePath();
    return new Promise((resolve) => {
      if (!existsSync(filePath)) {
        resolve(null);
        return;
      }
      readFile(filePath, "utf-8", (err, data) => {
        if (err) {
          resolve(null);
          return;
        }
        const plan = parsePlanMarkdown(data, filePath);
        resolve(plan);
      });
    });
  }

  function generatePlanMarkdown(plan: PlanData): string {
    const lines = [
      "# Plan",
      "",
      `**Goal:** ${plan.goal}`,
      "",
      "## Steps",
      "",
    ];

    for (const step of plan.steps) {
      const checkbox = step.completed ? "[x]" : step.approved ? "[~]" : "[ ]";
      lines.push(`${checkbox} ${step.step}. ${step.text}`);
    }

    if (plan.files.length > 0) {
      lines.push("");
      lines.push("## Files to Modify");
      for (const file of plan.files) {
        lines.push(`- ${file}`);
      }
    }

    if (plan.risks.length > 0) {
      lines.push("");
      lines.push("## Risks");
      for (const risk of plan.risks) {
        lines.push(`- ${risk}`);
      }
    }

    lines.push("");
    lines.push("---");
    lines.push(`*Created: ${new Date(plan.createdAt).toISOString()}*`);

    return lines.join("\n");
  }

  function parsePlanMarkdown(content: string, filePath: string): PlanData | null {
    try {
      const lines = content.split("\n");
      const plan: PlanData = {
        goal: "Unknown goal",
        steps: [],
        files: [],
        risks: [],
        createdAt: Date.now(),
        filePath,
      };

      let inSteps = false;
      let inFiles = false;
      let inRisks = false;

      for (const line of lines) {
        // Extract goal
        const goalMatch = line.match(/\*\*Goal:\*\*\s*(.+)/);
        if (goalMatch) {
          plan.goal = goalMatch[1].trim();
        }

        // Section detection
        if (line.startsWith("## Steps")) {
          inSteps = true;
          inFiles = false;
          inRisks = false;
          continue;
        } else if (line.startsWith("## Files to Modify")) {
          inSteps = false;
          inFiles = true;
          inRisks = false;
          continue;
        } else if (line.startsWith("## Risks")) {
          inSteps = false;
          inFiles = false;
          inRisks = true;
          continue;
        }

        // Parse steps
        if (inSteps) {
          const stepMatch = line.match(/^\[([ x~])\]\s*(\d+)\.\s*(.+)/);
          if (stepMatch) {
            const completed = stepMatch[1] === "x";
            const approved = stepMatch[1] === "~";
            plan.steps.push({
              step: parseInt(stepMatch[2]),
              text: stepMatch[3].trim(),
              completed,
              approved,
            });
          }
        }

        // Parse files
        if (inFiles && line.startsWith("- ")) {
          plan.files.push(line.slice(2).trim());
        }

        // Parse risks
        if (inRisks && line.startsWith("- ")) {
          plan.risks.push(line.slice(2).trim());
        }
      }

      return plan.steps.length > 0 ? plan : null;
    } catch {
      return null;
    }
  }

  // ==================== UI Helpers ====================

  function updateStatus(ctx: ExtensionContext): void {
    if (executionMode && currentPlan) {
      const completed = currentPlan.steps.filter((s) => s.completed).length;
      const approved = currentPlan.steps.filter((s) => s.approved).length;
      ctx.ui.setStatus(
        "plan-mode",
        ctx.ui.theme.fg("accent", `📋 ${completed}/${approved}/${currentPlan.steps.length}`)
      );

      // Widget with next steps
      const nextSteps = currentPlan.steps
        .filter((s) => !s.completed)
        .slice(0, 5)
        .map((s) => {
          const prefix = s.approved ? "⏳" : "⏸";
          return `${prefix} ${s.step}. ${s.text.slice(0, 50)}`;
        });

      if (nextSteps.length > 0) {
        ctx.ui.setWidget("plan-next-steps", [
          ctx.ui.theme.fg("accent", "Next Steps:"),
          ...nextSteps,
        ]);
      }
    } else if (planModeEnabled) {
      ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ Planning"));
    } else {
      ctx.ui.setStatus("plan-mode", undefined);
      ctx.ui.setWidget("plan-next-steps", undefined);
    }
  }

  function persistState(): void {
    pi.appendEntry("plan-mode-advanced", {
      enabled: planModeEnabled,
      executing: executionMode,
      plan: currentPlan,
      currentStepIndex,
    });
  }

  // ==================== Sub-Agent Tools ====================

  // Scout agent - gathers context
  pi.registerTool({
    name: "scout",
    label: "Scout",
    description: "Gather context about code, files, or project structure",
    parameters: z.object({
      query: z.string().describe("What to investigate"),
      focus: z.string().optional().describe("Specific area to focus on"),
    }),
    promptSnippet: "Gather context about code, files, or project structure",
    promptGuidelines: [
      "Use the scout tool to gather context before planning.",
      "Scout explores the codebase and returns findings.",
    ],
    async execute(_toolCallId, params, _signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `🔍 Scouting: ${params.query}...` }],
      });

      // This is a meta-tool - the LLM should use read/grep/find to gather context
      // and return a summary
      return {
        content: [
          {
            type: "text",
            text: `Scouting complete for: ${params.query}\n\nPlease use read, grep, find, and ls tools to gather context, then summarize findings here.`,
          },
        ],
        details: { query: params.query },
      };
    },
  });

  // Planner agent - creates the plan
  pi.registerTool({
    name: "create_plan",
    label: "Create Plan",
    description: "Create a structured plan and save to PLAN.md",
    parameters: z.object({
      goal: z.string().describe("One-sentence summary of what needs to be done"),
      steps: z.array(z.string()).describe("Numbered steps, each specific and actionable"),
      files: z.array(z.string()).optional().describe("Files to modify"),
      risks: z.array(z.string()).optional().describe("Things to watch out for"),
    }),
    promptSnippet: "Create a structured plan with steps",
    promptGuidelines: [
      "Use create_plan tool to formalize the plan after scouting.",
      "create_plan saves the plan to PLAN.md automatically.",
    ],
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "📝 Creating plan..." }],
      });

      const plan: PlanData = {
        goal: params.goal,
        steps: params.steps.map((text, i) => ({
          step: i + 1,
          text,
          completed: false,
          approved: false,
        })),
        files: params.files ?? [],
        risks: params.risks ?? [],
        createdAt: Date.now(),
        filePath: getPlanFilePath(),
      };

      try {
        await savePlanToDisk(plan);
        currentPlan = plan;
        persistState();

        return {
          content: [
            {
              type: "text",
              text: `✅ Plan created with ${plan.steps.length} steps and saved to PLAN.md`,
            },
          ],
          details: { plan },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ Failed to save plan: ${error}` }],
          isError: true,
          details: {},
        };
      }
    },
  });

  // Approve step tool
  pi.registerTool({
    name: "approve_step",
    label: "Approve Step",
    description: "Approve a specific step for execution",
    parameters: z.object({
      step: z.number().describe("Step number to approve"),
    }),
    promptSnippet: "Approve a step for execution",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentPlan) {
        return {
          content: [{ type: "text", text: "❌ No active plan" }],
          isError: true,
          details: {},
        };
      }

      const step = currentPlan.steps.find((s) => s.step === params.step);
      if (!step) {
        return {
          content: [{ type: "text", text: `❌ Step ${params.step} not found` }],
          isError: true,
          details: {},
        };
      }

      step.approved = true;
      await savePlanToDisk(currentPlan);
      persistState();

      return {
        content: [{ type: "text", text: `✅ Step ${params.step} approved` }],
        details: { step: params.step },
      };
    },
  });

  // Complete step tool
  pi.registerTool({
    name: "complete_step",
    label: "Complete Step",
    description: "Mark a step as completed",
    parameters: z.object({
      step: z.number().describe("Step number to mark complete"),
    }),
    promptSnippet: "Mark a step as completed",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!currentPlan) {
        return {
          content: [{ type: "text", text: "❌ No active plan" }],
          isError: true,
          details: {},
        };
      }

      const step = currentPlan.steps.find((s) => s.step === params.step);
      if (!step) {
        return {
          content: [{ type: "text", text: `❌ Step ${params.step} not found` }],
          isError: true,
          details: {},
        };
      }

      step.completed = true;
      step.approved = true;
      await savePlanToDisk(currentPlan);
      persistState();

      return {
        content: [{ type: "text", text: `✅ Step ${params.step} completed` }],
        details: { step: params.step },
      };
    },
  });

  // ==================== Commands ====================

  pi.registerCommand("plan", {
    description: "Toggle advanced plan mode with sub-agents",
    handler: async (_args, ctx) => {
      planModeEnabled = !planModeEnabled;
      executionMode = false;
      currentPlan = null;
      currentStepIndex = 0;

      if (planModeEnabled) {
        pi.setActiveTools(PLAN_MODE_TOOLS);
        ctx.ui.notify("Plan mode enabled. Use scout + create_plan tools.");
      } else {
        pi.setActiveTools(EXECUTE_MODE_TOOLS);
        ctx.ui.notify("Plan mode disabled. Full access restored.");
      }
      updateStatus(ctx);
      persistState();
    },
  });

  pi.registerCommand("plan-view", {
    description: "View current plan from PLAN.md",
    handler: async (_args, ctx) => {
      const plan = await loadPlanFromDisk();
      if (!plan) {
        ctx.ui.notify("No PLAN.md found", "info");
        return;
      }

      const summary = [
        `Goal: ${plan.goal}`,
        `Steps: ${plan.steps.length} (${plan.steps.filter((s) => s.completed).length} completed)`,
        "",
        ...plan.steps.map((s) => {
          const icon = s.completed ? "✓" : s.approved ? "⏳" : "○";
          return `${icon} ${s.step}. ${s.text}`;
        }),
      ].join("\n");

      ctx.ui.notify(summary, "info");
    },
  });

  pi.registerCommand("plan-execute", {
    description: "Start executing the current plan with approval",
    handler: async (_args, ctx) => {
      const plan = await loadPlanFromDisk();
      if (!plan || plan.steps.length === 0) {
        ctx.ui.notify("No plan to execute. Create one first.", "error");
        return;
      }

      currentPlan = plan;
      executionMode = true;
      planModeEnabled = false;
      currentStepIndex = 0;

      pi.setActiveTools(EXECUTE_MODE_TOOLS);
      ctx.ui.notify(`Starting execution of ${plan.steps.length} steps`);
      updateStatus(ctx);
      persistState();

      // Start execution
      pi.sendUserMessage(
        `Execute the plan from PLAN.md. Start with step 1: ${plan.steps[0].text}`,
        { triggerTurn: true }
      );
    },
  });

  // ==================== Shortcuts ====================

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle advanced plan mode",
    handler: async (ctx) => {
      planModeEnabled = !planModeEnabled;
      executionMode = false;

      if (planModeEnabled) {
        pi.setActiveTools(PLAN_MODE_TOOLS);
        ctx.ui.notify("Plan mode (advanced) enabled", "info");
      } else {
        pi.setActiveTools(EXECUTE_MODE_TOOLS);
        ctx.ui.notify("Normal mode restored", "info");
      }
      updateStatus(ctx);
      persistState();
    },
  });

  // ==================== Interactive Approval UI ====================

  async function requestStepApproval(ctx: ExtensionContext, step: PlanStep): Promise<boolean> {
    const choice = await ctx.ui.select(
      `Approve step ${step.step}?`,
      [
        `✅ Approve: ${step.text}`,
        `⏭️  Skip this step`,
        `🛑 Stop execution`,
        `✅✅ Approve all remaining`,
      ]
    );

    if (!choice) return false;

    if (choice.includes("Approve all")) {
      if (currentPlan) {
        for (const s of currentPlan.steps) {
          if (!s.completed) s.approved = true;
        }
        await savePlanToDisk(currentPlan);
        persistState();
      }
      return true;
    }

    if (choice.includes("Approve:")) {
      step.approved = true;
      await savePlanToDisk(currentPlan!);
      persistState();
      return true;
    }

    if (choice.includes("Skip")) {
      step.completed = true;
      step.approved = true;
      await savePlanToDisk(currentPlan!);
      persistState();
      return true;
    }

    if (choice.includes("Stop")) {
      executionMode = false;
      ctx.ui.notify("Execution stopped by user", "info");
      updateStatus(ctx);
      persistState();
      return false;
    }

    return false;
  }

  // ==================== Event Handlers ====================

  // Block destructive commands in plan mode
  pi.on("tool_call", async (event) => {
    if (!planModeEnabled || event.toolName !== "bash") return;

    const command = (event.input as { command: string }).command;
    const destructivePatterns = [
      /\brm\b/i,
      /\bgit\s+(add|commit|push|pull)/i,
      /\bnpm\s+(install|uninstall)/i,
      /\bsudo\b/i,
    ];

    if (destructivePatterns.some((p) => p.test(command))) {
      return {
        block: true,
        reason: "Plan mode: destructive commands blocked. Use /plan to disable.",
      };
    }
  });

  // Intercept before each step to request approval
  pi.on("before_agent_start", async (event, ctx) => {
    if (!executionMode || !currentPlan) return;

    const nextStep = currentPlan.steps.find((s) => !s.completed);
    if (!nextStep) return;

    // If step not approved, ask for approval
    if (!nextStep.approved) {
      const approved = await requestStepApproval(ctx, nextStep);
      if (!approved) {
        // Don't process this turn
        return {
          message: {
            customType: "plan-mode-skip",
            content: "Step not approved, skipping.",
            display: false,
          },
        };
      }
    }
  });

  // Inject context for plan/execution modes
  pi.on("before_agent_start", async () => {
    if (planModeEnabled) {
      return {
        message: {
          customType: "plan-mode-context",
          content: `[PLAN MODE - Advanced]
You are in planning mode with sub-agent capabilities.

Available tools: scout, create_plan, read, bash, grep, find, ls

Workflow:
1. Use scout tool or read/grep/find to gather context
2. Use create_plan tool to formalize the plan (saves to PLAN.md)
3. Plan will have checkbox format: [ ], [~], [x]

DO NOT make changes - only explore and plan.`,
          display: false,
        },
      };
    }

    if (executionMode && currentPlan) {
      const nextStep = currentPlan.steps.find((s) => !s.completed);
      if (nextStep) {
        return {
          message: {
            customType: "plan-execution-context",
            content: `[EXECUTING PLAN]
Goal: ${currentPlan.goal}

Current step: ${nextStep.step}. ${nextStep.text}

After completing, use complete_step tool.
Ask for approval if needed.`,
            display: false,
          },
        };
      }
    }
  });

  // Track step completion
  pi.on("turn_end", async (event, ctx) => {
    if (!executionMode || !currentPlan) return;

    const message = event.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;

    const text = message.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    // Check for step completion markers
    const doneMatch = text.match(/complete_step.*?(\d+)/i);
    if (doneMatch) {
      const stepNum = parseInt(doneMatch[1]);
      const step = currentPlan.steps.find((s) => s.step === stepNum);
      if (step) {
        step.completed = true;
        step.approved = true;
        await savePlanToDisk(currentPlan);
        updateStatus(ctx);
        persistState();
      }
    }
  });

  // Handle plan completion
  pi.on("agent_end", async (event, ctx) => {
    if (!executionMode || !currentPlan) return;

    const allDone = currentPlan.steps.every((s) => s.completed);
    if (allDone) {
      ctx.ui.notify("🎉 Plan completed!", "success");
      executionMode = false;
      updateStatus(ctx);
      persistState();
    }
  });

  // Restore state on session start
  pi.on("session_start", async (event, ctx) => {
    // Try to load from disk first
    const diskPlan = await loadPlanFromDisk();
    if (diskPlan) {
      currentPlan = diskPlan;
    }

    // Override with persisted state if newer
    const entries = ctx.sessionManager.getEntries();
    const lastState = entries
      .filter((e: any) => e.type === "custom" && e.customType === "plan-mode-advanced")
      .pop() as any;

    if (lastState?.data) {
      if (lastState.data.plan && (!currentPlan || lastState.timestamp > currentPlan.createdAt)) {
        currentPlan = lastState.data.plan;
      }
      planModeEnabled = lastState.data.enabled ?? false;
      executionMode = lastState.data.executing ?? false;
      currentStepIndex = lastState.data.currentStepIndex ?? 0;
    }

    if (planModeEnabled) {
      pi.setActiveTools(PLAN_MODE_TOOLS);
    } else if (executionMode) {
      pi.setActiveTools(EXECUTE_MODE_TOOLS);
    }

    updateStatus(ctx);
  });
}
