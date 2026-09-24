# PLAN — Framework Audit

## Wave 1 — audit
- inspect routing/orchestrator/security/scheduler/state/installer/skills
- verify current Codex 0.156.1 schema and model catalog

## Wave 2 — minimal implementation changes
- add logical Luna/Sol policy and contextual escalation/downshift
- add required standalone-agent metadata
- strengthen state schema validation
- make installer CLI validation optional/best-effort
- keep flat dispatch as lead-only sibling dispatch + worker no-delegation

## Wave 3 — regression coverage
- routing escalation/downshift/fallback
- installer CLI absent/present behavior
- skill source/frontmatter
- unsupported state schema fail-closed
- security trigger coverage
- pipeline model routing

## Wave 4 — runtime smoke preparation and docs
- Case A independent siblings
- Case B same-file serialization
- Case C security review lane
- runtime-validation boundary docs
- model-routing docs
- derived wiki update

## Wave 5 — full verification
- npm run check
- npm test
- npm run smoke:preflight
- wiki lint
- actual repository STATE recovery
- Codex 0.156.1 strict-config doctor
- Codex 0.156.1 model catalog check
- upstream cleanliness
