# IMPLEMENTATION — Framework Audit

## Preserved

The existing Node kernel remains canonical. Scheduler, planning/artifacts, context, verification, wiki, and CLI architecture were not replaced.

## Modified

- `core/routing/`: logical Luna/Sol policy, contextual escalation, per-stage downshift, safe inheritance fallback.
- `core/orchestrator/`: plan-lite bounded path and per-stage routing output.
- `.codex/agents/*.toml`: standalone role identity/description plus explicit no-delegation.
- `core/state/`: explicit `hybrid-state/v1` schema with backward-compatible v1 loading and unsupported-schema rejection.
- `scripts/install-project.mjs`: CLI-optional install, additive strict/runtime validation, installed role identity normalization, sibling concurrency capacity.
- skills/AGENTS: routing, flat-dispatch, and fallback instructions.
- durable docs/wiki: current routing/runtime boundary.

## Added

- `core/routing/model-routing.json`
- `docs/architecture/MODEL-ROUTING.md`
- `docs/RUNTIME-VALIDATION.md`
- `docs/architecture/RUNTIME-SMOKE.md`
- `scripts/runtime-smoke.mjs` with embedded Cases A/B/C
- regression tests for routing, installer, state schema, security triggers, and smoke preflight.

## Routing result

Historical implementation note: normal stages resolved to Luna and contextual high-risk stages could escalate to Sol, with routing recomputed per stage. At that time explicit model failure retried without model/reasoning overrides. That fallback is superseded: current Hybrid execution fails closed and never inherits the session/default model.
