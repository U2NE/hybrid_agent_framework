# Handoff

Decided:
- GSD-style execution kernel is canonical.
- OMC topology/clarity/review/wiki concepts are selectively ported.
- Codex dispatch is flat with max depth one.
- PLAN.md and STATE.md each contain their own machine-readable block; no duplicate JSON source of truth.
- Session-model inheritance is the default.

Rejected:
- Direct upstream merge.
- tmux/provider-runtime port.
- mandatory interview for every task.
- wiki as authority.
- unbounded repair.

Risks:
- Current WSL has no Codex CLI, so live host dispatch is not smoke-tested.
- Concrete model IDs must not be defaulted until the target Codex host confirms support.

Files:
- DESIGN-MATRIX.md
- ARCHITECTURE.md
- core/**
- .codex/**
- skills/**
- scripts/install-project.mjs
- .planning/**

Remaining:
- Phase 01: live Codex CLI discovery/dispatch test.
- Verify optional role/model overrides against the actual installed host.
