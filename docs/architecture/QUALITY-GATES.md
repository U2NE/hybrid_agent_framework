# Planning and Quality Gates

## Tier-aware planning

Hybrid does not run consensus planning for Tier 0/1.

Tier 2 uses Planner by default. Architect and Plan Auditor are added only for real architecture/security/risk. The consensus policy records the required reviewer set explicitly; the normal council requires both `architect` and `plan-auditor`. When council review is active, a missing required reviewer or any non-APPROVE required verdict cannot approve the plan; both reviewers must APPROVE the same fixed revision before the plan can become pending user approval. Ordinary complex convergence is bounded to 3 iterations.

Tier 3/high-risk uses the same closed loop with a maximum of 5 iterations. At the cap without approval, Hybrid retains the best plan and remaining objections, records `consensus-not-reached`, and does not execute.

Even an approved consensus plan is only `pending-user-approval`; explicit execution approval is a separate transition.

## High-risk deliberation

High-risk consensus plans carry compact RALPLAN-style decision quality rather than full upstream prompt bulk:

- 3-5 Principles;
- top Decision Drivers;
- at least two viable options when meaningful, or explicit invalidation rationale;
- real trade-offs;
- deliberate mode: 3-scenario pre-mortem;
- deliberate test strategy: unit / integration / e2e / observability;
- ADR: Decision / Drivers / Alternatives / Why chosen / Consequences / Follow-ups.

Architect and Plan Auditor inspect the same fixed plan revision independently. Their outputs combine only during Planner revision.

## Plan audit

Plan Auditor checks:

- SPEC and acceptance coverage;
- explicit and hidden assumptions;
- dependencies and handoffs;
- exact file references;
- file ownership conflicts;
- executor feasibility;
- acceptance testability;
- rollback/recovery risk;
- ambiguous steps;
- missing applicable edge cases;
- concrete verification.

High-risk review additionally checks pre-mortem quality, alternative fairness, principle-option consistency, risk mitigation, and verification strength.

## Acceptance trace

Complex work is goal-backward:

`SPEC acceptance criterion -> PLAN task -> implementation evidence -> independent verification evidence`

Every criterion receives a stable `AC-NNN` trace row. A criterion with no plan coverage is `MISSING`. Implementation or verification evidence that is incomplete is `PARTIAL`. Final PASS requires every criterion to be `VERIFIED`.

Completion depth is tier/risk aware rather than uniformly expensive: Tier 0 uses fresh minimal evidence, Tier 1 targeted evidence, and Tier 2/3 full independent evidence. Runtime interaction is required only when the criterion semantics cannot be established by the existing cheaper evidence. An implementer completion claim is never sufficient evidence by itself.

## Verification

Final verification requires fresh post-implementation test output. Build, typecheck, and lint are required when applicable. The verifier also checks regression risk and alignment with the original SPEC goal.

Stale implementer claims are not evidence. Any PARTIAL/MISSING acceptance row blocks PASS.

A failing criterion is classified before escalation:

- real blocking/critical/high defect, acceptance failure, or correctness-impacting medium finding → `FIX_REQUIRED`;
- missing required proof with no demonstrated defect → `PROOF_GAP`;
- low/style/nit → record if useful, but do not auto-repair.

`FIX_REQUIRED` returns a small finding/evidence/file/symbol/expected-behavior/verification packet to the implementation owner. Reviewers remain read-only. Repair is capped at three cycles and repeated finding fingerprints reuse the existing failure-driven Luna→Sol routing.

`PROOF_GAP` does not spawn a QE agent. Hybrid selects the cheapest semantically adequate deterministic proof: existing/focused command or test, CLI/process, HTTP, then a configured browser provider only when required. If required proof cannot be acquired, the criterion remains unverified. After proof acquisition the Verifier reassesses the affected evidence; ordinary tasks with no gap get no extra verifier call.

## Security activation and review

Security activation separates strong triggers from weak/contextual hints.

Strong examples include authentication/authorization, JWT/session, crypto, SQL query changes, uploads, payments, secret/token handling, permission enforcement, trust boundaries, XSS/SSRF/injection.

Weak words such as `network`, `secret`, `token`, or `permission` do not activate review when they occur only in documentation, labels, locales, or unrelated prose. Weak hints need code/enforcement context.

Security Reviewer applies only relevant checks across auth/authz, validation, injection, XSS, SSRF/network trust, crypto, secrets, uploads, payments, dependencies, and configuration. Findings are prioritized by severity x exploitability x blast radius.

## Edge probes

Edge probes are applicability-aware. Hybrid infers relevant axes from the requirement domain and gates only those axes:

- boundary;
- empty state;
- ordering;
- precision;
- idempotency;
- concurrency;
- error behavior.

For example, concurrent retryable writes require concurrency/idempotency/error handling; a deterministic sort requires ordering/error handling. Unrelated axes are not forced onto bounded work.
