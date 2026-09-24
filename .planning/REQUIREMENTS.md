# Requirements

- Classify work into trivial, bounded, complex, ambiguous tiers.
- Scout brownfield repositories before asking code-answerable questions.
- Gate ambiguous work using weighted clarity with ambiguity threshold 0.20.
- Capture topology, constraints, non-goals, assumptions, acceptance criteria, edge cases in SPEC.
- Plans declare exact files, dependencies, ownership, must-haves, verification commands.
- Schedule by dependency waves with one writer per file per wave.
- Keep orchestrator thin and workers fresh-context.
- Separate implementation, testing, review, verification.
- Activate security review conditionally.
- Limit verify/fix iteration to 3.
- Persist canonical project state under `.planning/`.
- Maintain `.ai/wiki/` only as derived projection.
- Provide Codex-discoverable `.codex/agents/*.toml` and `.codex/skills/*/SKILL.md`.
