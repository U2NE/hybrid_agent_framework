# Runtime Validation Boundary

## Verified

The following are verified without requiring an authenticated model invocation:

- Node syntax/config surface.
- Codex 0.156.1 strict config loading.
- custom agent registration and standalone agent TOML shape.
- repository-local skill discovery layout and YAML frontmatter.
- exact Luna/Sol model IDs present in the Codex 0.156.1 model catalog.
- logical model routing and escalation/downshift/fallback decisions.
- dependency-wave scheduler.
- same-file writer serialization.
- cycle rejection.
- state persistence, schema compatibility, and fail-closed corruption/schema handling.
- wiki lint/query/ingest.
- independent verification and bounded fix loop.
- conditional security-review activation.
- installer behavior with and without a Codex CLI.

## Runtime validation pending

The WSL currently has no Codex credentials. Therefore these are explicitly **not yet claimed as verified**:

- actual model-backed subagent spawn.
- actual sibling parallel execution in Codex runtime.
- actual handoff/result collection from sibling agents.
- actual runtime application of Luna/Sol spawn overrides.
- actual runtime retry to session inheritance after a model override rejection.

These require an authenticated Codex session. Use `scripts/runtime-smoke.mjs --live A|B|C`; see `docs/architecture/RUNTIME-SMOKE.md`.

## Installer boundary

Codex CLI is not an installation prerequisite.

- CLI absent: installation succeeds; CLI-dependent validation is WARN/SKIP.
- CLI present: installer runs strict config validation and separately reports runtime authentication readiness.
- credentials absent: runtime is reported `pending`; installation still succeeds.

This supports ChatGPT/Codex app environments that consume project-local agents/skills without requiring a separately installed local CLI.
