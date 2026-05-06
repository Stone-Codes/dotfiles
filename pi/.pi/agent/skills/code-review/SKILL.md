---
name: code-review
description: >
  Performs focused code reviews with severity classification
  (critical/warning/suggestion) and security scanning. Checks for
  bugs, security vulnerabilities, and project convention adherence.
  Fast: 3 parallel agents max, no per-issue rescoring.
  Use when reviewing code, pull requests, or merge requests.
---

# Code Review Skill

Performs focused code reviews using parallel sub-agents with inline confidence scoring. Designed to complete in minutes, not forever.

## Quick Reference

- **Severity levels**: critical (blocks merge), warning (should fix), suggestion (optional improvement)
- **Confidence threshold**: Only report issues scored ≥75
- **Max issues reported**: 8
- **Output format**: See [references/output-format.md](references/output-format.md)

## Workflow

### Step 1: Fast Eligibility & Context

Launch **one agent** to:
1. Check the target is an open (not closed/draft) PR/MR; if not, stop and report reason.
2. Collect PR/MR summary (title, description, changed files, diff).
3. Find and read any `CLAUDE.md` / `AGENTS.md` / `.coding-agent/` files in the repo (root + modified directories).
4. Detect language(s) and framework(s) from file extensions and dependency files.
5. Return a concise context package (≤200 lines).

**Skip this review if:**
- PR is closed, draft, or previously reviewed by you
- PR is purely automated (lockfile updates, generated code, formatting only)
- Changed files >50 (too large to review meaningfully in this mode)

### Step 2: Parallel Review Agents

Launch **3 parallel agents**. Each agent reads the context package from Step 1, reviews the PR diff, and returns **at most 5 issues** with inline confidence scores (0-100).

**Instructions for all agents:**
- Only flag issues on lines the PR actually modified
- Do not flag linter/typechecker issues (assume CI catches these)
- Do not flag style issues unless explicitly prohibited by `CLAUDE.md`
- Do not flag pre-existing bugs on unmodified lines
- Score each issue yourself using the rubric below
- Return findings in this format per issue:
  ```
  - file: path/to/file.ts
    lines: L12-L15
    severity: critical|warning|suggestion
    confidence: 0-100
    category: convention|bug|security
    description: One-sentence description
    context: 1-2 lines of code context
    recommendation: One-sentence fix (if non-obvious)
  ```

**Confidence rubric** (score yourself):
- Is the issue on a modified line? (If no: cap at 25)
- Is it a linter/typechecker issue? (If yes: 0)
- Is it explicitly required by `CLAUDE.md`? (If yes: +25)
- Did you verify by reading surrounding context? (If yes: +25)
- Is it a security vulnerability? (If yes: +25, minimum 75)
- Is it a likely runtime bug? (If yes: +25, minimum 75)

**Agent 1 — Convention Compliance**
- Check code against explicit rules in `CLAUDE.md` / project convention files
- Focus on: naming conventions, file structure, required patterns, forbidden practices
- Only flag violations explicitly called out in convention files

**Agent 2 — Bug Detection**
- Scan modified code for logic bugs: null/undefined access, off-by-one errors, race conditions, unhandled edge cases, incorrect error handling
- Ignore style; flag only likely-impact runtime issues

**Agent 3 — Security Scan**
- Check for OWASP Top 10: injection, XSS, SSRF, command injection, insecure deserialization, auth/authz flaws
- Scan for hardcoded secrets, API keys, tokens (see [references/secret-patterns.md](references/secret-patterns.md))
- Framework-specific checks: see [references/review-checklist.md](references/review-checklist.md)

### Step 3: Merge, Deduplicate, Filter

Combine issues from all 3 agents. Deduplicate by:
- Same file + line + similar description → keep highest severity and confidence

Then filter:
- **Discard** issues with confidence < 75
- **Discard** issues not on modified lines
- **Sort** by: confidence (desc) → severity (critical > warning > suggestion)
- **Hard limit**: Keep top 8 issues maximum (or all critical if they exceed 8)

### Step 4: Generate Report

Format output per [references/output-format.md](references/output-format.md).

**Key rules:**
- Keep output brief; no emojis in professional mode
- Link each issue: `https://github.com/owner/repo/blob/<full-sha>/path/file#Lstart-Lend`
- Must use full git SHA (not `HEAD` or short SHA)
- Provide 1-2 lines of context before/after the target line
- Include confidence score in parentheses after severity

**If no issues found:**
```
### Code Review

No issues found. Checked for bugs, security vulnerabilities, and CLAUDE.md compliance.
```

**If issues found:**
```
### Code Review

Found [N] issue(s):

1. [Brief description] (critical/warning/suggestion, confidence: XX%)
   [CLAUDE.md convention / bug type / security issue]

   [Full GitHub link with SHA#Lstart-Lend]

   [One-line recommendation if non-obvious]
```

### Step 5: Post Comment (if PR/MR)

If reviewing a GitHub PR, use `gh pr comment <number> --body-file <file>` to post the review.
If reviewing local code (no PR), output the report directly to the user.

## False Positive Exclusion List

Never flag these as issues:
- Pre-existing bugs on lines NOT modified by the PR
- Linter/typechecker issues (assume CI runs these)
- Style issues not explicitly in `CLAUDE.md`
- Missing test coverage (unless `CLAUDE.md` requires it)
- General code quality improvements without specific bugs
- Issues silenced by lint-ignore comments in the code
- Dependency lockfile changes
- Generated code changes (unless the generator itself is in the PR)

## Global Constraints

- Never run `npm install`, `pip install`, or build steps — assume CI handles this
- Never modify code — only report issues
- Always use `gh` CLI for GitHub interactions, never web fetch
- If uncertain about an issue, score it lower (bias toward false negative, not false positive)
- Respect the user's time: concise reports, maximum 8 issues shown
- If changed files >50, skip with message "PR too large for focused review"

## Human Checkpoint

Ask the user only if:
- PR is locked or archived
- Unable to determine repository structure after 2 attempts
- `CLAUDE.md` has conflicting rules and you cannot determine priority

Otherwise, proceed autonomously.

## References

- [Severity levels and examples](references/severity-levels.md)
- [Review checklist by language/framework](references/review-checklist.md)
- [Secret detection patterns](references/secret-patterns.md)
- [Output format template](references/output-format.md)
