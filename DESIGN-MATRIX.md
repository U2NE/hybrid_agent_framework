# Design Matrix

| Capability | GSD implementation | OMC implementation | Selected base | What to port | What to discard | Reason | Risk |
|---|---|---|---|---|---|---|---|
| Orchestration | Thin orchestrator, fresh workers, phase artifacts | Team/autopilot modes | GSD | OMC role vocabulary | recursive/team-first default | Codex flat dispatch and recovery are simpler | under-routing |
| Requirements | spec-phase, weighted ambiguity gate, scout-first | deep-interview, topology/assumptions/ontology | Hybrid on GSD gate | topology gate, assumption exposure, weakest-dimension questioning | forced interview for every task | precision without token tax | heuristic score overconfidence |
| Planning | planner + checker, explicit file/dependency metadata | planner + architect + critic | GSD plan format | architect and critic as independent council lanes | duplicated plan formats | one canonical PLAN artifact | review latency |
| Scheduling | dependency waves, worktree isolation, file scope | team worker orchestration | GSD | role-aware handoff metadata | agent-count-driven parallelism | dependency graph drives concurrency | imperfect file declarations |
| State | `.planning/` durable state and recovery | OMC state/session artifacts | GSD | short stage handoffs | second canonical state | one source of truth | state writer bugs |
| Verification | executor/verifier separation | test-engineer, code-reviewer, verifier, fix loop | Hybrid | independent reviewer roles, bounded fix loop | self approval | stronger quality separation | review cost |
| Security | security capability / gates | specialized security-reviewer | Conditional hybrid | trigger-based reviewer activation | review on every change | cost proportional to risk | trigger false negatives |
| Knowledge | planning docs | persistent wiki ingest/query/lint | OMC projection over GSD state | wiki lint + durable knowledge patterns | wiki as source of truth | avoids split brain | stale projection |
| Codex agents | standalone TOML, flat orchestration concepts | Claude-oriented role prompts | Hybrid on current Codex surface | OMC role semantics adapted to Codex | Claude aliases/nested Task assumptions | standalone agents expose required name/description/instructions; lead-only sibling dispatch | runtime backend behavior still needs authenticated validation |
| Model routing | passive inheritance plus Codex overrides | role/model preferences | Hybrid contextual tiers | Luna-default/Sol-escalation policy, per-stage downshift, safe inheritance fallback | sticky heavy roles and scattered model IDs | lower routine cost while preserving high-judgment reasoning | live override/fallback still pending authenticated runtime test |
