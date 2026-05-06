# Refined Subagent Extension

An improved subagent delegation system for pi, based on the original pi example but refined with patterns from Claude Code, Codex, OpenHarness, and agentic coding research.

## What's Refined

### 1. Dynamic Agent Creation (The Big One)

The original extension only supported predefined agents in `.md` files. The refined extension lets the model spawn **focused subagents on the fly** with custom prompts:

```json
{
  "task": "Audit all API routes for auth vulnerabilities",
  "prompt": "You are a security auditor specializing in OAuth2 and JWT vulnerabilities. Check every route for missing auth, improper token validation, and injection risks. Return findings as JSON.",
  "tools": ["read", "grep", "find"],
  "model": "claude-haiku-4-5",
  "maxTurns": 8,
  "outputFormat": "json"
}
```

No need to create a `.md` file for one-off specialists. The parent model can craft the perfect subagent for the exact task at hand.

### 2. The Model Knows WHEN to Delegate

The original tool description was purely functional — it explained *how* to call the tool but not *when*. The refined version includes:

- **Agent catalog in the tool description**: The model sees all available agents with their descriptions right in its context, so it knows what specialists exist.
- **Explicit delegation guidelines**: `promptGuidelines` teach the model when to use subagents vs. handling tasks directly.
- **"Use proactively" descriptions**: Agent descriptions signal to the model that it should delegate certain types of work.

This is how Claude Code and Codex work — the model is guided to delegate appropriately, not just given a raw tool.

### 3. Context Inheritance (`inheritContext`)

Sometimes a subagent needs to know what the parent was just discussing. Set `inheritContext: true` to forward the last 6 messages from the parent session:

```json
{
  "agent": "worker",
  "task": "Implement the plan from above",
  "inheritContext": true
}
```

This is pi's equivalent of Claude Code's "fork" mode — the subagent gets background without the parent losing context to exploration.

### 4. Iteration Budgets (`maxTurns`)

Prevent runaway subagents on open-ended tasks:

```json
{
  "agent": "scout",
  "task": "Find all uses of the deprecated API",
  "maxTurns": 5
}
```

If the subagent exceeds its budget, it's killed and the parent receives a clear error. This is essential for reliable autonomous delegation.

### 5. Per-Task Overrides

Override model, tools, output format for individual tasks in parallel/chain mode:

```json
{
  "tasks": [
    { "agent": "scout", "task": "...", "model": "claude-haiku-4-5" },
    { "agent": "worker", "task": "...", "model": "claude-sonnet-4-5", "maxTurns": 15 }
  ]
}
```

Route expensive work to cheaper models. This is the "model routing" pattern that reduces costs by 50-60% in production multi-agent systems.

### 6. Structured Output Formats

Guide subagent output with `outputFormat`:

- `"json"` — appends instructions to return valid JSON
- `"markdown"` — asks for well-structured Markdown
- Custom string — included verbatim as format instructions

## Installation

### Project-local (recommended)

```bash
# From your project root
mkdir -p .pi/extensions
ln -s "$(pwd)/.pi/extensions/subagent" .pi/extensions/subagent

# Or just copy the files
```

### Global

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -s "$(pwd)/.pi/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -s "$(pwd)/.pi/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Agents
mkdir -p ~/.pi/agent/agents
for f in .pi/extensions/subagent/agents/*.md; do
  ln -s "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Prompts
mkdir -p ~/.pi/agent/prompts
for f in .pi/extensions/subagent/prompts/*.md; do
  ln -s "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Usage

### Single predefined agent
```
Use scout to find all authentication code
```

### Single dynamic agent
```
Spawn a subagent with prompt "You are a performance expert..." to analyze the bottlenecks in src/db/
```

### Parallel execution
```
Run 3 reviewers in parallel: one for security, one for performance, one for maintainability
```

### Chain workflow
```
Use a chain: scout finds the auth code, then worker implements the fix using {previous}
```

### Workflow prompts
```
/implement add Redis caching to the session store
/parallel-review the auth module
/dynamic-research how RxDB replication works
```

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does (be specific — the model uses this to decide when to delegate)
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Key rule for descriptions**: Write descriptions that explain WHEN to use the agent. The model reads these descriptions in the tool definition and uses them to decide delegation.

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `explorer` | Deep read-only research | Haiku | read, grep, find, ls |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `worker` | General-purpose implementation | Sonnet | (all default) |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `tester` | Test writing and execution | Sonnet | read, grep, find, ls, bash |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |
| `/parallel-review <query>` | 3 reviewers in parallel |
| `/dynamic-research <query>` | single dynamic agent with research prompt |

## How It Works (Architecture)

This extension follows the **orchestrator-workers** pattern found in Claude Code, Codex, and production agent systems:

1. The parent model (orchestrator) decides whether to delegate
2. If delegating, it crafts a specific task and optionally a custom prompt
3. The extension spawns a separate `pi --mode json -p` subprocess
4. The subagent works in isolation with its own context window
5. Only the final result returns to the parent — intermediate tool calls stay isolated
6. The parent synthesizes subagent results and continues

This preserves the parent's context window, enables parallelization, and allows model routing (cheaper models for simple tasks).

## Research Basis

These refinements are based on patterns from:

- **Claude Code Sub-Agents** (Anthropic, July 2025): Dynamic agent definitions, tool restrictions, model routing, context isolation
- **OpenAI Codex Subagents**: Parallel spawning, custom agent TOML files, max_threads/max_depth controls
- **OpenHarness Subagents**: Dynamic spawning, background agents, session persistence
- **Agent Patterns (aipatternbook.com)**: Contract-first decomposition, bounded subtasks, independent operation
- **DeepMind Delegation Framework** (Feb 2026): Verifiable contracts, scoped permissions, checkpoint-based recovery

## Security Model

Same as the original:

- Only loads **user-level agents** from `~/.pi/agent/agents` by default
- Set `agentScope: "both"` to include project-local agents from `.pi/agents/`
- Interactive confirmation before running project-local agents (disable with `confirmProjectAgents: false`)

## Limitations

- Agent catalog in tool description is discovered at extension load time; new agents require `/reload`
- `inheritContext` forwards up to 6 recent messages; very long sessions may need manual context passing
- `maxTurns` is enforced by counting assistant messages; tool execution time is not limited
- Parallel mode limited to 8 tasks, 4 concurrent
