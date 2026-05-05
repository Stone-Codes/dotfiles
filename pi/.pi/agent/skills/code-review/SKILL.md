---
name: code-review
description: >
  Performs structured code reviews with severity classification
  (critical/warning/suggestion), security scanning, and multi-agent
  parallel analysis. Checks for bugs, security vulnerabilities (OWASP
  Top 10), style violations, and project convention adherence. Use
  when reviewing code, pull requests, or merge requests.
---


# Code Review Skill

Performs comprehensive code reviews using parallel sub-agents, severity classification, and confidence scoring to filter false positives.

## Quick Reference

- **Severity levels**: critical (blocks merge), warning (should fix), suggestion (optional improvement)
- **Confidence threshold**: Only report issues scored ≥75 (see Step 6)
- **Output format**: See [references/output-format.md](references/output-format.md)

## Workflow

### Step 1: Eligibility Check

Use a fast agent (Haiku) to check if the target is:
- An open (not closed/draft) PR/MR
- Not automated or trivially simple
- Not previously reviewed by you

If ineligible, stop and report reason.

### Step 2: Gather Context

Launch a Haiku agent to collect:
1. List of `CLAUDE.md` / `AGENTS.md` / `.coding-agent/` files in the repo (root + modified directories)
2. PR/MR summary (title, description, changed files)
3. Language(s) and framework(s) detected from file extensions and dependency files

### Step 3: Parallel Review Agents

Launch **5 parallel Sonnet agents** for independent review. Each agent returns a list of issues with descriptions.

**Agent 1 - Convention Compliance**
- Read gathered `CLAUDE.md` / project convention files
- Check code against explicit rules in those files
- Focus on: naming conventions, file structure, required patterns, forbidden practices
- Note: Only flag violations explicitly called out in convention files

**Agent 2 - Bug Detection**
- Read PR diff (not full files)
- Scan for obvious bugs: null/undefined access, off-by-one errors, race conditions, unhandled edge cases
- Ignore style issues, focus on logic errors that would cause runtime failures
- Avoid nitpicks; flag only likely-impact issues

**Agent 3 - Historical Context**
- Run `git blame` on modified lines
- Check commit history for the files changed
- Identify if modified code was recently added/modified (higher bug likelihood)
- Note any previous bug fixes in the same area

**Agent 4 - Security Scan**
- Check for OWASP Top 10 issues: SQL injection, XSS, SSRF, command injection, insecure deserialization
- Scan for hardcoded secrets, API keys, tokens (see [references/secret-patterns.md](references/secret-patterns.md))
- Verify authentication/authorization patterns
- Framework-specific checks: see [references/review-checklist.md](references/review-checklist.md)

**Agent 5 - Comment Compliance**
- Read code comments in modified files (TODO, FIXME, DEPRECATED, etc.)
- Verify PR changes comply with guidance in those comments
- Check if PR fulfills stated requirements in issue tracker (if linked)

### Step 4: Merge & Deduplicate

Combine all issues from Steps 3-5. Deduplicate by:
- Same file + line range + similar issue → keep highest severity
- Agent 4 (security) issues → always preserve separately

### Step 5: Confidence Scoring

For each issue, launch a **Haiku agent** to score confidence 0-100:

| Score | Meaning |
|-------|---------|
| 0 | False positive, pre-existing issue, or doesn't withstand scrutiny |
| 25 | Somewhat confident, might be real, but likely false positive or unverifiable |
| 50 | Moderately confident, verified real issue but nitpick or low-impact |
| 75 | Highly confident, verified issue that will impact functionality, important |
| 100 | Absolutely certain, confirmed bug/vulnerability that will occur frequently |

**Scoring rubric** (provide verbatim to agent):
- Is the issue on a line the PR actually modified? (If no → cap at 25)
- Is it a linter/typechecker issue? (If yes → 0, CI catches these)
- Is it explicitly required by `CLAUDE.md`? (If yes → +25)
- Did agent verify by reading surrounding context? (If yes → +25)
- Is it a security vulnerability? (If yes → +25, min 75)
- Is it a likely runtime bug? (If yes → +25, min 75)

### Step 6: Filter & Prioritize

- **Discard** issues with score < 75
- **Sort** remaining by: score (desc) → severity (critical > warning > suggestion)
- **Limit** to top 10 issues (or all critical if >10 total)

### Step 7: Re-verify Eligibility

Repeat Step 1 check. If PR is now closed/draft, stop without commenting.

### Step 8: Generate Report

Format output per [references/output-format.md](references/output-format.md).

**Key rules:**
- Keep output brief, no emojis in professional mode
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

### Step 9: Post Comment (if PR/MR)

If reviewing a GitHub PR, use `gh pr comment <number> --body-file <file>` to post the review.
If reviewing local code (no PR), output the report directly to the user.

## False Positive Exclusion List

Never flag these as issues:
- Pre-existing bugs on lines NOT modified by the PR
- Linter/typechecker/can trivially catch (assume CI runs these)
- Style issues not explicitly in `CLAUDE.md`
- Missing test coverage (unless `CLAUDE.md` requires it)
- General code quality improvements without specific bugs
- Issues silenced by lint-ignore comments in the code

## Global Constraints

- Never run `npm install`, `pip install`, or build steps — assume CI handles this
- Never modify code — only report issues
- Always use `gh` CLI for GitHub interactions, never web fetch
- If uncertain about an issue, score it lower (bias toward false negative, not false positive)
- Respect the user's time: concise reports, maximum 10 issues shown

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
