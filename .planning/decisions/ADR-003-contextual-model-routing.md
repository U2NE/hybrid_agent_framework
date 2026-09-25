# ADR-003: Contextual Luna/Sol model routing

Status: Accepted

## Decision

Use logical model tiers with one concrete-ID mapping:
- default `luna` -> `gpt-6-luna`
- heavy `sol` -> `gpt-6-sol`

Resolve routing per stage rather than permanently by role. Architect, Plan Auditor, and Security Reviewer are intrinsically high-judgment; Planner, requirements reasoning, implementation/debugging, code review, and verification escalate only under defined complexity/risk conditions.

A Sol stage does not make later stages sticky-Sol.

Do not statically pin model IDs in every agent TOML. Resolve model and reasoning effort from the canonical routing policy for every Hybrid-controlled inference and pass both explicitly. Only policy-listed concrete IDs are allowed. Missing/unapproved model or effort fails before spawn; an allowed override that is unavailable/rejected fails closed without session/default inheritance or arbitrary substitution. The earlier session-inheritance fallback is superseded.
