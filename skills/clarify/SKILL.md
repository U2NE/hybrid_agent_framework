---
name: clarify
description: Clarify ambiguous development requests with scout-first topology confirmation, weighted ambiguity scoring, assumptions, non-goals, acceptance criteria, and edge-case probes.
---

# Clarify

Classify the request first. Do not interview Tier 0 trivial work. For brownfield work, dispatch Scout before asking questions.

For complex or ambiguous work:
1. Confirm top-level topology.
2. Score goal, boundary, constraint, and acceptance clarity.
3. Expose assumptions and non-goals.
4. Probe boundary, empty state, ordering, precision, idempotency, concurrency, and error behavior.
5. Ask about the weakest dimension until ambiguity <= 0.20 and all dimension floors pass.
6. Write the active phase SPEC.md with Goal, Topology, Constraints, Non-goals, Acceptance Criteria, Resolved assumptions, Technical context, Relevant code, and Edge cases.
7. Obtain user approval before implementation when the work materially changes scope or architecture.
