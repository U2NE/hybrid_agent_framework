# VERIFICATION — Framework Audit

Status: deterministic PASS; authenticated Codex runtime validation pending.

## Completed checks

- `npm run check`: PASS.
- `npm test`: PASS, 47/47.
- `npm run smoke:preflight`: PASS for Cases A/B/C.
- wiki lint: PASS; no broken/stale/orphan/oversized/contradictory top-level pages.
- actual repository `.planning/STATE.md` recovery: PASS with `hybrid-state/v1`.
- Codex 0.156.1 strict-config doctor: `config.load = ok`.
- Codex 0.156.1 local model catalog: `gpt-6-luna` and `gpt-6-sol` present.
- installer regression: CLI absent installs successfully and skips runtime validation; CLI present adds config/auth readiness checks.
- security triggers: auth/authentication, authorization, crypto, secret, payment, file upload, SQL, network trust boundary, and permission all covered.
- both pinned upstream repositories remain read-only analysis inputs and must remain clean.

## Runtime validation pending

The WSL has no global Codex CLI credentials. Live Case A returns `runtime-validation-pending` rather than claiming success.

Not yet verified:
- real model-backed subagent spawn;
- real sibling parallel execution;
- live handoff/result collection;
- actual per-spawn Luna/Sol model application;
- actual rejected-model retry into session inheritance.

Run `node scripts/runtime-smoke.mjs --live A`, `--live B`, and `--live C` after Codex authentication.
