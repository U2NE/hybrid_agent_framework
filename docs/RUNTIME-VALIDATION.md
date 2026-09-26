# Runtime Validation Boundary

## Verified

The following are verified against the current repository and Codex 0.156.1:

- Node syntax/config surface.
- strict Codex config loading.
- custom agent registration and standalone agent TOML shape.
- repository-local skill discovery layout and YAML frontmatter.
- current Luna/Sol concrete model IDs and supported reasoning-effort catalog.
- stage-local Luna effort routing and conditional Sol escalation.
- explicit allowlisted model + reasoning-effort enforcement with fail-closed rejection before subprocess spawn; session/default inheritance is prohibited.
- dependency waves, same-file serialization, cycle rejection, and risk-based isolation policy.
- state persistence/schema compatibility/fail-closed corruption handling.
- iterative OMC-style clarification state machine and ontology convergence helpers.
- planning consensus caps and acceptance-plan coverage gates.
- fresh verification with acceptance traceability.
- tier/risk-aware evidence-gated completion, structured proof gaps, and implementer self-claim rejection.
- bounded repair finding policy/fingerprinting/targeted packets with existing failure-driven routing.
- deterministic shared context snapshot/cache invalidation and safe cache-miss fallback outside tracked project state.
- proof-gap-only process/HTTP/browser acquisition; browser-required gaps auto-wire the bounded Playwright-compatible provider, while a UI file change alone does not force browser execution. Browser Functional and Browser Adversarial lanes are deterministically covered for activation, safe interaction, installer propagation, CLI fail-closed behavior, and verifier reassessment; no real-browser live smoke is claimed because this repository does not contain Playwright/browser binaries.
- passive redacted JSONL observability with non-fatal storage failure and no agent/LLM call.
- deterministic Decision Provenance schema, stable decision IDs, recursive sanitizer, role-separated writers, action linkage, actor artifacts, and audit findings. Decision artifacts contain bounded facts and policy/control-flow choices only.
- conditional security activation and false-positive controls.
- installer behavior with and without Codex CLI, including target agent/config preservation.
- wiki lint/query/ingest.

## Authenticated runtime evidence

### Case A — sibling parallelism

Semantic PASS.

- two independent implementation workers were observed running at the same time;
- both were direct children of the lead;
- both produced the exact requested files;
- both requested `gpt-6-luna / medium` and the spawn requests were accepted;
- no recursive delegation was observed;
- an independent verifier completed successfully.

Latest observed wall time was about 164 seconds. This is a functional smoke, not a benchmark.

### Case B — same-file serialization

Semantic PASS.

- two tasks targeted the same file;
- scheduler planned two separate waves;
- wave 1 completed before wave 2 started;
- both final changes were present;
- an independent verifier re-imported the result and checked exact exports;
- no recursive delegation was observed.

Observed wall time was about 179 seconds.

### Case C — security quality lanes and downshift

Semantic PASS.

- the auth/authorization change activated security review;
- implementer ran first;
- tester, code reviewer, and security reviewer ran as independent QA workers;
- security reviewer requested `gpt-6-luna / max`, and that override request was accepted;
- verifier subsequently requested `gpt-6-luna / medium`, demonstrating stage-local downshift after the heavier security stage;
- verifier ran fresh assertions and passed;
- all workers remained direct children of the lead.

Observed wall time was about 197 seconds.

### Routing probe

Authenticated PASS.

- explicit `gpt-6-luna / high` request accepted;
- explicit `gpt-6-luna / xhigh` request accepted;
- explicit `gpt-6-luna / max` request accepted;
- intentionally invalid model request rejected;
- historically, the subsequent no-override retry succeeded via session inheritance.

That final fallback observation is historical evidence for the superseded policy, not the current contract. The current deterministic guard rejects invalid, unknown, missing-model, missing-effort, and unsupported-effort invocations before an unapproved subprocess can start, and a rejected allowed override is not retried model-less. Codex did not expose independent serving-model attestation, so Hybrid does not claim the backend identity was independently verified.

### Case E — worktree isolation lifecycle

Authenticated semantic PASS.

The scheduler selected `mode=worktree` for a forced-risk two-writer wave. Hybrid's minimal worktree runtime bridge then:

- created two real detached Git worktrees from one clean baseline commit;
- ran two authenticated Luna-medium workers concurrently with different worktree cwd paths;
- observed no recursive delegation;
- collected Git patches only from each task's declared file ownership;
- integrated both patches into the main workspace with `git apply --check` before application;
- ran an independent authenticated Luna-medium verifier against the integrated main workspace and captured a successful fresh command event;
- removed both temporary worktrees, pruned Git worktree metadata, and verified that `git worktree list` contained only the main workspace afterward.

The deterministic bridge tests also prove ownership escape is rejected before integration and an integration conflict rolls the main workspace back instead of silently overwriting.

This is a disposable smoke repository, not a claim that an arbitrary production repository merge is risk-free.

### Case F — bounded planning consensus convergence

Authenticated semantic PASS.

The smoke began from a plan with a deterministic SPEC coverage defect: the rollback acceptance criterion had no task. It then exercised the real bounded consensus loop:

- Planner produced revision 1.
- Architect and Plan Auditor reviewed the same committed revision-1 file bytes independently and concurrently, with the exact SHA256 bound into both reviews.
- Both reviewers returned `ITERATE` for the real rollback omission; neither modified the plan or delegated.
- Planner alone synthesized both reviews into revision 2.
- Revision 2 mapped every SPEC acceptance criterion verbatim, added the isolated rollback task, exact file ownership, automated verification, and dependencies on both v2 behavior tasks.
- Architect and Plan Auditor independently reviewed the same revision-2 hash and both returned `APPROVE` with no findings.
- Consensus ended at `pending-user-approval` with `approved=true`, `executionApproved=false`, no remaining objections, and a clean disposable repository.

The deterministic tests additionally prove that exit-zero/fake-success reports are rejected, immutable revision/hash mismatches are rejected, and an Architect `ITERATE` blocks approval even when the Auditor approves.

This validates convergence semantics, not permission to execute the resulting plan.

### Generic quality-closure integration

Deterministic integration PASS.

`runQualityClosure()` is exported from `core/orchestrator/index.mjs`, installed into target repositories under `.hybrid/core/orchestrator/`, and is the reusable post-integration primitive referenced by the Hybrid skill/installed AGENTS contract. It composes the existing QA callbacks, `runRepairConvergence()`, evidence completion gate, proof adapters, conditional shared-context cache, and passive observability without introducing a new agent role or canonical state. Normal no-defect/no-gap tests record zero repair calls, zero proof-acquisition calls, zero extra verifier calls, and zero browser calls. When a closure has an explicit current snapshot, verifier-assessed/verified runtime evidence is accepted only when `evidence.snapshot` exactly matches that snapshot; missing or stale bindings remain a proof gap. Snapshot-agnostic legacy behavior is retained only when no current snapshot context exists, and Tier 0 lightweight completion is unchanged.

### Case G — review → repair → review convergence

Authenticated semantic PASS through the framework-source generic `runQualityClosure()` production primitive. This case validates primitive behavior directly; it does not by itself attest installed-Lead wiring.

- the disposable R1 fixture contained an objectively reproducible null-input defect; the focused Node test exited nonzero with a `TypeError`;
- independent authenticated Tester and Code Reviewer workers overlapped, ran the focused test, and both reported the same blocking `AC-001` defect with concrete evidence;
- because independent QA already established a blocking defect, Hybrid skipped an otherwise redundant pre-repair verifier call;
- the lead sent a targeted repair packet back to the `implementer` owner, which changed only `src/user.js`;
- the Git snapshot changed from R1 to R2 and direct focused tests passed after repair;
- impacted Tester and Code Reviewer lanes reran after R2 and returned clean results;
- a fresh independent Luna-medium Verifier ran after repair, executed the focused test, and returned PASS;
- one repair cycle was used, below the hard cap of three; no recursive delegation was observed.

The semantic validator rejects exit-zero-only reports and requires the original defect, QA finding/evidence, implementation-owner repair, changed snapshot, post-fix QA, fresh command-backed verifier evidence, and final behavior.

### Case H — proof-gap QE without a QE agent

Authenticated semantic PASS through the framework-source generic `runQualityClosure()` production primitive. This case validates primitive behavior directly; it does not by itself attest installed-Lead wiring.

- the initial completion gate refused to verify `AC-001` because required CLI runtime proof was absent;
- the first authenticated Luna-medium Verifier evaluated only supplied evidence, executed no command, and returned `FAIL / PROOF_GAP`;
- Hybrid used the deterministic process adapter—not an agent and not a browser—to execute the real CLI;
- fresh raw structured evidence recorded exit 0 and stdout exactly `hello Alice`, but remained `assessed=false, verified=false`;
- the second authenticated Verifier explicitly consumed the exact acquired `evidenceId` and semantically assessed the output;
- only after that assessment did the same evidence become verified and the post-proof completion gate PASS;
- negative deterministic regressions prove exit 0 + `hello Bob`, missing second verifier, or a verifier that does not consume the acquired evidence ID cannot PASS;
- `qeAgentsSpawned=0` and `browserUsed=false`.

This proves conditional proof acquisition. It does not imply that browser proof can be replaced by CLI proof when browser interaction is intrinsic to the acceptance criterion; an unavailable required browser provider remains a proof gap.

### Case I — installed Lead production-primitive attestation

Authenticated semantic PASS in a real disposable installed project.

- the smoke created and initialized a temporary Git repository, installed Hybrid through the real installer, and committed the baseline before Lead execution;
- the authenticated Codex Lead ran with the disposable project as its working directory and followed the installed `AGENTS.md` / Hybrid skill contract;
- the framework smoke harness did not import or call framework-source `runQualityClosure()` directly;
- the Lead-created action imported `runQualityClosure` from `../.hybrid/core/orchestrator/index.mjs`, and installed-core integrity remained unchanged;
- passive runtime artifacts contained five lifecycle events: QA start/end, Verifier start/end, and `completion` PASS; each event identified `primitive: "runQualityClosure"` and carried the expected integrated snapshot;
- the semantic validator requires the actual Lead action command to exit zero, rejects framework-source bypass, rejects fake success with no events, rejects a missing completion event, and rejects recursive `spawn_agent` delegation;
- exit code 0 or a Lead success claim without the installed runtime artifacts cannot PASS.

Case I attests the installed Hybrid contract → installed production primitive → emitted quality lifecycle boundary. It does not attest every future arbitrary Lead behavior or the backend serving-model identity.

### Case J — installed Decision Provenance

The tightened Case J contract now requires the normal Tier 0 path to persist preparation automatically and delegate task-owned mutation to an actual Implementer. Semantic PASS requires Tier 0 classification, Implementer activation, a `spawn_implementer` decision linked to observed/derived Lead-owned spawn and completion events, one reported worker actor artifact, lightweight verification, final completion provenance, and `audit.json` with `audit.ok === true`. A contradictory `lead_direct_execution` record or Lead-owned task mutation is a failure.

The revised deterministic preflight PASSes and rejects exit-zero without decisions, missing/orphaned actions, decision-ID mismatch, Lead implementation bypass, missing worker artifact, worker self-report upgraded to observed, missing/failed audit, missing completion, missing artifact-backed Implementer execution, framework-source bypass, installed-core mutation, and prohibited prompt/hidden-reasoning/raw-source capture.

Authenticated revised Case J now PASSes. The outer installed Lead explicitly requested `gpt-6-luna` with medium reasoning effort, invoked `prepareExecutionWithProvenance()`, preserved the preclassified Tier 0 fixture, and persisted the preparation trace. The Implementer dispatch decision and spawn action both recorded the policy-derived Luna/medium route; the worker changed only `README.md` and wrote a reported actor artifact. Linked completion, lightweight verification, final completion provenance, installed-core integrity, and `audit.json` all validate cleanly, with no Lead-owned target mutation. The Codex stream did not independently expose a native worker identifier, so the worker remains explicitly `framework-logical`; the evidence attests accepted explicit model requests, not backend serving identity.

The four record types remain distinct: Runtime Event = what happened; Decision Provenance = why Hybrid selected that control-flow action; Actor Artifact = what a specific worker did; Audit = whether the recorded decisions and actions agree. None records hidden chain-of-thought. Writer isolation is enforced by API shape: workers receive a writer bound to their own actor artifact, not the central decision writer. This does not claim an OS sandbox against a hostile process. The audit evaluates declared events, ownership, attribution, and evidence linkage; it cannot detect a filesystem mutation that was never reported through the runtime boundary.

### Case K — parallel installed Decision Provenance

Case K adds a disposable installed project with an already-approved two-task plan: task A owns `src/a.txt`, task B owns `src/b.txt`, both are independent and therefore one parallel wave. Deterministic preflight PASS requires one `parallel_wave` parent, two distinct `spawn_implementer` children with the same `waveId` and correct `parentDecisionId`, both spawn actions before the first completion, distinct worker identities, Lead-owned linked spawn/completion events, reported per-worker actor artifacts, exact file ownership, installed API use, installed-core integrity, and a clean audit. Negative fixtures cover a missing child, serialized rather than parallel dispatch, spawn without decision, orphan worker artifact, Lead mutation bypass, cross-write, worker central writes, fabricated observed attribution, missing/failed audit, installed-API bypass, framework-source bypass, and installed-core mutation.

Authenticated Case K now PASSes. The outer Lead explicitly requested `gpt-6-luna` / medium. The installed runtime persisted one `parallel_wave` parent and child IDs `A` and `B`, with distinct framework-logical worker IDs and disjoint ownership of `src/a.txt` and `src/b.txt`. Both Luna/medium spawn actions were recorded before the first completion action, both workers produced reported actor artifacts, both files reached the exact textual fixture contents `A1` and `B1` with either no final line terminator or one final LF/CRLF, no Lead target mutation was observed, installed core remained unchanged, and the deterministic audit reports `ok: true` with no findings.

## Still intentionally pending

### Case D — real user-interactive clarification

The deterministic Case D fixture is verified:

- Round 0 topology confirmation;
- multiple one-question rounds;
- weakest-target recomputation;
- ambiguity reduction to `0.18 <= 0.20`;
- `specReady=true`;
- approval remains pending.

A real live Case D is intentionally not auto-simulated because its core evidence is genuine user answers over multiple rounds. `--live D` therefore reports `runtime-validation-pending` rather than inventing an interview.

## Remaining evidence boundary

The following are not claimed:

- independent serving-model identity attestation beyond accepted model/effort requests;
- real user-interactive Case D.

## Installer boundary

Codex CLI is not an installation prerequisite.

- CLI absent: installation succeeds; CLI-dependent validation is WARN/SKIP.
- CLI present: installer performs strict config validation and reports runtime authentication readiness.
- credentials absent: runtime is pending; installation still succeeds.
