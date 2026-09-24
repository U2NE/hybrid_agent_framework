# Bootstrap SPEC

## Goal
Create an independently runnable Codex-first framework skeleton based on the approved hybrid architecture.

## Topology
1. Codex surface
2. Requirements gate
3. Execution scheduler
4. Persistent state/recovery
5. Independent verification
6. Derived wiki

## Constraints
- Upstreams read-only.
- MIT notices preserved.
- No benchmark harness.
- No unnecessary runtime dependencies.
- Flat dispatch and max depth one.
- Session model inheritance by default.

## Acceptance Criteria
- Deterministic tests cover scheduler ordering/conflicts/cycles.
- Ambiguous tasks trigger requirements path; trivial tasks bypass it.
- State resumes and corruption does not silently reset.
- Wiki lint detects broken/orphan/stale conditions.
- Implementer cannot self-verify.
- Fix loop is bounded.
- Security-review trigger is conditional.
