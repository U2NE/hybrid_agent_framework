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
- **Case J / installed Decision Provenance:** creates a disposable installed project and asks an authenticated installed Lead to make a one-line Tier 0 README change through the canonical Implementer path. Semantic PASS requires automatic preparation persistence, Tier 0 classification, Implementer activation, a `spawn_implementer` decision, linked Lead-owned spawn/completion events, a reported worker actor artifact, lightweight verification, final completion, and a clean audit. Lead-direct task mutation is rejected.
- **Case K / parallel installed Decision Provenance:** creates a disposable installed project with two independent approved tasks. Semantic PASS requires one parallel-wave parent, two distinct Implementer child decisions, actual sibling delegation, per-worker reported actor artifacts, linked Lead-owned action events, exact file ownership, installed-API/core integrity, and a clean audit.

Authenticated A, B, C, E, F, G, H, and I reached semantic PASS during the audit. The runtime does not expose independent backend model-attestation evidence, so reports state only that explicit model/effort requests were accepted.

The tightened Case J and new Case K deterministic preflights PASS. Authenticated reruns remain pending because the Codex usage quota was exhausted on 2026-09-25: the revised Case J run reached the installed `prepareExecutionWithProvenance()` path and automatically persisted its preparation decisions before quota exhaustion prevented Implementer spawn, while Case K was blocked at turn start. The earlier Case J authenticated PASS covered the previous Lead-direct Tier 0 contract and is retained only as historical evidence, not as attestation of the tightened contract. Runtime Event records what actually happened; Decision Provenance records why Hybrid chose the control-flow action; Actor Artifact records what an individual worker did; Audit checks whether the recorded decisions and actions agree. Each layer stores bounded metadata only and never hidden reasoning.

## Case D

Case D is the clarification smoke. Its deterministic fixture verifies Round 0 topology confirmation, multiple one-question rounds, weakest-target recomputation, ambiguity reduction to <= 0.20, spec readiness, and pending approval.

A real live Case D is deliberately not auto-simulated because its core evidence is genuine user answers. `--live D` therefore returns `runtime-validation-pending` instead of inventing an interview.

The installed provenance API is `.hybrid/core/provenance/index.mjs`. `buildDecision()` and `validateDecision()` retain the pure schema contract. `prepareExecution()` remains pure and performs zero provenance I/O, while normal installed execution uses `prepareExecutionWithProvenance()` to persist the complete preparation decision trace best-effort. `createLeadProvenanceSession()` groups the Lead-owned decision, orchestration-event, actor-writer factory, and audit surfaces without creating a second control plane.

Central action-bearing records use `createOrchestrationEventWriter()`; public `appendRuntimeEvent()` is passive-only and rejects central decision/action ownership fields. Workers use only `createActorArtifactWriter({runId, agentRunId, runtimeRoot})`, and those self-reports remain `reported`. `runQualityClosure()` now constructs Lead-owned decision and event writers by default when callers do not inject test/custom loggers, while persistence failure remains non-fatal unless strict mode is requested. `auditDecisionTrace()` and `writeAuditArtifact()` remain deterministic derived evidence.

Run `npm run smoke:decision:preflight` / `npm run smoke:parallel-provenance:preflight` for deterministic installed checks. The corresponding `:live` commands require authenticated Codex capacity. As of 2026-09-25 both revised live attestations are pending because authenticated execution hit the account usage limit before task execution.
