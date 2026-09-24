# Model Routing

## Policy

Hybrid uses logical tiers so agent prompts and role definitions do not depend on concrete model IDs.

Canonical mapping: `core/routing/model-routing.json`

```text
default_model_tier = luna
heavy_model_tier = sol

luna -> gpt-6-luna
sol  -> gpt-6-sol
fallback -> session-inheritance
```

The concrete IDs `gpt-6-luna` and `gpt-6-sol` were confirmed against the Codex CLI 0.156.1 local model catalog on 2026-09-25. They are isolated in the routing policy so a future ID change does not require rewriting every agent prompt.

## Default and escalation

Luna is the default for scout, research, ordinary requirement extraction, normal planning, normal implementation, tests, documentation/wiki work, routine code review, and routine verification.

Sol is selected for:
- Architect and Plan Auditor.
- Security Reviewer.
- high-ambiguity requirements reasoning.
- Planner work classified as complex, or involving high ambiguity, architecture/large refactors, security-sensitive planning, or complex cross-module debugging.
- Implementer work specifically marked as complex cross-module debugging.
- difficult/architectural/security-sensitive Code Reviewer work.
- difficult verifier/review judgment after repeated verification failures.

Routing is recomputed per stage. A Sol Planner/Architect does not make later Implementer/Tester stages sticky-Sol; ordinary stages downshift to Luna automatically.

## Runtime application

The standalone agent TOMLs intentionally contain no static `model` or `model_reasoning_effort`. The lead reads the route produced by `prepareExecution()` and requests that model for the individual spawn.

This preserves a safe fallback:
1. request the routed concrete model;
2. if Codex says the explicit model/override is unavailable or unsupported, retry that spawn once without model/reasoning overrides;
3. record `session-inheritance` fallback;
4. never invent a replacement model ID.

Hybrid also avoids setting `agents.default_subagent_model` globally, because doing so would prevent a no-override retry from reaching normal Codex session/default inheritance.

## Reasoning effort

Current starting mapping:
- Luna: `medium`
- Sol: `high`

These are policy defaults, not immutable requirements. They are stored next to the model mapping so they can change independently of role prompts.
