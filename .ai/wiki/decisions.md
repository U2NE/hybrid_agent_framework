---
title: Key Decisions
category: decision
tags: [state, codex, routing, decisions]
updated: 2026-09-25
---
# Key Decisions

- Flat dispatch is architectural: only the lead dispatches sibling workers; workers do not recursively delegate. `max_depth = 1` is only a Codex 0.156.1 compatibility guard.
- Model routing uses logical tiers: Luna is the default and Sol is conditional high-judgment escalation. Concrete IDs live only in the routing policy.
- Routing is recomputed per stage, so a Sol planning/review stage can downshift to Luna for later routine work.
- Explicit model rejection falls back by retrying without model/reasoning overrides so Codex can inherit the session/default model.
- `.planning/` is canonical; this wiki is derived.
- State schema is `hybrid-state/v1`; unsupported/corrupt state fails closed.
- Same-file writers are serialized.
- Fix loops stop after three targeted repairs.

See [[index]] and [[architecture]].
