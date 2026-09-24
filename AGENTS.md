# AGENTS.md

This repository is a Codex-first autonomous development framework.

Read in this order:
1. `.planning/PROJECT.md`
2. `.planning/STATE.md`
3. the active phase `SPEC.md` and `PLAN.md`
4. `.planning/architecture/OVERVIEW.md`
5. `ARCHITECTURE.md` for framework internals

Rules:
- `.planning/` is the canonical project state. `.ai/wiki/` is derived knowledge only.
- Use flat dispatch by default. Only the lead spawns sibling Hybrid workers; workers never recursively delegate.
- The orchestrator schedules and records; workers implement.
- One writer per file per execution wave.
- Implementers never final-verify their own output.
- Security review is conditional on trust-boundary/security-sensitive changes.
- Model routing is policy-driven by `core/routing/model-routing.json`: Luna is the default tier; Sol is escalation-only for high ambiguity, architecture, security, complex debugging/review, or repeated verification failure.
- Model selection is per stage. A Sol planning/review stage does not force later implementer/tester stages to remain on Sol.
- If Codex rejects or cannot use an explicit routed model, retry that spawn without model/reasoning override and record the session-inheritance fallback; never substitute an invented model ID.
- Do not silently repair corrupt state. Surface it and recover from durable artifacts.
- Keep handoffs short and durable.
