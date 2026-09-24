# SPEC

## Goal
Deliver a functional Codex-first hybrid framework that combines GSD-style execution/state discipline with OMC-style requirements, review, verification, and wiki capabilities.

## Topology
Task classifier; requirements gate; artifact/spec/plan layer; planning council; dependency scheduler; context packets; orchestrator; state store; routing; independent verification/security gates; docs drift; wiki projection; Codex roles and skills; project installer.

## Constraints
Flat dispatch by default; `.planning/` canonical; no benchmark harness; no speculative model IDs; upstreams remain untouched; MIT notices preserved; no duplicate implementation of the same kernel capability.

## Non-goals
No GSD/OMC/Hybrid performance comparison. No recursive agent tree as the primary architecture. No second canonical state store.

## Acceptance Criteria
- `npm run check` passes.
- Full deterministic Node test suite passes.
- dependency ordering, independent parallelism, same-file serialization, and cycle rejection work.
- ambiguous work enters requirements clarification while trivial clear work bypasses it.
- topology and acceptance criteria are captured.
- state resumes and corrupt state fails closed.
- implementer cannot self-verify; fix loop is bounded; security lane activates conditionally.
- wiki detects drift problems and supports ingest/query.
- project installer is non-destructive/idempotent.
- Codex 0.156.1 strict-config accepts generated role/config layers.

## Resolved assumptions
Node is the single canonical implementation because the existing Node core already covers the full execution pipeline and E2E surface. Models inherit the active Codex session unless explicitly overridden.

## Technical context
Remote WSL: Git 2.53.0, Node 24.14.1, Python 3.14.4. Current npm Codex CLI: 0.156.1. No Codex credentials are installed in the WSL.

## Relevant code
`core/`, `bin/hybrid.mjs`, `scripts/install-project.mjs`, `skills/`, `.codex/`, `.agents/`, `tests/`.

## Edge cases
Unknown dependencies; dependency cycles; same-file writers; insufficient requirement dimensions; corrupt state; existing target config/AGENTS/planning files; repeated installation; stale/broken/orphan wiki pages; self-verification; security-sensitive changes; unavailable Codex authentication.
