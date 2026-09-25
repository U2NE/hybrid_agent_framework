# VERIFICATION — Hardening

## Deterministic

- npm run check: PASS.
- npm test: 210/210 PASS at the current model-policy/provenance hardening checkpoint.
- smoke preflight A/B/C/D: PASS.
- routing preflight: PASS.
- wiki lint: PASS.
- Codex strict doctor: ok.
- STATE recovery: hybrid-state/v1.
- diff check: PASS.

## Authenticated runtime

- Case A: semantic PASS — sibling overlap, exact outputs, flat delegation, verifier.
- Case B: semantic PASS — same-file writers serialized into separate waves, verifier PASS.
- Case C: semantic PASS — tester/code/security lanes, Luna-max security override accepted, verifier downshift to Luna medium, fresh assertions PASS.
- Routing probe: Luna high/xhigh/max requests accepted.
- Historical negative model probe: invalid override rejected; no-override session-inheritance retry succeeded under the former policy. This evidence is superseded by the current explicit-model fail-closed invariant. Current deterministic guards reject missing model, missing effort, Astra, arbitrary unknown IDs, unsupported efforts, and rejected-override fallback before unapproved subprocess execution.
- Revised Case J: authenticated semantic PASS with explicit Luna/medium outer Lead and worker route, Implementer-owned Tier 0 mutation, lightweight verification/completion, and clean audit.
- Case K: authenticated semantic PASS with one parallel parent, two disjoint Implementer children, both spawn actions before completion, explicit Luna/medium routes, reported actor artifacts, and clean audit.

## Honest boundary

- serving model identity is not independently attested;
- live real-user Case D remains intentionally pending;
- worktree isolation policy is deterministic/regression-tested but not demonstrated against a production repository merge.
