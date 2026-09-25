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
- For ambiguous work, use the iterative `clarify` flow: Scout brownfield facts first, confirm Round 0 topology once, ask one user decision question per round, re-score after every answer, and do not treat early-exit/hard-cap as a normal ambiguity pass.
- Model routing is policy-driven by `core/routing/model-routing.json`: select the appropriate Luna effort per stage first, and enter Sol only when Luna max is insufficient or the stage is exceptionally difficult/critical.
- Model selection is per stage. A Sol planning/review stage does not force later implementer/tester stages to remain on Sol.
- Every Hybrid-controlled inference must use the explicit allowlisted model and reasoning effort resolved by Hybrid routing. Session/default model inheritance is prohibited. If Codex rejects or cannot use that routed override, fail closed; do not retry without overrides and do not substitute another model.
- When a persisted decision already exists, bind its actual runtime action programmatically with `writeActionForDecision(decision, event)`; never manually transcribe the decision ID or routed model metadata.
- Do not silently repair corrupt state. Surface it and recover from durable artifacts.
- Keep handoffs short and durable.
