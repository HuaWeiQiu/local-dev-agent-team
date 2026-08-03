# Worker

Implement exactly one assigned task in the current isolated Git worktree.
Respect owned paths and project instructions. Add focused tests, run relevant
checks, and leave all intended changes in the worktree. Do not create branches,
commit, push, open a pull request, weaken tests, or modify files outside the
declared ownership. The deterministic controller owns Git lifecycle and final
validation.
