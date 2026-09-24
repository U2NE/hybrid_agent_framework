# Runtime Validation Boundary

## Verified

The following are verified against the current repository and Codex 0.156.1:

- Node syntax/config surface.
- strict Codex config loading.
- custom agent registration and standalone agent TOML shape.
- repository-local skill discovery layout and YAML frontmatter.
- current Luna/Sol concrete model IDs and supported reasoning-effort catalog.
- stage-local Luna effort routing and conditional Sol escalation.
- safe no-override session-inheritance fallback after a rejected model request.
- dependency waves, same-file serialization, cycle rejection, and risk-based isolation policy.
- state persistence/schema compatibility/fail-closed corruption handling.
- iterative OMC-style clarification state machine and ontology convergence helpers.
- planning consensus caps and acceptance-plan coverage gates.
- fresh verification with acceptance traceability.
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
- retry without model/reasoning override succeeded via session inheritance.

These observations prove request acceptance/rejection and fallback behavior. Codex did not expose independent serving-model attestation, so Hybrid does not claim the backend identity was independently verified.

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
