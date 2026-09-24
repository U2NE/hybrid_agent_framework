# Authenticated Codex runtime smoke

This is a functional orchestration smoke, not a GSD/OMC/Hybrid benchmark.

## Deterministic preflight

```bash
npm run smoke:preflight
npm run smoke:routing:preflight
npm run smoke:worktree:preflight
npm run smoke:planning:preflight
```

Preflight proves framework-side policy only. It does not prove subagent runtime behavior.

## Live cases

When `codex doctor --json` reports credentials ready:

```bash
node scripts/runtime-smoke.mjs --live A
node scripts/runtime-smoke.mjs --live B
node scripts/runtime-smoke.mjs --live C
npm run smoke:routing:live
npm run smoke:worktree:live
npm run smoke:planning:live
```

Each A/B/C run creates an isolated temporary Git repository, installs Hybrid, runs `codex exec --strict-config --json`, and preserves JSONL/stderr under that workspace's `.planning/runtime-smoke/`.

A live case is PASS only after semantic validation of the generated report and output files. Exit code alone is insufficient. The runner has a bounded timeout so a stalled orchestration does not hang indefinitely.

- **Case A:** two independent files; requires observed sibling-worker overlap, correct outputs, flat delegation, accepted Luna medium requests, and final verifier completion.
- **Case B:** two tasks modify `src/shared.js`; requires separate observed waves, no overlap, both final changes, and final verifier completion.
- **Case C:** authorization change; implementer first, then tester + code reviewer + security reviewer as an independent QA wave, then verifier. The bounded security reviewer uses Luna max.
- **Routing probe:** exercises Luna high/xhigh/max request acceptance plus invalid-model rejection and no-override session-inheritance retry.
- **Case E / worktree smoke:** forces worktree isolation for two independent writers and semantically requires real Git worktree creation, distinct worker cwd paths, overlapping authenticated workers, declared-owner patch handoff, fail-closed integration, integrated file checks, fresh final verifier command evidence, cleanup, and no orphan worktrees.
- **Case F / planning convergence:** starts from a plan with one real deterministic SPEC coverage gap, binds independent Architect and Plan Auditor reviews to the same exact-byte plan hash, returns material objections to Planner-only revision, repeats within the bounded consensus policy, and passes only when both council reviewers approve the same corrected revision. Final execution approval must remain false.

Authenticated A, B, C, E, and F reached semantic PASS during the audit. The runtime does not expose independent backend model-attestation evidence, so reports state only that explicit model/effort requests were accepted.

## Case D

Case D is the clarification smoke. Its deterministic fixture verifies Round 0 topology confirmation, multiple one-question rounds, weakest-target recomputation, ambiguity reduction to <= 0.20, spec readiness, and pending approval.

A real live Case D is deliberately not auto-simulated because its core evidence is genuine user answers. `--live D` therefore returns `runtime-validation-pending` instead of inventing an interview.
