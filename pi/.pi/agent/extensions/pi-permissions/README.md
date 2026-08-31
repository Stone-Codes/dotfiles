# pi-permissions

A simple permission system for the Pi coding agent. This is a from-scratch implementation inspired by [pi-permission-system](https://github.com/MasuRii/pi-permission-system).

## Features

- **Tool permissions** - Allow/deny/ask for specific tools by name
- **Bash command control** - Wildcard pattern matching for bash commands
- **Skill permissions** - Control which skills can be loaded
- **Runtime prompting** - Ask user for confirmation via UI when permission is set to `ask`
- **System prompt integration** - Filters active tools before agent starts
- **Session permission modes** - Manual, Auto, and Allow-all

## Installation

Place this directory in one of these locations:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-permissions` |
| Project | `.pi/extensions/pi-permissions` |

Or use it directly:
```bash
pi -e /path/to/pi-permissions/index.ts
```

## Configuration

Create a policy file at `~/.pi/agent/pi-permissions.jsonc`:

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "skills": "ask"
  },
  "tools": {
    "read": "allow",
    "write": "deny",
    "bash": "ask"
  },
  "bash": {
    "git status": "allow",
    "git *": "ask",
    "rm -rf *": "deny"
  },
  "skills": {
    "*": "ask"
  }
}
```

The optional `auto` policy configures Auto mode's classifier and rules. The complete
example is in [`pi-permissions.example.jsonc`](./pi-permissions.example.jsonc):

```jsonc
"auto": {
  "classifierModel": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-5"
  },
  "hardDeny": [
    "Never read or write credentials, private keys, or secret files.",
    "Never perform irreversible production deletion."
  ],
  "softDeny": [
    "Do not communicate externally unless the user explicitly requests it."
  ],
  "allow": [
    "Allow the repository's declared test and formatter commands."
  ],
  "environment": [
    "The current working repository and its configured remotes are trusted."
  ]
}
```

Permission mode is **session-only**: every new Pi session starts in Manual, and
selecting Auto or Allow-all is never persisted. `/auto-model` may persist only the
classifier model override under `auto.classifierModel`.

## Permission Modes

| Mode | Behavior |
|------|----------|
| **Manual** | Uses the configured `allow`, `deny`, and `ask` policy states. This is the default mode for each session. |
| **Auto** | Applies deterministic hard-deny and safe-allow rules, then sends remaining calls to the configured classifier. Read/search operations and safe read-only shell commands do not invoke the classifier. |
| **Allow-all** | Bypasses all tool permission checks for the current session, matching the existing tool full-bypass behavior. Skill-loading permission checks remain separate and are not bypassed. Use it deliberately; the extension displays a warning when it is enabled. |

Auto classifier input contains recent user context, the working directory, and the
tool call, but excludes raw tool results. Sensitive values are redacted. Hard-denied
paths and commands are blocked without classifier approval. A classifier block is
returned to the agent so it can attempt a safer alternative. If classification
fails, interactive sessions fall back to Manual confirmation; headless sessions
block the action.

Auto disables and returns to Manual after **three consecutive** classifier denials
or **twenty total** classifier denials in the session. An allowed call resets only
the consecutive streak.

## Permission States

| State | Behavior |
|-------|----------|
| `allow` | Permits the action silently |
| `deny` | Blocks the action with an error message |
| `ask` | Prompts user for confirmation (if UI available) |

## Usage

### Commands

- `/perms` - Show the current mode, policy path, and policy entries.
- `/perms mode manual` - Start Manual mode for this session.
- `/perms mode auto` - Start Auto mode for this session.
- `/perms mode allow-all` - Start Allow-all mode for this session (shows a warning).
- `/auto` - Report whether Auto mode is on or off.
- `/auto on` / `/auto off` - Enable or disable Auto mode.
- `/auto-model` - Select an authenticated classifier model interactively.
- `/auto-model default` - Use the active session model and remove the persisted override.
- `/auto-model provider/model` - Persist a specific authenticated classifier model.
- `/perms-allow-all` - Toggle the session-wide Allow-all bypass.

`/auto-model` selects from authenticated models and writes only the classifier model
override to the global policy. It does not persist the active permission mode.

### Examples

**Read-only mode:**
```jsonc
{
  "defaultPolicy": { "tools": "deny", "bash": "deny", "skills": "deny" },
  "tools": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow"
  }
}
```

**Restricted bash:**
```jsonc
{
  "defaultPolicy": { "tools": "ask", "bash": "deny", "skills": "ask" },
  "bash": {
    "git status": "allow",
    "git diff": "allow",
    "npm *": "ask"
  }
}
```

## Safety and How It Works

The global policy is loaded from `~/.pi/agent/pi-permissions.jsonc`. The global
extension is discovered from `~/.pi/agent/extensions/pi-permissions` (or it can be
loaded directly with `pi -e /path/to/pi-permissions/index.ts`).

1. **Before agent starts** - Loads policy, filters active tools based on the current mode
2. **Tool call interception** - Checks each tool call against Manual policy or the Auto gate
3. **Input interception** - Intercepts `/skill:` commands before they execute
4. **Permission enforcement** - Blocks, allows, classifies, or prompts based on policy and mode

## Architecture

```
index.ts                    → Main extension entry point
src/
├── types.ts                → TypeScript type definitions
├── permission-manager.ts   → Policy loading and permission checking
└── wildcard-matcher.ts    → Wildcard pattern matching (*)
```

## Differences from pi-permission-system

This is a simplified implementation that focuses on core features:

| Feature | pi-permission-system | pi-permissions |
|---------|---------------------|----------------|
| Tool permissions | ✅ | ✅ |
| Bash patterns | ✅ | ✅ |
| Skill permissions | ✅ | ✅ |
| MCP permissions | ✅ | ❌ |
| Subagent forwarding | ✅ | ❌ |
| Audit logging | ✅ | ❌ |
| Per-agent overrides | ✅ | ❌ |
| External directory guard | ✅ | ❌ |
| Project-level policy | ✅ | ❌ |

## License

MIT
