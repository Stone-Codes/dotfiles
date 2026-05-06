/**
 * Refined Subagent Tool - Delegate tasks to specialized agents with dynamic creation
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it an isolated
 * context window. Supports predefined agents from ~/.pi/agent/agents/ and .pi/agents/,
 * as well as dynamic on-the-fly agents with custom prompts.
 *
 * Modes:
 *   - Single: { agent?: "name", task: "...", prompt?: "...", ... }
 *   - Parallel: { tasks: [{ agent?, task, prompt?, ... }, ...] }
 *   - Chain: { chain: [{ agent?, task, prompt?, ... }, ...] }
 *
 * Key refinements over the original:
 *   - Dynamic agents: spawn focused subagents with inline `prompt` without predefined .md files
 *   - Context inheritance: `inheritContext` forwards recent parent session messages
 *   - Iteration budgets: `maxTurns` limits subagent assistant turns
 *   - Per-task overrides: `model`, `tools`, `outputFormat` per invocation
 *   - Rich delegation guidance: tool description includes agent catalog and WHEN to delegate
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const INHERIT_CONTEXT_MESSAGES = 6;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "dynamic" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	maxTurnsReached?: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function buildInheritedContext(sessionManager: any): string {
	try {
		const entries = sessionManager.getEntries?.() || [];
		const contextMessages: string[] = [];
		let count = 0;

		for (let i = entries.length - 1; i >= 0 && count < INHERIT_CONTEXT_MESSAGES; i--) {
			const entry = entries[i];
			if (entry.type !== "message") continue;
			if (entry.message?.role === "user") {
				const text = entry.message.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				if (text) {
					contextMessages.unshift(`User: ${text.slice(0, 800)}`);
					count++;
				}
			} else if (entry.message?.role === "assistant") {
				const text = entry.message.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n");
				if (text) {
					contextMessages.unshift(`Assistant: ${text.slice(0, 800)}`);
					count++;
				}
			}
		}

		if (contextMessages.length === 0) return "";
		return "## Context from main session\n\n" + contextMessages.join("\n\n");
	} catch {
		return "";
	}
}

function buildOutputFormatInstructions(format?: string): string {
	if (!format) return "";
	switch (format.toLowerCase()) {
		case "json":
			return "\n\n## Output Format\n\nReturn your final response as valid JSON inside a markdown code block.";
		case "markdown":
			return "\n\n## Output Format\n\nReturn your final response as well-structured Markdown.";
		default:
			return `\n\n## Output Format\n\n${format}`;
	}
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface RunSingleAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName?: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	// Dynamic overrides
	prompt?: string;
	tools?: string[];
	model?: string;
	maxTurns?: number;
	inheritContext?: boolean;
	outputFormat?: string;
	sessionManager?: any;
}

async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
	const {
		defaultCwd,
		agents,
		agentName,
		task,
		cwd,
		step,
		signal,
		onUpdate,
		makeDetails,
		prompt: dynamicPrompt,
		tools: dynamicTools,
		model: dynamicModel,
		maxTurns,
		inheritContext,
		outputFormat,
		sessionManager,
	} = options;

	const predefinedAgent = agentName ? agents.find((a) => a.name === agentName) : undefined;
	const isDynamic = !predefinedAgent;

	// Resolve agent configuration
	const resolvedName = predefinedAgent?.name || "dynamic";
	const resolvedSource: SingleResult["agentSource"] = predefinedAgent?.source || "dynamic";
	const resolvedModel = dynamicModel || predefinedAgent?.model;
	const resolvedTools = dynamicTools || predefinedAgent?.tools;

	// Build system prompt
	let systemPrompt = "";
	if (predefinedAgent?.systemPrompt) {
		systemPrompt = predefinedAgent.systemPrompt;
	}
	if (dynamicPrompt) {
		// Dynamic prompt overrides or augments the predefined agent prompt
		systemPrompt = dynamicPrompt + (systemPrompt ? `\n\n---\n\n${systemPrompt}` : "");
	}

	// Add inherited context if requested
	if (inheritContext && sessionManager) {
		const inherited = buildInheritedContext(sessionManager);
		if (inherited) {
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${inherited}` : inherited;
		}
	}

	// Add output format instructions
	const formatInstructions = buildOutputFormatInstructions(outputFormat);
	const fullTask = formatInstructions ? `${task}${formatInstructions}` : task;

	if (!systemPrompt && !isDynamic) {
		// Should not happen, but handle gracefully
		systemPrompt = "You are a helpful assistant.";
	}

	if (isDynamic && !dynamicPrompt) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName || "dynamic",
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName || ""}" and no dynamic prompt provided. Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (resolvedModel) args.push("--model", resolvedModel);
	if (resolvedTools && resolvedTools.length > 0) args.push("--tools", resolvedTools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: resolvedName,
		agentSource: resolvedSource,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(resolvedName, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${fullTask}`);
		let wasAborted = false;
		let maxTurnsReached = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;

						// Enforce max turns
						if (maxTurns && currentResult.usage.turns >= maxTurns) {
							maxTurnsReached = true;
							proc.kill("SIGTERM");
							return;
						}

						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.maxTurnsReached = maxTurnsReached;
		if (wasAborted) throw new Error("Subagent was aborted");
		if (maxTurnsReached) throw new Error(`Subagent reached maxTurns limit (${maxTurns})`);
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of a predefined agent to invoke. Omit to use a dynamic agent with `prompt`." })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	prompt: Type.Optional(
		Type.String({
			description:
				"Custom system prompt for this subagent. Use to create focused dynamic agents without predefined .md files. If `agent` is also specified, this is prepended to the agent's system prompt.",
		}),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Override tool allowlist for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task (e.g., claude-haiku-4-5)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	maxTurns: Type.Optional(Type.Number({ description: "Maximum assistant turns before force termination", minimum: 1 })),
	inheritContext: Type.Optional(
		Type.Boolean({
			description: "Forward recent parent session messages as context. Default: false.",
			default: false,
		}),
	),
	outputFormat: Type.Optional(
		Type.String({
			description: "Guide subagent output format: 'json', 'markdown', or custom instructions",
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of a predefined agent to invoke. Omit to use a dynamic agent with `prompt`." })),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	prompt: Type.Optional(
		Type.String({
			description:
				"Custom system prompt for this subagent. Use to create focused dynamic agents. If `agent` is also specified, this is prepended to the agent's system prompt.",
		}),
	),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Override tool allowlist for this step" })),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	maxTurns: Type.Optional(Type.Number({ description: "Maximum assistant turns before force termination", minimum: 1 })),
	inheritContext: Type.Optional(
		Type.Boolean({
			description: "Forward recent parent session messages as context. Default: false.",
			default: false,
		}),
	),
	outputFormat: Type.Optional(
		Type.String({
			description: "Guide subagent output format: 'json', 'markdown', or custom instructions",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

function buildToolDescription(agents: AgentConfig[]): string {
	const agentList = formatAgentList(agents, 12);
	let desc = [
		"Delegate tasks to specialized subagents with isolated context windows.",
		"",
		"Use this tool when:",
		"- A task involves searching, reading, or exploring many files (prevents context pollution)",
		"- Multiple independent subtasks can run in parallel (e.g., review + test + docs)",
		"- A subtask requires a specialized role or different model (e.g., fast scout, thorough reviewer)",
		"- The main task is complex enough to benefit from sequential phases with handoffs (chain mode)",
		"- You want to isolate risky or experimental work from the main conversation",
		"",
		"Do NOT use this tool when:",
		"- The task is a simple single-step edit, read, or bash command",
		"- You already have all necessary context and the change is straightforward",
		"- The task requires tight iterative feedback with the user",
		"",
		"Modes:",
		"- single: one agent, one task. Use for focused delegation.",
		"- parallel: array of tasks run concurrently (max 8 tasks, 4 concurrent). Use for independent subtasks.",
		"- chain: sequential tasks where output flows via {previous} placeholder. Use for phased workflows.",
		"",
		"Dynamic agents:",
		"Set `prompt` (without `agent`) to spawn a custom subagent on the fly with its own system prompt.",
		"This is ideal for one-off specialists that don't need a predefined .md file.",
		"",
		"Available predefined agents:",
		agentList.text,
	];
	if (agentList.remaining > 0) {
		desc.push(`... and ${agentList.remaining} more`);
	}
	desc.push("");
	desc.push('Default agent scope is "user" (from ~/.pi/agent/agents). Set agentScope: "both" to include project-local agents in .pi/agents/.');
	return desc.join("\n");
}

function buildPromptGuidelines(): string[] {
	return [
		"Use the subagent tool proactively when a task would require extensive file exploration, searching, or iterative debugging.",
		"For parallel mode, ensure tasks are truly independent and specify non-overlapping file scopes.",
		"For chain mode, use {previous} to pass output between steps. Keep each step focused and verifiable.",
		"When delegating, write specific, bounded tasks with clear expected outputs. Vague tasks produce vague results.",
		"Use `prompt` to create dynamic agents for one-off roles (e.g., 'You are a security auditor...').",
		"Use `inheritContext: true` when the subagent needs awareness of recent main-session discussion.",
		"Use `maxTurns` to prevent runaway subagents on open-ended tasks (suggested: 5-10 for research, 15-20 for implementation).",
		"Use `outputFormat: 'json'` when you need structured data back from the subagent.",
		"Route expensive work to cheaper models via `model` (e.g., claude-haiku-4-5 for searches, sonnet for implementation).",
		"When a subagent fails, decide whether to retry, adapt the plan, or handle the task directly.",
	];
}

export default function (pi: ExtensionAPI) {
	// Discover agents at load time for the tool description
	// Note: cwd may change, but this gives the model a useful static catalog
	const staticAgents = discoverAgents(process.cwd(), "both").agents;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildToolDescription(staticAgents),
		promptSnippet:
			"Delegate work to isolated subagents: single, parallel, or chain mode. Supports dynamic agents with custom prompts.",
		promptGuidelines: buildPromptGuidelines(),
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Predefined agent name (for single mode)" })),
			task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
			prompt: Type.Optional(
				Type.String({
					description:
						"Custom system prompt for single-mode dynamic agent. If `agent` is also set, prepended to the agent's prompt.",
				}),
			),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Override tool allowlist for single mode" })),
			model: Type.Optional(Type.String({ description: "Override model for single mode" })),
			maxTurns: Type.Optional(Type.Number({ description: "Max assistant turns for single mode", minimum: 1 })),
			inheritContext: Type.Optional(Type.Boolean({ default: false })),
			outputFormat: Type.Optional(Type.String()),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
			chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain steps" })),
			agentScope: Type.Optional(AgentScopeSchema),
			confirmProjectAgents: Type.Optional(
				Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for single mode" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task) && (Boolean(params.agent) || Boolean(params.prompt));
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) if (t.agent) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
						  }
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
						prompt: step.prompt,
						tools: step.tools,
						model: step.model,
						maxTurns: step.maxTurns,
						inheritContext: step.inheritContext,
						outputFormat: step.outputFormat,
						sessionManager: ctx.sessionManager,
					});
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.maxTurnsReached;
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						const reason = result.maxTurnsReached ? `maxTurns (${step.maxTurns}) reached` : errorMsg;
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${i + 1} (${result.agent}): ${reason}` },
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);

				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent || "dynamic",
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						signal,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
						prompt: t.prompt,
						tools: t.tools,
						model: t.model,
						maxTurns: t.maxTurns,
						inheritContext: t.inheritContext,
						outputFormat: t.outputFormat,
						sessionManager: ctx.sessionManager,
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0 && !r.maxTurnsReached).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					const status = r.maxTurnsReached ? "max turns" : r.exitCode === 0 ? "completed" : "failed";
					return `[${r.agent}] ${status}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (hasSingle) {
				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task!,
					cwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					prompt: params.prompt,
					tools: params.tools,
					model: params.model,
					maxTurns: params.maxTurns,
					inheritContext: params.inheritContext,
					outputFormat: params.outputFormat,
					sessionManager: ctx.sessionManager,
				});
				const isError =
					result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.maxTurnsReached;
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					const reason = result.maxTurnsReached ? `maxTurns (${params.maxTurns}) reached` : errorMsg;
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${reason}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					const agentLabel = step.agent || (step.prompt ? "dynamic" : "...");
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", agentLabel) +
						theme.fg("dim", ` ${preview}`);
					if (step.maxTurns) text += theme.fg("warning", ` (max ${step.maxTurns} turns)`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const agentLabel = t.agent || (t.prompt ? "dynamic" : "...");
					text += `\n  ${theme.fg("accent", agentLabel)}${theme.fg("dim", ` ${preview}`)}`;
					if (t.maxTurns) text += theme.fg("warning", ` (max ${t.maxTurns})`);
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || (args.prompt ? "dynamic" : "...");
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (args.maxTurns) text += theme.fg("warning", ` (max ${args.maxTurns} turns)`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.maxTurnsReached;
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (r.maxTurnsReached) header += ` ${theme.fg("error", "[maxTurns]")}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.maxTurnsReached) text += ` ${theme.fg("error", "[maxTurns]")}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0 && !r.maxTurnsReached).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 && !r.maxTurnsReached ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.maxTurnsReached)
							container.addChild(new Text(theme.fg("error", "[maxTurns reached]"), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 && !r.maxTurnsReached ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.maxTurnsReached) text += ` ${theme.fg("error", "[maxTurns]")}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0 && !r.maxTurnsReached).length;
				const failCount = details.results.filter((r) => r.exitCode > 0 || r.maxTurnsReached).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", "⏳")
								: r.exitCode === 0 && !r.maxTurnsReached
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.maxTurnsReached)
							container.addChild(new Text(theme.fg("error", "[maxTurns reached]"), 0, 0));

						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0 && !r.maxTurnsReached
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (r.maxTurnsReached) text += ` ${theme.fg("error", "[maxTurns]")}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
