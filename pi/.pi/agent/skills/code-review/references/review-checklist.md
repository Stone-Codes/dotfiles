# Review Checklist by Language/Framework

## JavaScript/TypeScript

### Security
- [ ] No `eval()`, `new Function()`, or dynamic code execution
- [ ] No hardcoded secrets (see secret-patterns.md)
- [ ] Input validation on user-provided data
- [ ] No XSS vectors (dangerous DOM manipulation)
- [ ] Proper error messages (no stack traces to users)

### Bugs
- [ ] Null/undefined checks before property access
- [ ] Promise error handling (.catch() or try/await)
- [ ] Event listener cleanup (no memory leaks)
- [ ] Race conditions in async code
- [ ] Proper dependency array in useEffect (React)

### Conventions
- [ ] Follows project's import style
- [ ] Error handling pattern matches codebase
- [ ] Naming conventions (camelCase, PascalCase per project)
- [ ] No console.log in production code (unless allowed)

## Python

### Security
- [ ] No `eval()`, `exec()`, or `pickle` on untrusted data
- [ ] SQL queries use parameterized statements
- [ ] No hardcoded secrets
- [ ] Proper file permissions when creating files
- [ ] Input validation on user data

### Bugs
- [ ] None-type checks before method calls
- [ ] Proper exception handling (specific exceptions, not bare `except:`)
- [ ] Resource cleanup (context managers, `with` statement)
- [ ] Off-by-one in loops/slices
- [ ] Mutable default arguments

### Conventions
- [ ] Follows PEP 8 or project style guide
- [ ] Type hints present (if project uses them)
- [ ] Docstrings for public functions
- [ ] Import order (stdlib, third-party, local)

## React

### Security
- [ ] No `dangerouslySetInnerHTML` with user data
- [ ] Key prop on list items
- [ ] No exposed internal state/props

### Bugs
- [ ] useEffect dependency array completeness
- [ ] State updates in loops/async (use functional setState)
- [ ] Memory leaks (subscriptions, timers cleaned up)
- [ ] Proper event handler binding (or arrow functions)

### Conventions
- [ ] Component naming (PascalCase)
- [ ] Props destructuring
- [ ] Hook rules followed (no conditional hooks)
- [ ] CSS modules or styled-components per project

## Node.js/Express

### Security
- [ ] Helmet or security headers configured
- [ ] Rate limiting on auth endpoints
- [ ] Input validation (Joi, Zod, or similar)
- [ ] No `process.env` leakage to client
- [ ] CORS properly configured

### Bugs
- [ ] Async route handlers have error propagation
- [ ] Database connection error handling
- [ ] File upload size limits
- [ ] Proper content-type validation

### Conventions
- [ ] Error middleware pattern
- [ ] Consistent response format
- [ ] Logging pattern (Winston, Pino per project)

## General Checks (All Languages)

- [ ] No commented-out code blocks
- [ ] No TODO/FIXME left unaddressed (if PR claims to fix them)
- [ ] Error messages are user-friendly
- [ ] No infinite loops or recursion without exit condition
- [ ] Proper resource disposal (files, connections, streams)
- [ ] No debugging statements left in (unless project allows)
