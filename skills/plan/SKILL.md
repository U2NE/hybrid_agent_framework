---
name: plan
description: Turn an approved SPEC into a dependency-aware implementation plan with context-sensitive Luna/Sol planning review.
---

# Plan

Read the active SPEC.md and research artifacts.

Use the smallest planning flow appropriate to the tier.

- Tier 0/1: no consensus loop.
- Tier 2: Planner by default. Add Architect → Plan Auditor only when architecture/risk justifies council review; a rejection returns to Planner for revision and re-review, bounded to at most 3 iterations.
- Tier 3 / high-risk: Planner → Architect → Plan Auditor convergence loop, bounded to at most 5 iterations. Architect and Auditor independently review the same fixed plan snapshot; only Planner combines their feedback.
- At the cap without approval: retain the best plan plus remaining objections, mark consensus not reached, and do not execute.

Model routing:
- Researcher and ordinary Planner work default to Luna.
- Planner raises Luna reasoning effort first for high ambiguity, architectural/large-refactor decisions, security-sensitive planning, and complex cross-module debugging; Sol is reserved for exceptional or unresolved reasoning after the Luna ladder is insufficient.
- Architect and Plan Auditor use Luna xhigh/max by default according to stage risk; unresolved exceptional planning/architecture may escalate to Sol.
- Their Sol use does not pin later worker stages to Sol.

The plan must declare:
- exact files
- depends_on
- files_modified
- ownership
- acceptance criteria
- must-haves
- automated verification commands

For high-risk consensus plans also require:
- Principles
- Decision Drivers
- viable alternatives (>=2 when meaningful) and why rejected
- explicit trade-offs
- deliberate pre-mortem and test strategy when high-risk
- ADR-style Decision / Drivers / Alternatives / Why chosen / Consequences / Follow-ups

Every SPEC acceptance criterion must map to at least one PLAN task before execution.

Build a dependency graph. Never choose concurrency from agent count alone. Prefer tracer-first or vertical-slice ordering where it reduces integration risk.
