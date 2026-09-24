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
- Security Reviewer: Sol.
- Code Reviewer: Sol for the security-sensitive review.
- routine Tester/Verifier: Luna.
- ordinary Implementer: Luna unless the implementation itself is complex cross-module debugging.

A successful file edit alone does not prove orchestration. Review `events.jsonl` and the generated runtime smoke report before marking a live case verified.
