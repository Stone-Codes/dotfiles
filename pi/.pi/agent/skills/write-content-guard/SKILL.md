---
name: write-content-guard
description: Validates that the content parameter of the write tool is always a string before invocation. Use whenever calling the write tool to create or overwrite files, especially when constructing content programmatically or from tool results.
---

# Write Content Guard

## Rule

Before every `write` tool invocation, the `content` parameter **must** be a string.

## Forbidden

- Passing an object: `content: someObject` → produces `[object Object]`
- Passing an array: `content: someArray` → produces comma-joined or garbage output
- Passing a number, boolean, null, or undefined
- Passing a tool result wrapper without extracting the text field

## Required

1. **If building content in pieces**, join to a string before writing:
   ```javascript
   const content = sections.join("\n\n");
   write({ path: "file.md", content });
   ```

2. **If content came from a tool result** (e.g., `create_plan`, `web_search`, `subagent`), extract the actual text/markdown string:
   ```javascript
   // CORRECT — extract the text field
   write({ path: "Plan.md", content: planResult.text });

   // WRONG — passing the wrapper object
   write({ path: "Plan.md", content: planResult });
   ```

3. **If unsure**, explicitly coerce:
   ```javascript
   write({ path: "file.md", content: String(content) });
   ```

## Verification Step

Before the final `write` call, mentally check: "If I ran `typeof content`, would it return `'string'`?"

If the answer is no, fix it before writing.
