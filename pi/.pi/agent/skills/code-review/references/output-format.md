# Code Review Output Format

## No Issues Found

```markdown
### Code Review

No issues found. Checked for bugs, security vulnerabilities, and CLAUDE.md compliance.
```

## Issues Found

```markdown
### Code Review

Found [N] issue(s):

1. [Brief description] (critical/warning/suggestion, confidence: XX%)
   [Category: CLAUDE.md convention / Bug type / Security issue]

   [Full GitHub link with SHA#Lstart-Lend]

   [One-line recommendation if non-obvious]

2. [Next issue...]
```

## Issue Categories

- **CLAUDE.md convention**: Violation of explicitly stated project rules
- **Bug**: Logic error, null access, race condition, edge case not handled
- **Security**: OWASP Top 10, hardcoded secrets, injection vulnerabilities
- **Comment compliance**: Code doesn't follow TODO/FIXME/DEPRECATED guidance

## Link Format

Always use full SHA, never short SHA or `HEAD`:

```
https://github.com/owner/repo/blob/abcdef1234567890abcdef1234567890abcdef12/path/to/file.js#L10-L20
```

For GitLab MRs:

```
https://gitlab.com/owner/repo/-/blob/abcdef1234567890abcdef1234567890abcdef12/path/to/file.js#L10-L20
```

## Professional Mode Rules

- No emojis (✅, ❌, 🐛, etc.)
- No decorative formatting (tables, boxes)
- Concise descriptions (max 1-2 sentences)
- Direct, actionable language
