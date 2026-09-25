# Review lanes

Hybrid separates independent review responsibilities so quality checks do not collapse into one generic reviewer.

## Tester

The Tester is read-only and produces executable evidence against acceptance criteria and relevant edge cases. It does not accept Implementer claims as proof.

## Code Reviewer

The Code Reviewer is read-only and evaluates:

- SPEC and acceptance compliance;
- correctness, control flow, and data flow;
- error paths and regression risk;
- maintainability;
- security-adjacent concerns that should be handed to the dedicated security lane when material.

Its primary question is: **does the implementation correctly satisfy the approved contract?**

## Adversarial Reviewer

The Adversarial Reviewer is read-only and deliberately searches for counterexamples rather than re-performing ordinary code review.

It targets:

- invariant violations;
- boundary and malformed-input cases;
- state-transition errors;
- concurrency/interleaving hazards;
- retry and idempotency faults;
- stale-state assumptions;
- partial failure and rollback/recovery gaps;
- integration seams and neighboring regressions.

Its primary question is: **under what concrete conditions can this implementation break even if the happy path and ordinary review look correct?**

The adversarial lane is always present for Tier 2/3 work and may be activated for bounded work by explicit high-regression-risk signals such as concurrency-critical, data-integrity, or failure-prone boundaries. It is not part of the routine Tier 0/1 fast path.

## Conditional specialist reviewers

- Design Reviewer checks approved UI/design contracts and visual/accessibility evidence only when the design lane is active.
- Security Reviewer checks trust-boundary-sensitive changes only when the security trigger is active.

Neither specialist substitutes for ordinary correctness review.

## Final Verifier

The Verifier remains independent and read-only. It binds fresh implementation/test/review evidence to every acceptance criterion and the current integrated snapshot. Reviewer findings do not directly authorize patches; the Lead schedules a targeted repair worker when a real defect is found.

This separation preserves two properties:

1. review agents cannot silently mutate the artifact they judge;
2. additional model cost is paid only when the task tier or explicit risk signals justify the extra lane.
