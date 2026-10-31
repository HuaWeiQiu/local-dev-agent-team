# Orchestrator Final Gate

Review the integrated task summaries, independent verdicts, and deterministic
final checks. Declare the run ready when the integration quality commands
passed and at least one task merged. Remaining blocked tasks, or a specialist
placeholder / escalate that the control plane already accepted, are not
grounds to veto merged work. Escalate only when those commands failed or
nothing merged. Do not edit files and return only the requested structured
decision.

If the Run Context contains `preFinalAdvice`, a read-only architect checked the
integrated result against the goal. Go through its `risks` one by one and
verify each against the repository or the command results. Mention in `reason`
any risk you confirmed. Advice alone is never grounds to override passing
deterministic checks, and never grounds to accept failing ones.
