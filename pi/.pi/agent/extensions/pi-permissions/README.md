# pi-permissions

A simple permission system for the Pi coding agent. This is a from-scratch implementation inspired by [pi-permission-system](https://github.com/MasuRii/pi-permission-system).

## Features

- **Tool permissions** - Allow/deny/ask for specific tools by name
- **Bash command control** - Wildcard pattern matching for bash commands
- **Skill permissions** - Control which skills can be loaded
- **Runtime prompting** - Ask user for confirmation via UI when permission is set to `ask`
- **System prompt integration** - Filters active tools before agent starts

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

## Permission States

| State | Behavior |
|-------|----------|
| `allow` | Permits the action silently |
| `deny` | Blocks the action with an error message |
| `ask` | Prompts user for confirmation (if UI available) |

## Usage

### Commands

- `/perms` - Show current permission policy

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

## How It Works

1. **Before agent starts** - Loads policy, filters active tools based on permissions
2. **Tool call interception** - Checks each tool call against policy
3. **Input interception** - Intercepts `/skill:` commands before they execute
4. **Permission enforcement** - Blocks, allows, or prompts based on policy

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
