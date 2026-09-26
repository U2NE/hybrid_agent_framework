# VERIFICATION — Hardening

Current runtime-code baseline: `architecture-v2-hardening` at `233a831af8863f9f7b42a606c95ef6a86002cdc0`.

## Deterministic

- `npm run check`: PASS.
- `npm test`: 352/352 PASS at the current execution-authority hardening checkpoint.
- `npm run test:unit`: 121/121 PASS.
- smoke preflight A/B/C/D: PASS.
- routing preflight: PASS.
- wiki lint: PASS.
- Codex strict doctor: latest recorded strict-config validation is ok.
- STATE recovery: `hybrid-state/v1`.
- `git diff --check`: PASS at the runtime-code checkpoint.

## Execution authority hardening

- Sealed execution uses `hybrid-exec-graph/v4`. Each executable task node carries the deterministic scheduler-selected `isolationMode`; a supplied isolation plan must exactly match a fresh scheduler calculation or sealing fails closed.
- Durable task leases bind run/revision/descriptor/task/attempt, capability grant, effect policy, task contract, and the sealed isolation mode. Dispatch authorization is reconstructed from and compared against the durable lease, so caller-side authority or isolation substitution fails closed.
- Initial graph binding, graph advancement, and lease acquisition share the lease-store revision fence. Active old-revision leases block graph publication until they are evidence-bound terminal or reconciled and released.
- A new terminal transition requires the exact active durable dispatch authorization and lease. Terminal outcomes are cross-process fenced so one descriptor/revision/task/attempt cannot acquire competing completion/abort outcomes; released authority may replay only its already persisted terminal record.
- Lease release is evidence-bound to a durable terminal transition. Raw token-only/null-result release is not an accepted execution path.
- Under `worktree` isolation, both ordinary `task_completed` and recovery `recovered_task_completed` require completed durable integration evidence for the exact run/revision/descriptor/task/attempt/lease, with base HEAD and final main-workspace hash still matching. A worker return or detached patch alone is not completion authority.
- `recovered_task_completed` is recovery-only and is rejected for `current-workspace`. `ExecutionRunStore.recoverTaskLease()` revalidates worktree integration evidence before terminal commit and release.
- Under `current-workspace`, the repository-global mutation guard still fences writes to the sealed write set and treats `WRITE_SET_VIOLATION` / `WORKSPACE_BASE_MOVED` as reconciliation-required; guard completion alone does not authorize lease release.

## Authenticated runtime

- Case A: semantic PASS — sibling overlap, exact outputs, flat delegation, verifier.
- Case B: semantic PASS — same-file writers serialized into separate waves, verifier PASS.
- Case C: semantic PASS — tester/code/security lanes, Luna-max security override accepted, verifier downshift to Luna medium, fresh assertions PASS.
- Routing probe: Luna high/xhigh/max requests accepted.
- Historical negative model probe: invalid override rejected; no-override session-inheritance retry succeeded under the former policy. This evidence is superseded by the current explicit-model fail-closed invariant. Current deterministic guards reject missing model, missing effort, Astra, arbitrary unknown IDs, unsupported efforts, and rejected-override fallback before unapproved subprocess execution.
- Revised Case J: authenticated semantic PASS with explicit Luna/medium outer Lead and worker route, Implementer-owned Tier 0 mutation, lightweight verification/completion, and clean audit.
- Case K: authenticated semantic PASS with one parallel parent, disjoint child tasks `A` / `B`, both spawn actions before the first completion, explicit Luna/medium outer/worker requests, reported per-worker actor artifacts, exact textual `A1` / `B1` fixture contents with either no final line terminator or one final LF/CRLF, unchanged installed core, no Lead target mutation, and a clean audit.

## Honest boundary

- serving model identity is not independently attested;
- live real-user Case D remains intentionally pending;
- worktree create/integrate/restart/rollback/recovery behavior is exercised by deterministic Git-backed regression fixtures, but it has not been demonstrated against a production repository merge.
