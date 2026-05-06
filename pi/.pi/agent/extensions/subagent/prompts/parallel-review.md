---
description: Run security, performance, and maintainability reviews in parallel
---
Use the subagent tool with parallel tasks to review $@ from three angles simultaneously:

1. Security review: agent "reviewer", task "Focus on security vulnerabilities, injection risks, auth issues, and data exposure in: $@"
2. Performance review: agent "reviewer", task "Focus on performance bottlenecks, unnecessary allocations, N+1 queries, and algorithmic complexity in: $@"
3. Maintainability review: agent "reviewer", task "Focus on code clarity, test coverage, documentation, and architectural consistency in: $@"

After all three complete, synthesize the findings into a single coherent review.
