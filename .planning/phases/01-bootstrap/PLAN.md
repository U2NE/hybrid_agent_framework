# PLAN

## Wave 1 — analysis and canonical design
- analyze-gsd
  - files_modified: none
  - verify: pinned SHA and source inspection
- analyze-omc
  - files_modified: none
  - verify: pinned SHA and source inspection
- design-matrix
  - depends_on: analyze-gsd, analyze-omc
  - files_modified: DESIGN-MATRIX.md, ARCHITECTURE.md
  - verify: one canonical implementation selected per capability

## Wave 2 — deterministic execution kernel
- classifier-requirements
  - files_modified: core/classifier/index.mjs, core/requirements/index.mjs
  - verify: node --test tests/requirements/*.test.mjs
- scheduler-planning
  - files_modified: core/scheduler/index.mjs, core/planning/index.mjs
  - verify: node --test tests/scheduler/*.test.mjs tests/e2e/artifact-workflow.test.mjs
- state-context
  - files_modified: core/state/index.mjs, core/context/index.mjs, core/artifacts/index.mjs
  - verify: node --test tests/state/*.test.mjs tests/e2e/artifact-workflow.test.mjs

## Wave 3 — orchestration and quality
- orchestrator-routing
  - depends_on: classifier-requirements, scheduler-planning, state-context
  - files_modified: core/orchestrator/index.mjs, core/routing/index.mjs
  - verify: node --test tests/e2e/orchestrator.test.mjs tests/e2e/codex-surface.test.mjs
- verification
  - depends_on: classifier-requirements
  - files_modified: core/verification/index.mjs
  - verify: node --test tests/verification/*.test.mjs
- knowledge
  - files_modified: core/wiki/index.mjs, core/docs/index.mjs
  - verify: node --test tests/wiki/*.test.mjs tests/e2e/docs-drift.test.mjs

## Wave 4 — Codex/project surface
- codex-surface
  - depends_on: orchestrator-routing
  - files_modified: .codex/config.toml, .codex/agents/*.toml, skills/*/SKILL.md, .agents/skills/*, .codex/skills/*
  - verify: Codex 0.156.1 strict-config doctor plus codex-surface tests
- installer
  - depends_on: codex-surface, knowledge
  - files_modified: scripts/install-project.mjs
  - verify: node --test tests/e2e/install-project.test.mjs

## Wave 5 — integration
- full-verification
  - depends_on: orchestrator-routing, verification, knowledge, codex-surface, installer
  - files_modified: planning verification/summary docs and derived wiki only
  - verify: npm run check && npm test

## Must-haves
Upstreams stay clean; all tests pass; live Codex limitation is explicitly recorded as authentication-only.
