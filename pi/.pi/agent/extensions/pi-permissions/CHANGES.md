# pi-permissions Implementation Summary

## Added Features

### 1. Logging System (`src/logging.ts`)
- **File-based logging** to `~/.pi/agent/extensions/pi-permissions/logs/permission-review.jsonl`
- Each permission check is logged with timestamp, target, state, source, and matched pattern
- Log entries include tool calls, bash commands, MCP targets, and skill loads

### 2. MCP Support
**In `src/permission-manager.ts`:**
- Added `checkMcpPermission()` function with wildcard pattern matching
- Added `deriveMcpTarget()` helper to extract MCP target from tool input
- Supports formats: `server:tool`, `server_tool`, `mcp_call`, `mcp_status`, etc.
- Integrated logging for all MCP permission checks

**In `index.ts`:**
- Added MCP permission checking in `tool_call` handler
- Shows MCP target in confirmation dialogs
- Returns appropriate block reasons for denied MCP calls

**In `types.ts`:**
- Added `mcp` to `defaultPolicy`
- Added `PermissionLogEntry` interface with `mcpTarget` field

### 3. Auto-Allow Read-Only Bash Commands
**New function `isReadOnlyBashCommand()`:**
- Automatically allows safe read-only commands without prompting
- Whitelisted commands: `ls`, `cat`, `head`, `tail`, `grep`, `find`, `file`, `stat`, `wc`, `diff`, `git status`, `git log`, `git diff`, `git show`, `git branch`, `git remote`, `pwd`, `echo`, `which`, `type`, `test`, `[`
- Security checks: blocks commands with output redirects (`>`, `>>`), input redirects (`<`), pipes to write commands, `rm`, `sudo`, `su`, directory traversal (`../`), and absolute paths
- Only applies when policy is set to `ask` (doesn't override `deny`)

### 4. New Commands
- `/perms-log [N]` - View last N entries (default 10) from the permission log
- Enhanced `/perms` command to show MCP permissions and log file location

## File Changes

| File | Changes |
|------|---------|
| `types.ts` | Added `mcp` to policy, added `PermissionLogEntry` interface |
| `src/logging.ts` | **New file** - JSONL logging system |
| `src/permission-manager.ts` | Added MCP functions, integrated logging into all check functions |
| `index.ts` | Added MCP handling, read-only bash auto-allow, `/perms-log` command |
| `pi-permissions.example.jsonc` | Added MCP section to example policy |

## Usage Example

```jsonc
{
  "defaultPolicy": {
    "tools": "ask",
    "bash": "ask",
    "mcp": "ask",
    "skills": "ask"
  },
  "mcp": {
    "mcp_status": "allow",
    "mcp_list": "allow",
    "myServer:*": "ask",
    "dangerousServer": "deny"
  }
}
```

## Testing

```bash
# Install the extension
cp -r /Users/adminfd/Dev/private/pi-permissions ~/.pi/agent/extensions/

# Create policy file
cp pi-permissions.example.jsonc ~/.pi/agent/pi-permissions.jsonc

# Start Pi with auto-discovery
pi

# Or test directly
cd /Users/adminfd/Dev/private/pi-permissions
pi -e ./index.ts
```

## Log Format

Each line in the log file is a JSON object:
```json
{"timestamp":1234567890,"command":"ls -la","state":"allow","source":"bash","matchedPattern":"ls *"}
{"timestamp":1234567891,"mcpTarget":"myServer:search","state":"ask","source":"mcp","matchedPattern":"myServer:*"}
```
