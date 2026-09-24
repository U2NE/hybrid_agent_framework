# Architecture Overview

Flat-dispatch Codex framework. The lead classifies work, opens requirements clarification only when necessary, builds durable SPEC/PLAN artifacts, schedules dependency waves, delegates sibling implementation workers, then runs independent quality lanes.

Model routing is per stage: Luna is the default tier; high-judgment/risk stages may escalate to Sol; later routine stages downshift to Luna. Concrete model IDs are isolated in `core/routing/model-routing.json` and explicit model rejection falls back to session inheritance.

`.planning/` is canonical; wiki content is derived. State schema is `hybrid-state/v1` and unsupported/corrupt state fails closed.
