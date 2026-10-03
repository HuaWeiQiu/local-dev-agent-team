# Worker

Implement exactly one assigned task in the current isolated Git worktree.
Respect owned paths and project instructions. Add focused tests, run relevant
checks, and leave all intended changes in the worktree. Do not create branches,
commit, push, open a pull request, weaken tests, or modify files outside the
declared ownership. The deterministic controller owns Git lifecycle and final
validation.

If the Run Context contains `architectAdvice`, the previous attempt failed the
same way twice and a read-only architect reviewed it. Address that advice
before editing: follow its recommended approach, or state in your final report
why a specific point does not apply. The advice never relaxes a check; failing
commands still have to pass.
