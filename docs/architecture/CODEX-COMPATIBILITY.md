# Codex Compatibility Notes

## Pinned upstream evidence

Pinned GSD Core is `9db80da9a047ddaa9cc8812a5d6adab446fe8433`. The inspected adapter uses standalone agent TOMLs, a root `[agents]` table, and flat-dispatch-oriented configuration.

Hybrid also inspected the pinned OMC source for role semantics, planning convergence, review protocols, and deep-interview ontology behavior; Claude-specific aliases and nested Task assumptions are not copied.

## Codex 0.156.1 surface

Verified locally:

- `[agents]` and custom `[agents.<name>]` registration;
- `description` and `config_file`;
- `agents.max_concurrent_threads_per_session`;
- standalone agent `name`, `description`, and `developer_instructions`;
- repository-local skills under `.agents/skills/*/SKILL.md`;
- model override via `-m/--model`;
- reasoning override via `model_reasoning_effort`.

`max_depth = 1` is accepted by this Codex version in the framework's own config, but the installer does not inject or rewrite a target repository's `max_depth`. Flatness is enforced architecturally by lead-only dispatch plus worker no-delegation.

## Model catalog and routing

The local Codex 0.156.1 model cache reports:

- `gpt-6-luna`: `low, medium, high, xhigh, max`;
- `gpt-6-sol`: `low, medium, high, xhigh, max, ultra`.

Hybrid's operational ladder is intentionally narrower:

```text
luna_medium -> luna_high -> luna_xhigh -> luna_max
            -> sol_high -> sol_xhigh -> sol_max
```

Static role TOMLs do not pin model/effort. The lead resolves routing per stage. Role names alone do not force Sol, and a heavy stage does not make later stages sticky-heavy.

## Authenticated runtime evidence

Authenticated runtime validation is complete for:

- model-backed subagent spawn and handoff;
- sibling parallel execution (Case A);
- same-file serialization (Case B);
- conditional tester/code/security/verifier quality lanes (Case C);
- deterministic Browser Functional / Browser Adversarial role registration, routing, installer propagation, and Playwright-compatible provider contracts; these are repository-level deterministic results, not an authenticated real-browser Codex case;
- accepted Luna medium/high/xhigh/max override requests;
- bounded Luna-max security review;
- historical: deliberately rejected invalid model followed by a successful no-override session-inheritance retry; this behavior is now superseded by the explicit-model fail-closed policy, which rejects unapproved models locally and performs no model-less retry.

Codex did not expose independent serving-model attestation in these traces. Hybrid therefore records requested model/effort and acceptance/rejection/fallback evidence without claiming an independently verified backend model identity.

Real user-interactive clarification Case D remains pending by design.
