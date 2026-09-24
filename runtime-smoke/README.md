# Authenticated Codex Runtime Smoke

These are functional orchestration checks, not benchmarks. The three case definitions live in one place: `scripts/runtime-smoke.mjs`.

Before authentication, verify deterministic expectations:

```bash
npm run smoke:preflight
# equivalent:
node scripts/runtime-smoke.mjs --preflight
```

After a real `codex` CLI is on PATH and authenticated:

```bash
codex login
node scripts/runtime-smoke.mjs --live A
node scripts/runtime-smoke.mjs --live B
node scripts/runtime-smoke.mjs --live C
npm run smoke:worktree:live
npm run smoke:planning:live
```

Each live run creates an isolated temporary Git repository, installs Hybrid, invokes `codex exec --json`, and preserves the event log under the temporary workspace's `.planning/runtime-smoke/`.

## Case A — independent files

Two implementation tasks write different files.

Expected deterministic schedule:

```text
wave 1: alpha, beta
```

Runtime evidence to inspect:
- sibling implementer agents actually spawned;
- the two worker intervals overlapped or otherwise demonstrate concurrent sibling execution;
- both results returned to the lead;
- routine implementation requested the Luna route.

## Case B — same file

Two implementation tasks both write `src/shared.js`.

Expected deterministic schedule:

```text
wave 1: first
wave 2: second
```

Runtime evidence to inspect:
- no overlapping writer interval for `src/shared.js`;
- the second writer starts only after the first wave completes.

## Case C — security-sensitive change

The task changes authentication/authorization behavior.

Expected quality lanes:

```text
tester -> code-reviewer -> security-reviewer -> verifier
```

Expected routing:
- ordinary Implementer: Luna according to implementation difficulty.
- Tester: Luna unless independently escalated.
- Code Reviewer: raises Luna effort first; Sol is reserved for exceptional unresolved review.
- bounded Security Reviewer: Luna max.
- complex exploit/trust-boundary reasoning may enter Sol.
- routine Verifier can downshift to Luna medium after a heavier review stage.

A successful file edit alone does not prove orchestration. Review `events.jsonl` and the generated runtime smoke report before marking a live case verified.

## Case E — real worktree isolation

`npm run smoke:worktree:live` forces a two-writer wave into worktree mode. PASS requires filesystem/Git/runtime evidence rather than worker self-report: two real detached worktrees, distinct worker cwd paths, overlapping authenticated workers, owned Git patches, successful main-workspace integration, fresh verifier command evidence, cleanup of the temporary worktrees, and a final `git worktree list` containing only the main workspace. Integration conflict and ownership escape are fail-closed deterministic regressions.

## Case F — bounded planning consensus convergence

`npm run smoke:planning:live` creates a disposable planning fixture whose revision 1 has one real acceptance-coverage gap. Planner produces the immutable plan revision; Architect and Plan Auditor independently review the same exact-byte SHA256 snapshot in read-only mode; any non-APPROVE council verdict returns the findings to Planner for a new revision. The loop is bounded by the normal complex-planning limit.

PASS requires a real initial objection, deterministic SPEC coverage on the corrected plan, identical revision hashes for both reviewers, overlapping independent review intervals, no recursive delegation, both final reviewers returning APPROVE on the same revision, a clean planning repository, and a final state of `pending-user-approval` with `executionApproved=false`.
