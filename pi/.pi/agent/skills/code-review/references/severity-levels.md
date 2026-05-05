# Severity Levels

## Critical

**Definition**: Issue that must be resolved before merge. Will cause runtime errors, security vulnerabilities, or data loss.

**Examples**:
- SQL injection vulnerability
- Null pointer dereference on common path
- Authentication bypass
- Data race in concurrent code
- Breaking API change without migration

**Action**: Block merge, must fix immediately.

## Warning

**Definition**: Issue that should be addressed but doesn't immediately break functionality. May cause bugs in edge cases or technical debt.

**Examples**:
- Missing error handling on uncommon path
- Deprecated API usage
- Race condition in rare scenario
- Violation of project convention in CLAUDE.md
- Hardcoded config value that should be environment variable

**Action**: Should fix before merge, but team can decide.

## Suggestion

**Definition**: Optional improvement that enhances code quality, readability, or maintainability. No immediate bug or security risk.

**Examples**:
- Code duplication that could be extracted
- Unclear variable name (not in CLAUDE.md)
- Missing comments on complex logic
- Performance micro-optimization
- Architectural suggestion

**Action**: Optional, nice to have.

## Severity Selection Guide

| Scenario | Severity |
|----------|----------|
| Will crash in production | Critical |
| Security vulnerability | Critical |
| Violates explicit CLAUDE.md rule | Warning |
| Likely bug in edge case | Warning |
| Code smell, no immediate impact | Suggestion |
| Style issue not in CLAUDE.md | Do not flag |
| Linter can catch it | Do not flag |
