# Advanced Plan Mode Extension

Enhanced plan mode with sub-agents, markdown files, and interactive approval.

## Features

- **Sub-agent architecture**: Scout (gather context) + Planner (create plan)
- **Markdown plan file**: Plans saved to `PLAN.md` with checkbox format
- **Interactive approval**: Approve steps before execution
- **Progress tracking**: TUI widget shows completion status
- **Sub-agent tools**: `scout`, `create_plan`, `approve_step`, `complete_step`
- **Session persistence**: State survives restart/resume

## Commands

- `/plan` - Toggle plan mode
- `/plan-view` - View current plan from PLAN.md
- `/plan-execute` - Start executing with approval workflow
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Plan File Format (PLAN.md)

```markdown
# Plan

**Goal:** Refactor authentication module

## Steps

- [ ] 1. Analyze current auth flow
- [~] 2. Create new AuthService class
- [x] 3. Update login endpoint

## Files to Modify

- src/auth/login.ts
- src/services/AuthService.ts

## Risks

- Breaking change for existing API clients
```

Checkbox states:
- `[ ]` - Not started
- `[~]` - Approved, in progress
- `[x]` - Completed

## Workflow

### Planning Phase
1. Enable plan mode (`/plan` or `Ctrl+Alt+P`)
2. Use `scout` tool or read/grep/find to gather context
3. Use `create_plan` tool to formalize the plan
4. Plan is saved to `PLAN.md` automatically

### Approval & Execution Phase
1. Run `/plan-execute` to start execution
2. Each step can be approved individually with `approve_step` tool
3. Mark steps complete with `complete_step` tool
4. Progress tracked in TUI widget

## Installation

```bash
# Extension is at ~/.pi/agent/extensions/plan-mode-advanced/
# Pi will auto-discover it on next startup
pi
```

## Differences from Basic Plan Mode

| Feature | Basic | Advanced |
|---------|-------|----------|
| Sub-agents | ❌ | ✅ scout + planner |
| Markdown file | ❌ | ✅ PLAN.md |
| Interactive approval | ❌ | ✅ approve_step |
| Checkbox format | ❌ | ✅ [ ], [~], [x] |
| Multiple tools | ❌ | ✅ 4 custom tools |
