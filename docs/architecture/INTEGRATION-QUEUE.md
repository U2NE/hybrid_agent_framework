# Durable integration queue

Parallel workers may execute concurrently, but their writes are integrated through exactly one deterministic queue.

## Ordering

The scheduler orders ready tasks lexicographically by task ID. Worktree integration independently re-establishes that same lexical task-ID order from the wave handle, so worker completion order cannot change the final patch order.

Before integration, every result must match exactly one worktree task. The patch file is re-read and its byte length and SHA-256 hash are checked against the observed handoff. A changed patch is rejected before it can touch the main workspace.

## Single writer

Each queue has a PID-owned lock. Concurrent integration callers serialize on that lock. After the first caller finishes, the next caller replays the completed journal rather than applying the patches again.

Dead PID locks are reclaimed. A malformed/ownerless lock is reclaimed only after a stale-age bound so an active integration cannot be stolen casually.

## Durable journal

The journal is stored under the repository Git common directory, not in the working tree:

```text
.git/hybrid/integration/<queue-id>.json
```

The queue ID is a SHA-256 digest of:

- base commit;
- run/revision/graph identity when available;
- deterministic task order;
- each observed patch hash, size, and changed-file set.

Each applied record binds the task, patch, base commit, changed files, and an observed SHA-256 workspace snapshot. The snapshot covers both the full binary tracked diff against `HEAD` and a deterministic manifest of every untracked file or symlink, including a content/target hash, so newly created files cannot disappear from crash-recovery evidence.

## Crash windows

Before a patch is applied, the journal is fsynced with status `applying` and the pre-apply workspace hash.

After restart:

- if the workspace still equals the pre-apply hash, the patch was not applied and execution resumes normally;
- if the workspace changed and `git apply --reverse --check` proves the exact in-flight patch is present, the framework records that patch as recovered and continues without duplicate application;
- if neither state can be proven, integration stops with `WORKTREE_INTEGRATION_RECONCILE_REQUIRED`.

A completed queue is replayable only while the current workspace hash matches its recorded final snapshot.

## Conflict behavior

Patch conflicts or apply failures roll the integration workspace back to the original base commit and persist a `rolled-back` journal state. There is no silent conflict resolution.

Unexplained workspace drift is different: the framework does not destroy evidence by resetting it. It fails closed for reconciliation.

This gives the parallel execution path a deterministic boundary:

```text
parallel worktrees
  -> observed patch handoffs
  -> deterministic durable integration queue
  -> integrated snapshot
  -> independent verification
```
