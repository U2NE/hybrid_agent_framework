---
name: plan
description: Turn an approved SPEC into a dependency-aware implementation plan with context-sensitive Luna/Sol planning review.
---

# Plan

Read the active SPEC.md and research artifacts.

Use:
Researcher → Planner → Architect → Plan Auditor

For bounded work, use plan-lite and do not invoke Architect/Plan Auditor unless routing conditions require high-judgment architectural review.

Model routing:
- Researcher and ordinary Planner work default to Luna.
- Planner escalates to Sol for high ambiguity, architectural/large-refactor decisions, security-sensitive planning, or complex cross-module debugging.
- Architect and Plan Auditor are Sol-tier roles.
- Their Sol use does not pin later worker stages to Sol.

The plan must declare:
- exact files
- depends_on
- files_modified
- ownership
- acceptance criteria
- must-haves
- automated verification commands

Build a dependency graph. Never choose concurrency from agent count alone. Prefer tracer-first or vertical-slice ordering where it reduces integration risk.
