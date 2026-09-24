# ADR-003: Contextual Luna/Sol model routing

Status: Accepted

## Decision

Use logical model tiers with one concrete-ID mapping:
- default `luna` -> `gpt-6-luna`
- heavy `sol` -> `gpt-6-sol`

Resolve routing per stage rather than permanently by role. Architect, Plan Auditor, and Security Reviewer are intrinsically high-judgment; Planner, requirements reasoning, implementation/debugging, code review, and verification escalate only under defined complexity/risk conditions.

A Sol stage does not make later stages sticky-Sol.

Do not statically pin model IDs in every agent TOML. If a requested model is unavailable/rejected, retry the spawn without explicit model/reasoning override and record session-inheritance fallback.
