# VERIFICATION — Hardening

## Deterministic

- npm run check: PASS.
- npm test: 114/114 PASS at checkpoint 4.
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
- Negative model probe: invalid override rejected; no-override session-inheritance retry succeeded.

## Honest boundary

- serving model identity is not independently attested;
- live real-user Case D remains intentionally pending;
- worktree isolation policy is deterministic/regression-tested but not demonstrated against a production repository merge.
