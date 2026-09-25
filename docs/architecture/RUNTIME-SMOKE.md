# Authenticated Codex runtime smoke

This is a functional orchestration smoke, not a GSD/OMC/Hybrid benchmark.

## Deterministic preflight

```bash
npm run smoke:preflight
npm run smoke:routing:preflight
npm run smoke:worktree:preflight
npm run smoke:planning:preflight
npm run smoke:repair:preflight
npm run smoke:proof:preflight
npm run smoke:decision:preflight
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
npm run smoke:repair:live
npm run smoke:proof:live
npm run smoke:decision:live
```

Each A/B/C run creates an isolated temporary Git repository, installs Hybrid, runs `codex exec --strict-config --json`, and preserves JSONL/stderr under that workspace's `.planning/runtime-smoke/`.

A live case is PASS only after semantic validation of the generated report and output files. Exit code alone is insufficient. The runner has a bounded timeout so a stalled orchestration does not hang indefinitely.

- **Case A:** two independent files; requires observed sibling-worker overlap, correct outputs, flat delegation, accepted Luna medium requests, and final verifier completion.
- **Case B:** two tasks modify `src/shared.js`; requires separate observed waves, no overlap, both final changes, and final verifier completion.
- **Case C:** authorization change; implementer first, then tester + code reviewer + security reviewer as an independent QA wave, then verifier. The bounded security reviewer uses Luna max.
- **Routing probe:** exercises Luna high/xhigh/max request acceptance plus invalid-model rejection and no-override session-inheritance retry.
- **Case E / worktree smoke:** forces worktree isolation for two independent writers and semantically requires real Git worktree creation, distinct worker cwd paths, overlapping authenticated workers, declared-owner patch handoff, fail-closed integration, integrated file checks, fresh final verifier command evidence, cleanup, and no orphan worktrees.
- **Case F / planning convergence:** starts from a plan with one real deterministic SPEC coverage gap, binds independent Architect and Plan Auditor reviews to the same exact-byte plan hash, returns material objections to Planner-only revision, repeats within the bounded consensus policy, and passes only when both council reviewers approve the same corrected revision. Final execution approval must remain false.
- **Case G / repair convergence:** directly consumes the framework-source generic `runQualityClosure()` production primitive and requires an objectively failing R1 behavior, independent Tester/Code Reviewer defect evidence, targeted Implementer-owned repair with a changed Git snapshot, post-fix QA, fresh command-backed Verifier PASS, no recursive delegation, and at most three repairs. Exit code alone is insufficient.
- **Case H / proof-gap QE:** directly consumes the same framework-source generic production primitive and requires the initial evidence gate and authenticated Verifier to refuse missing CLI proof, raw deterministic process proof acquisition, exact acquired-evidence-ID consumption by the second Verifier, semantic reassessment before final gate PASS, zero QE agents, and zero browser use. Exit code alone or semantically wrong output is insufficient.
- **Case I / installed Lead attestation:** creates a disposable Git project, performs the real Hybrid installation, runs an authenticated Lead from that project root, and requires the Lead to invoke the installed `.hybrid/core/orchestrator/index.mjs` primitive. The validator requires installed-contract/export evidence, installed-core integrity, actual action execution, primitive-tagged QA/Verifier/completion artifacts, completion PASS, and no recursive delegation; fake success, missing completion, and framework-source bypass fail closed.
- **Case J / installed Decision Provenance:** creates a disposable installed project and asks an authenticated installed Lead to make a one-line Tier 0 README change. Semantic PASS requires `decisions.jsonl`, `events.jsonl`, and `audit.json` with `audit.ok === true`, the `classify_tier_0` / `lead_direct_execution` decision with `TIER0_TRIVIAL`, a matching decision ID on the actual action, lightweight verification, and a runtime completion event. The validator rejects exit-zero without decisions, missing linked actions, action without decision, ID mismatch, hidden reasoning/prompt/raw source, fabricated actor attribution, or a completion claim without a completion event. Its bounded live case does not require parallel workers; deterministic tests validate concurrency and sibling ordering.

Authenticated A, B, C, E, F, G, H, and I reached semantic PASS during the audit. The runtime does not expose independent backend model-attestation evidence, so reports state only that explicit model/effort requests were accepted.

Case J authenticated live semantic validation PASSes: the installed Lead emitted real decision/event artifacts and `audit.json` reports `ok: true` with no findings. Runtime Event records what actually happened; Decision Provenance records why Hybrid chose the control-flow action; Actor Artifact records what an individual worker did; Audit checks whether the recorded decisions and actions agree. Each layer stores bounded metadata only and never hidden reasoning. The lead alone owns central decision/event logs, while each worker API is bound to its own actor artifact. This structural API boundary is not an OS sandbox; audit conclusions are limited to declared events, ownership, attribution, and evidence links and cannot reveal unreported filesystem mutations.

## Case D

Case D is the clarification smoke. Its deterministic fixture verifies Round 0 topology confirmation, multiple one-question rounds, weakest-target recomputation, ambiguity reduction to <= 0.20, spec readiness, and pending approval.

A real live Case D is deliberately not auto-simulated because its core evidence is genuine user answers. `--live D` therefore returns `runtime-validation-pending` instead of inventing an interview.

The installed provenance API is `.hybrid/core/provenance/index.mjs`. `buildDecision()` creates a `hybrid-decision/v1` record; `validateDecision()` checks its structured identity and privacy contract. `prepareExecution({runId, snapshot, ...})` returns a pure `decisionTrace` without writing artifacts. Each action-bearing decision declares `intendedAction: {type, role}`; actual events use `action`, `role`, `decisionId`, and the same run/task/wave/agent identities. Metadata is bounded; snapshot and ownership fields remain exact.

The Lead creates `createDecisionWriter({role: 'lead', runId, runtimeRoot})` and passes records to the returned async function. Workers use `createActorArtifactWriter({runId, agentRunId, runtimeRoot})`; these artifacts are explicitly reported attribution. `auditDecisionTrace({decisions, events, actorArtifacts, expectedSnapshot, taskOwnership})` checks links and ownership without relying on timestamp order. `writeAuditArtifact(audit, options)` saves the passive report. Storage failures return `ok: false`, or throw with `strict: true`. Quality closure accepts an optional `decisionWriter` (or `provenanceLogger`) callback and returns its `decisionTrace`; existing event logger injection remains supported.

Run `npm run smoke:decision:preflight` for a real disposable installation and synthetic validator checks without authentication. `npm run smoke:decision:live` checks Codex authentication and executes the installed Lead. Authenticated Case J has passed the live semantic validator; deterministic preflight alone still does not establish live PASS.
