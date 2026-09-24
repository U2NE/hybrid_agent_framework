# Runtime Validation Boundary

## Verified

The following are verified:

- Node syntax/config surface.
- Codex 0.156.1 strict config loading.
- custom agent registration and standalone agent TOML shape.
- repository-local skill discovery layout and YAML frontmatter.
- exact Luna/Sol model IDs present in the Codex 0.156.1 model catalog.
- logical model routing and escalation/downshift/fallback decisions.
- dependency-wave scheduler, same-file serialization, and cycle rejection.
- state persistence, schema compatibility, and fail-closed corruption/schema handling.
- wiki lint/query/ingest.
- independent verification and bounded fix loop.
- conditional security-review activation.
- installer behavior with and without a Codex CLI.
- authenticated Case A subagent spawn.
- authenticated Case A sibling parallel execution.
- authenticated Case A handoff/result collection.
- authenticated Case A explicit `gpt-6-luna` spawn overrides accepted by the runtime.

## Runtime validation still pending

Case A is now verified end to end. These are still not claimed as verified:

- Case B live same-file serialization.
- Case C live security-reviewer activation with Sol escalation.
- a deliberately rejected model override followed by actual session-inheritance retry.
- independently attested underlying model identity after an accepted spawn override; Codex confirms the override request was accepted but does not expose separate model-attestation evidence in this trace.

Run `scripts/runtime-smoke.mjs --live B` and `--live C` for the remaining functional cases.

## Case A observation

Authenticated Case A completed in about 182 seconds.

- two independent implementation workers were observed running concurrently;
- both requested `gpt-6-luna` with medium reasoning and the runtime accepted both overrides;
- both implementation files were already complete at roughly the first 50 seconds;
- the remaining runtime was dominated by sequential tester → code reviewer → verifier stages.

This shows that the current bottleneck for tiny bounded work is orchestration/QA fan-out, not implementation parallelism.

A separate direct Luna profiling run completed a minimal Node CLI in about 24 seconds with unrestricted sandboxing. The same style of task took about 64 seconds under `workspace-write` after subprocess-based tests hit `EPERM` and triggered repeated diagnosis. Sandbox/test compatibility is therefore a second operational bottleneck.

## Installer boundary

Codex CLI is not an installation prerequisite.

- CLI absent: installation succeeds; CLI-dependent validation is WARN/SKIP.
- CLI present: installer runs strict config validation and separately reports runtime authentication readiness.
- credentials absent: runtime is reported `pending`; installation still succeeds.
