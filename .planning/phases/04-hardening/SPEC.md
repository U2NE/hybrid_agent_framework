# SPEC — Hybrid Hardening

## Goal

Reduce orchestration cost for small work while strengthening planning/review/verification evidence for complex work, without replacing the existing Hybrid architecture.

## Acceptance Criteria

- Luna effort ladder is used before Sol escalation.
- Role names alone do not force Sol.
- Installer preserves target-owned agents and max_depth.
- Tier 0/1 avoid routine QA fan-out.
- Worker context reduction preserves critical sections.
- Risky parallel writers use isolation or safe serialization.
- Planning consensus is bounded and cannot false-approve.
- Security activation avoids weak keyword false positives.
- Every acceptance criterion can trace through plan, implementation, and verification.
- Ontology convergence is available only when domain scope is unstable.
- Runtime smoke validates semantics, not exit code.
- Authenticated A/B/C and routing/fallback probes are recorded honestly.
- Existing regression suite remains green.
