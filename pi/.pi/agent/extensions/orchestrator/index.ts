/**
 * Pi Orchestrator
 *
 * Agent-pi-inspired orchestration layer for this Pi setup:
 * - /team <name> <task>      Run a named team in parallel
 * - /chain <name> <task>     Run a named chain sequentially
 * - /pipeline <name> <task>  Run a named pipeline in parallel with task templates
 * - /mode [name]             Set or show an operational mode
 * - orchestrate tool         Same orchestration primitives callable by the LLM
 *
 * Config lives in ~/.pi/agent/orchestrator/*.yaml. The YAML parser intentionally
 * supports a small, safe subset used by the generated starter files.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type ModeName = "normal" | "plan" | "spec" | "pipeline" | "team" | "chain";
type AgentSource = "user" | "project";

interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

interface TeamConfig {
  description?: string;
  agents: string[];
  prompt?: string;
  model?: string;
  tools?: string[];
}

interface StepConfig {
  agent: string;
  prompt: string;
  model?: string;
  tools?: string[];
}

interface ChainConfig {
  description?: string;
  steps: StepConfig[];
}

interface PipelineConfig {
  description?: string;
  tasks: StepConfig[];
}

interface OrchestratorConfig {
  teams: Record<string, TeamConfig>;
  chains: Record<string, ChainConfig>;
  pipelines: Record<string, PipelineConfig>;
}

interface RunResult {
  agent: string;
  ok: boolean;
  output: string;
  stderr: string;
  exitCode: number;
  turns: number;
  model?: string;
}

const CONFIG_DIR = path.join(getAgentDir(), "orchestrator");
const USER_AGENTS_DIR = path.join(getAgentDir(), "agents");
const DEFAULT_MAX_TURNS = 10;
// Default to disabling extensions in child agents to avoid recursive
// orchestrator/auto-review loops. Set PI_ORCHESTRATOR_CHILD_EXTENSIONS=1 if
// your subagents need extension-provided providers, tools, or auth behavior.
const DISABLE_CHILD_EXTENSIONS = process.env.PI_ORCHESTRATOR_CHILD_EXTENSIONS !== "1";

const STARTER_TEAMS = `teams:
  review:
    description: Parallel code review and test analysis
    agents: [reviewer, tester]
    prompt: "Review this task from your specialty. Task: $ORIGINAL"

  plan:
    description: Scout and plan without editing files
    agents: [scout, planner]
    prompt: "Analyze and plan for this request. Do not edit files. Request: $ORIGINAL"

  ship:
    description: Final readiness check before shipping
    agents: [reviewer, tester]
    prompt: "Assess whether this is ready to ship. Focus on blockers and concise recommendations. Task: $ORIGINAL"
`;

const STARTER_CHAINS = `chains:
  implement:
    description: Plan, implement, then review
    steps:
      - agent: planner
        prompt: "Create a concise implementation plan for: $ORIGINAL"
      - agent: worker
        prompt: "Implement the plan below. Original request: $ORIGINAL\\n\\nPlan:\\n$INPUT"
      - agent: reviewer
        prompt: "Review the implementation. Original request: $ORIGINAL\\n\\nPrevious output:\\n$INPUT"

  research:
    description: Scout, synthesize, then produce final guidance
    steps:
      - agent: scout
        prompt: "Gather relevant local context for: $ORIGINAL"
      - agent: planner
        prompt: "Synthesize the findings into a clear recommendation. Original request: $ORIGINAL\\n\\nFindings:\\n$INPUT"
`;

const STARTER_PIPELINES = `pipelines:
  parallel-review:
    description: Independent parallel review perspectives
    tasks:
      - agent: reviewer
        prompt: "Review for correctness, maintainability, and security. Task: $ORIGINAL"
      - agent: tester
        prompt: "Analyze test coverage and validation strategy. Task: $ORIGINAL"
      - agent: explorer
        prompt: "Map the relevant files and architecture. Task: $ORIGINAL"
`;

function ensureStarterConfig(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const files: Array<[string, string]> = [
    ["teams.yaml", STARTER_TEAMS],
    ["chains.yaml", STARTER_CHAINS],
    ["pipelines.yaml", STARTER_PIPELINES],
  ];
  for (const [name, content] of files) {
    const filePath = path.join(CONFIG_DIR, name);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, "utf-8");
  }
}

function parseScalar(value: string): any {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => String(parseScalar(item.trim())));
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
  return trimmed;
}

function parseKeyValue(line: string): { key: string; value?: string } | null {
  const idx = line.indexOf(":");
  if (idx < 0) return null;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

function parseSimpleYaml(content: string): Partial<OrchestratorConfig> {
  const result: Partial<OrchestratorConfig> = { teams: {}, chains: {}, pipelines: {} };
  let section: "teams" | "chains" | "pipelines" | undefined;
  let currentName: string | undefined;
  let currentList: "steps" | "tasks" | undefined;
  let currentItem: StepConfig | undefined;

  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)?.[0].length ?? 0;
    const line = raw.trim();

    if (indent === 0 && line.endsWith(":")) {
      const key = line.slice(0, -1);
      if (key === "teams" || key === "chains" || key === "pipelines") {
        section = key;
        currentName = undefined;
        currentList = undefined;
      }
      continue;
    }

    if (!section) continue;

    if (indent === 2 && line.endsWith(":")) {
      currentName = line.slice(0, -1).trim();
      currentList = undefined;
      currentItem = undefined;
      if (section === "teams") result.teams![currentName] = { agents: [] };
      if (section === "chains") result.chains![currentName] = { steps: [] };
      if (section === "pipelines") result.pipelines![currentName] = { tasks: [] };
      continue;
    }

    if (!currentName) continue;

    if (indent === 4) {
      const kv = parseKeyValue(line);
      if (!kv) continue;
      if ((kv.key === "steps" || kv.key === "tasks") && !kv.value) {
        currentList = kv.key;
        currentItem = undefined;
        continue;
      }
      const value = parseScalar(kv.value ?? "");
      if (section === "teams") (result.teams![currentName] as any)[kv.key] = value;
      if (section === "chains" && kv.key === "description") result.chains![currentName].description = String(value);
      if (section === "pipelines" && kv.key === "description") result.pipelines![currentName].description = String(value);
      continue;
    }

    if (indent === 6 && line.startsWith("- ") && currentList) {
      const rest = line.slice(2).trim();
      const item: StepConfig = { agent: "", prompt: "$ORIGINAL" };
      const kv = parseKeyValue(rest);
      if (kv) (item as any)[kv.key] = parseScalar(kv.value ?? "");
      if (section === "chains" && currentList === "steps") result.chains![currentName].steps.push(item);
      if (section === "pipelines" && currentList === "tasks") result.pipelines![currentName].tasks.push(item);
      currentItem = item;
      continue;
    }

    if (indent === 8 && currentItem) {
      const kv = parseKeyValue(line);
      if (!kv) continue;
      (currentItem as any)[kv.key] = parseScalar(kv.value ?? "");
    }
  }

  return result;
}

function mergeConfig(target: OrchestratorConfig, partial: Partial<OrchestratorConfig>): void {
  Object.assign(target.teams, partial.teams ?? {});
  Object.assign(target.chains, partial.chains ?? {});
  Object.assign(target.pipelines, partial.pipelines ?? {});
}

function loadConfig(): OrchestratorConfig {
  ensureStarterConfig();
  const config: OrchestratorConfig = { teams: {}, chains: {}, pipelines: {} };
  for (const name of ["teams.yaml", "chains.yaml", "pipelines.yaml"]) {
    const filePath = path.join(CONFIG_DIR, name);
    if (!fs.existsSync(filePath)) continue;
    mergeConfig(config, parseSimpleYaml(fs.readFileSync(filePath, "utf-8")));
  }
  return config;
}

function splitCommandArgs(args: string): { name?: string; task?: string } {
  const trimmed = args.trim();
  if (!trimmed) return {};
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  return { name: match?.[1], task: match?.[2]?.trim() };
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  const agents: AgentConfig[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean),
      // Avoid stale per-agent model defaults from old configs unless explicitly
      // selected in orchestrator YAML. Pi's current default model is safer.
      model: undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function findProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function discoverAgents(cwd: string, includeProjectAgents: boolean): AgentConfig[] {
  const byName = new Map<string, AgentConfig>();
  for (const agent of loadAgentsFromDir(USER_AGENTS_DIR, "user")) byName.set(agent.name, agent);
  if (includeProjectAgents) {
    const projectDir = findProjectAgentsDir(cwd);
    if (projectDir) for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

function applyTemplate(template: string | undefined, original: string, input: string, agent: string): string {
  return (template || "Task: $ORIGINAL")
    .replace(/\$ORIGINAL/g, original)
    .replace(/\$INPUT/g, input)
    .replace(/\$AGENT/g, agent);
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writeTempPrompt(agentName: string, prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-"));
  const safe = agentName.replace(/[^\w.-]+/g, "_");
  const file = path.join(dir, `${safe}.md`);
  await fs.promises.writeFile(file, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, file };
}

async function runAgent(options: {
  cwd: string;
  agent: AgentConfig;
  task: string;
  model?: string;
  tools?: string[];
  signal?: AbortSignal;
  maxTurns?: number;
}): Promise<RunResult> {
  const { cwd, agent, task, signal, maxTurns = DEFAULT_MAX_TURNS } = options;
  const tools = options.tools ?? agent.tools;
  const model = options.model ?? agent.model;
  const systemPrompt = `${agent.systemPrompt}\n\n## Orchestrator Context\nYou are running as the ${agent.name} subagent. Be concise and return a useful handoff summary.`;
  const tmp = await writeTempPrompt(agent.name, systemPrompt);
  const args = ["--mode", "json", "-p", "--no-session"];
  if (DISABLE_CHILD_EXTENSIONS) args.push("--no-extensions");
  args.push("--append-system-prompt", tmp.file);
  if (tools?.length) args.push("--tools", tools.join(","));
  if (model) args.push("--model", model);
  args.push(task);

  const result: RunResult = { agent: agent.name, ok: false, output: "", stderr: "", exitCode: 1, turns: 0, model };

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let terminationReason: string | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            result.turns++;
            const text = event.message.content
              ?.filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join("\n")
              .trim();
            if (text) result.output = text;
            if (event.message.model && !result.model) result.model = event.message.model;
            if (maxTurns && result.turns >= maxTurns) {
              terminationReason = `maxTurns limit reached (${maxTurns})`;
              proc.kill("SIGTERM");
            }
          }
        } catch {
          // ignore non-JSON noise
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => { result.stderr += data.toString(); });
      let abort: (() => void) | undefined;
      const cleanup = () => {
        if (signal && abort) signal.removeEventListener("abort", abort);
      };

      proc.on("close", (code, closeSignal) => {
        cleanup();
        if (buffer.trim()) processLine(buffer);
        if (terminationReason) {
          result.stderr += `${result.stderr ? "\n" : ""}${terminationReason}`;
        } else if (closeSignal) {
          result.stderr += `${result.stderr ? "\n" : ""}Child agent terminated by ${closeSignal}`;
        }
        resolve(code ?? (closeSignal ? 1 : 0));
      });
      proc.on("error", (err) => {
        cleanup();
        result.stderr += err instanceof Error ? err.message : String(err);
        resolve(1);
      });
      if (signal) {
        abort = () => {
          terminationReason = "Child agent aborted by parent signal";
          proc.kill("SIGTERM");
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });

    result.exitCode = exitCode;
    result.ok = exitCode === 0;
    if (!result.output && result.stderr) result.output = result.stderr.trim();
    if (!result.output) result.output = "(no output)";
    return result;
  } finally {
    await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatResults(title: string, results: RunResult[]): string {
  const lines = [`# ${title}`, ""];
  for (const result of results) {
    const status = result.ok ? "✅" : "❌";
    lines.push(`## ${status} ${result.agent}`);
    if (result.model) lines.push(`_Model: ${result.model}_`);
    lines.push("", result.output.trim() || "(no output)", "");
    if (!result.ok && result.stderr.trim()) lines.push("```stderr", result.stderr.trim(), "```", "");
  }
  return lines.join("\n").trim();
}

async function runTeam(name: string, task: string, cwd: string, includeProjectAgents: boolean, signal?: AbortSignal): Promise<string> {
  const config = loadConfig();
  const team = config.teams[name];
  if (!team) throw new Error(`Unknown team '${name}'. Available: ${Object.keys(config.teams).join(", ") || "none"}`);
  const agents = discoverAgents(cwd, includeProjectAgents);
  const results = await Promise.all(team.agents.map((agentName) => {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) return Promise.resolve({ agent: agentName, ok: false, output: `Agent '${agentName}' not found`, stderr: "", exitCode: 1, turns: 0 });
    return runAgent({
      cwd,
      agent,
      task: applyTemplate(team.prompt, task, "", agentName),
      model: team.model,
      tools: team.tools,
      signal,
    });
  }));
  return formatResults(`Team: ${name}`, results);
}

async function runPipeline(name: string, task: string, cwd: string, includeProjectAgents: boolean, signal?: AbortSignal): Promise<string> {
  const config = loadConfig();
  const pipeline = config.pipelines[name];
  if (!pipeline) throw new Error(`Unknown pipeline '${name}'. Available: ${Object.keys(config.pipelines).join(", ") || "none"}`);
  const agents = discoverAgents(cwd, includeProjectAgents);
  const results = await Promise.all(pipeline.tasks.map((item) => {
    const agent = agents.find((a) => a.name === item.agent);
    if (!agent) return Promise.resolve({ agent: item.agent, ok: false, output: `Agent '${item.agent}' not found`, stderr: "", exitCode: 1, turns: 0 });
    return runAgent({
      cwd,
      agent,
      task: applyTemplate(item.prompt, task, "", item.agent),
      model: item.model,
      tools: item.tools,
      signal,
    });
  }));
  return formatResults(`Pipeline: ${name}`, results);
}

async function runChain(name: string, task: string, cwd: string, includeProjectAgents: boolean, signal?: AbortSignal): Promise<string> {
  const config = loadConfig();
  const chain = config.chains[name];
  if (!chain) throw new Error(`Unknown chain '${name}'. Available: ${Object.keys(config.chains).join(", ") || "none"}`);
  const agents = discoverAgents(cwd, includeProjectAgents);
  const results: RunResult[] = [];
  let previous = "";
  for (const step of chain.steps) {
    const agent = agents.find((a) => a.name === step.agent);
    if (!agent) {
      results.push({ agent: step.agent, ok: false, output: `Agent '${step.agent}' not found`, stderr: "", exitCode: 1, turns: 0 });
      break;
    }
    const result = await runAgent({
      cwd,
      agent,
      task: applyTemplate(step.prompt, task, previous, step.agent),
      model: step.model,
      tools: step.tools,
      signal,
    });
    results.push(result);
    previous = result.output;
    if (!result.ok) break;
  }
  return formatResults(`Chain: ${name}`, results);
}

function listConfig(config: OrchestratorConfig): string {
  const section = (title: string, entries: Record<string, { description?: string }>) => {
    const names = Object.entries(entries);
    if (names.length === 0) return [`## ${title}`, "- none"];
    return [`## ${title}`, ...names.map(([name, value]) => `- **${name}**${value.description ? ` — ${value.description}` : ""}`)];
  };
  return [
    `Config: ${CONFIG_DIR}`,
    "",
    ...section("Teams", config.teams),
    "",
    ...section("Chains", config.chains),
    "",
    ...section("Pipelines", config.pipelines),
  ].join("\n");
}

export default function orchestratorExtension(pi: ExtensionAPI) {
  let mode: ModeName = "normal";

  ensureStarterConfig();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("mode", mode === "normal" ? undefined : `mode: ${mode}`);
  });

  pi.on("before_agent_start", () => {
    if (mode === "normal") return;
    return {
      message: {
        customType: "orchestrator-mode",
        content: `[ORCHESTRATOR MODE: ${mode.toUpperCase()}]\nAdapt your workflow to this mode. Prefer /team, /chain, /pipeline, or the orchestrate tool when decomposition is useful.`,
        display: false,
      },
    };
  });

  pi.registerCommand("orchestrator", {
    description: "List orchestrator teams, chains, pipelines, and config path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(listConfig(loadConfig()), "info");
    },
  });

  pi.registerCommand("mode", {
    description: "Show or set operational mode: normal, plan, spec, pipeline, team, chain",
    handler: async (args, ctx) => {
      const next = args.trim().toLowerCase() as ModeName;
      if (!next) {
        ctx.ui.notify(`Current mode: ${mode}`, "info");
        return;
      }
      if (!["normal", "plan", "spec", "pipeline", "team", "chain"].includes(next)) {
        ctx.ui.notify("Usage: /mode normal|plan|spec|pipeline|team|chain", "error");
        return;
      }
      mode = next;
      ctx.ui.setStatus("mode", mode === "normal" ? undefined : `mode: ${mode}`);
      ctx.ui.notify(`Mode set to ${mode}`, "info");
    },
  });

  pi.registerCommand("team", {
    description: "Run a configured agent team in parallel: /team <name> <task>",
    handler: async (args, ctx) => {
      const { name, task } = splitCommandArgs(args);
      if (!name || !task) {
        ctx.ui.notify(`Usage: /team <name> <task>\n\n${listConfig(loadConfig())}`, "info");
        return;
      }
      ctx.ui.notify(`Running team '${name}'...`, "info");
      try {
        const output = await runTeam(name, task, ctx.cwd, ctx.isProjectTrusted(), ctx.signal);
        pi.sendMessage({ customType: "orchestrator-result", content: output, display: true });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("chain", {
    description: "Run a configured sequential chain: /chain <name> <task>",
    handler: async (args, ctx) => {
      const { name, task } = splitCommandArgs(args);
      if (!name || !task) {
        ctx.ui.notify(`Usage: /chain <name> <task>\n\n${listConfig(loadConfig())}`, "info");
        return;
      }
      ctx.ui.notify(`Running chain '${name}'...`, "info");
      try {
        const output = await runChain(name, task, ctx.cwd, ctx.isProjectTrusted(), ctx.signal);
        pi.sendMessage({ customType: "orchestrator-result", content: output, display: true });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("pipeline", {
    description: "Run a configured parallel pipeline: /pipeline <name> <task>",
    handler: async (args, ctx) => {
      const { name, task } = splitCommandArgs(args);
      if (!name || !task) {
        ctx.ui.notify(`Usage: /pipeline <name> <task>\n\n${listConfig(loadConfig())}`, "info");
        return;
      }
      ctx.ui.notify(`Running pipeline '${name}'...`, "info");
      try {
        const output = await runPipeline(name, task, ctx.cwd, ctx.isProjectTrusted(), ctx.signal);
        pi.sendMessage({ customType: "orchestrator-result", content: output, display: true });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description: "Run configured agent-pi-style teams, chains, or pipelines.",
    promptSnippet: "Run named teams, chains, or pipelines for multi-agent orchestration.",
    promptGuidelines: [
      "Use orchestrate when a task benefits from multiple specialized agents or sequential handoffs.",
      "Use orchestrate with mode 'team' for independent parallel perspectives, 'chain' for handoffs, and 'pipeline' for configured parallel task templates.",
    ],
    parameters: Type.Object({
      mode: StringEnum(["team", "chain", "pipeline"] as const, { description: "Orchestration mode" }),
      name: Type.String({ description: "Configured team, chain, or pipeline name" }),
      task: Type.String({ description: "Task to run" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const output =
        params.mode === "team"
          ? await runTeam(params.name, params.task, ctx.cwd, ctx.isProjectTrusted(), signal)
          : params.mode === "chain"
            ? await runChain(params.name, params.task, ctx.cwd, ctx.isProjectTrusted(), signal)
            : await runPipeline(params.name, params.task, ctx.cwd, ctx.isProjectTrusted(), signal);
      return { content: [{ type: "text", text: output }], details: { mode: params.mode, name: params.name } };
    },
  });
}
