# Authenticated Codex runtime smoke

This is a functional orchestration smoke, not a GSD/OMC/Hybrid benchmark.

Before authentication, run:

```bash
npm run smoke:preflight
```

The deterministic preflight proves the framework-side invariants only. It does not prove Codex actually spawned subagents.

After `codex doctor --json` reports credentials ready, run one live case at a time:

```bash
node scripts/runtime-smoke.mjs --live A
node scripts/runtime-smoke.mjs --live B
node scripts/runtime-smoke.mjs --live C
```

Each live run creates an isolated temporary Git repository, installs Hybrid there, runs `codex exec --strict-config --json`, and preserves the raw JSONL trace plus stderr under that temporary repo's `.planning/runtime-smoke/`.

Case A uses two independent files. Expected runtime evidence is two sibling implementation workers eligible in the same wave, with no worker-to-worker recursive delegation.

Case B creates two distinct tasks that both modify `src/shared.js`. Expected runtime evidence is two scheduler waves and no concurrent same-file writers.

Case C changes auth/authorization logic. Expected runtime evidence is tester, code reviewer, security reviewer, and verifier activation; the security reviewer is routed to Sol while routine worker/QA stages use Luna unless another escalation condition exists.

A live run is considered pending rather than failed when Codex credentials are unavailable. Config/schema validation is a separate completed check.
