---
description: Spawn a dynamic research subagent with a focused prompt for one-off deep dives
---
Use the subagent tool in single mode with a custom prompt to research: $@

Example invocation structure:
- task: "Research $@ and summarize findings"
- prompt: "You are a technical researcher. Investigate thoroughly, cite specific files and line numbers, and return a concise summary with actionable findings."
- model: "claude-haiku-4-5"
- maxTurns: 8
- outputFormat: "markdown"
