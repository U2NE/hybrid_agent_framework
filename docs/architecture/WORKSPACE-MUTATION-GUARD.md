# Current-workspace mutation guard

Hybrid has two mutation isolation paths:

- **worktree mode**: each writer produces an observed patch and `collectWorktreeResults()` rejects changed files outside declared ownership;
- **current-workspace mode**: a durable mutation guard snapshots repository state before the worker and validates the worker's observed final delta before completion is accepted.

The current-workspace guard closes the same post-execution write-set boundary for tasks that do not need a detached worktree.

## Required execution order

For a mutating task scheduled in `current-workspace` mode:

```text
sealed execution graph
  -> durable resource lease acquire
  -> workspace-guard begin
  -> worker spawn
  -> workspace-guard complete
  -> task completion evidence / verification
  -> lease release
```

A worker may not start before both the resource lease and workspace guard are active. A task may not be treated as successfully completed, and its lease should not be released, before guard completion succeeds.

Installed CLI:

```text
node .hybrid/bin/hybrid.mjs workspace-guard begin <run-id> <authorization.json> [project-root]
node .hybrid/bin/hybrid.mjs workspace-guard complete <run-id> <authorization.json> [project-root]
node .hybrid/bin/hybrid.mjs workspace-guard status [project-root]
```

The same active dispatch authorization returned by the lease layer controls the guard. A tampered or released authorization cannot begin or complete it.

## Repository-global single writer

The active guard is stored under the Git common directory:

```text
.git/hybrid/current-workspace/current.json
```

It is repository-global, not run-local. Therefore two separate Hybrid runs cannot both claim the same current workspace for mutation at the same time.

Successful histories are retained at:

```text
.git/hybrid/current-workspace/history/<guard-id>.json
```

The deterministic guard ID binds run, graph descriptor/revision, task attempt, durable lease, and lease request fingerprint. A completed attempt cannot silently begin again.

This single-writer rule is intentional. Parallel mutating siblings use worktree isolation; the shared current workspace is reserved for an attributable single mutator.

## Baseline and observed delta

`begin` captures:

- repository `HEAD`;
- every tracked path currently different from `HEAD`;
- every non-ignored untracked path;
- per-path fingerprints covering Git binary diff plus file/symlink state.

Existing dirty state is therefore allowed as baseline evidence. A pre-existing dirty file is not attributed to the worker if its fingerprint remains unchanged.

At `complete`, Hybrid captures the same snapshot again and computes only paths whose fingerprints changed relative to the baseline.

The allowed file set is the sealed graph node's `writes` set, which includes `files_modified` plus any explicit file writes.

The invariant is:

```text
observed_changed_paths ⊆ sealed_task_writes
```

An outside path fails with:

```text
WRITE_SET_VIOLATION
```

The guard remains active and records the observed violation instead of widening ownership or destroying evidence. If the outside modification is reverted, the same authorized attempt may run `complete` again; successful reconciliation then records only the remaining approved delta.

## HEAD movement

If `HEAD` changes while the guard is active, completion fails with:

```text
WORKSPACE_BASE_MOVED
```

The guard remains in `reconcile-required` state. Hybrid does not guess whether an unexpected commit is safe.

## Scope

The guard observes **Git-visible repository mutations**: tracked changes and non-ignored untracked files/symlinks. It is not a general-purpose operating-system filesystem sandbox. Ignored caches, build scratch space, external services, and non-repository side effects remain governed by role capabilities, sandboxing, semantic resource leases, effect policy, and verification.

For mutations whose ownership cannot be confidently represented as exact repository paths—generated trees, migrations, formatters, lockfiles, or multiple concurrent writers—scheduler isolation should use worktrees rather than weakening the current-workspace guard.
