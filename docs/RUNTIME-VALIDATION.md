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
- a live production-repository worktree merge/integration scenario (the isolation policy and fallback are regression-tested);
- real user-interactive Case D.

## Installer boundary

Codex CLI is not an installation prerequisite.

- CLI absent: installation succeeds; CLI-dependent validation is WARN/SKIP.
- CLI present: installer performs strict config validation and reports runtime authentication readiness.
- credentials absent: runtime is pending; installation still succeeds.
