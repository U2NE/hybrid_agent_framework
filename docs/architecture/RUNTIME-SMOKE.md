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

Case C changes auth/authorization logic. Expected preflight routing for this bounded security review is Luna max for the security reviewer while routine worker/QA stages remain on lower Luna effort unless another escalation condition exists.

Case D is the clarification smoke. Its deterministic fixture starts from a deliberately vague login request and must show Round 0 topology confirmation, multiple one-question rounds, weakest-target recomputation, ambiguity reduction to <= 0.20, specReady/pass, and pending approval. The preflight asserts the report contents rather than trusting process exit status.

A real live Case D is not automatically simulated because its core behavior requires genuine user answers across rounds. `node scripts/runtime-smoke.mjs --live D` therefore reports `runtime-validation-pending` rather than faking a successful interview.

A live run is considered pending rather than failed when Codex credentials are unavailable. Config/schema validation is a separate completed check.
