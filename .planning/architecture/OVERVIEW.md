# Architecture Overview

Flat-dispatch Codex framework. The lead classifies work, opens requirements clarification only when necessary, builds durable SPEC/PLAN artifacts, schedules dependency waves, delegates sibling implementation workers, then runs independent quality lanes.

Model routing is per stage: Luna medium/high/xhigh/max are selected by difficulty before Sol escalation; later routine stages downshift independently. Concrete model IDs and efforts are isolated in `core/routing/model-routing.json`, with explicit override rejection falling back to session inheritance.

`.planning/` is canonical; wiki content is derived. State schema is `hybrid-state/v1` and unsupported/corrupt state fails closed.
