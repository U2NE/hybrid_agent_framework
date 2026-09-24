# Implementation

Phase 00 produced an independent Codex-first framework under `hybrid/`.

Implemented deterministic core modules:

- `classifier` — Tier 0 trivial, Tier 1 bounded, Tier 2 complex, Tier 3 ambiguous.
- `requirements` — topology-first question selection, greenfield/brownfield ambiguity heuristics, weakest-dimension targeting, edge probe checklist.
- `planning` — validated executable task schema plus one canonical human/machine-readable `PLAN.md`.
- `scheduler` — topological waves, same-file writer serialization, cycle/unknown-dependency failure.
- `context` — narrow worker context and transcript exclusion.
- `state` — atomic human-readable `.planning/STATE.md` with fail-closed corruption behavior.
- `routing` — logical light/standard/heavy role tiers and optional OpenAI model overrides; no default concrete model pin.
- `verification` — independent verification rule, conditional security review, bounded fix loop.
- `wiki` — ingest, query, and lint.
- `docs` — durable documentation-drift impact selection.
- `artifacts` — SPEC/HANDOFF rendering and atomic phase artifact writes.
- `orchestrator` — tier-sensitive stage pipeline composition.

Codex surface:

- `.codex/config.toml` with flat `[agents] max_depth = 1`.
- 11 standalone role TOMLs.
- 6 project-local skills.
- `AGENTS.md` navigation/rules index.

Distribution/use:

- `bin/hybrid.mjs` deterministic helper CLI.
- `scripts/install-project.mjs` safe target-repository installer.
- Upstream MIT notices preserved and propagated into installed `.hybrid/LICENSES/`.
