# Model Routing

## Policy

Hybrid routes each stage through a concrete model + reasoning-effort level defined in one place:

`core/routing/model-routing.json`

The current ladder is:

```text
luna_medium  -> gpt-6-luna / medium
luna_high    -> gpt-6-luna / high
luna_xhigh   -> gpt-6-luna / xhigh
luna_max     -> gpt-6-luna / max
sol_high     -> gpt-6-sol  / high
sol_xhigh    -> gpt-6-sol  / xhigh
sol_max      -> gpt-6-sol  / max
```

The local Codex 0.156.1 model catalog was re-checked before defining the policy. It reports Luna support for `low/medium/high/xhigh/max` and Sol support for `low/medium/high/xhigh/max/ultra`. Hybrid deliberately uses the narrower ladder above.

## Stage-local selection

A task does not mechanically execute every rung. Each stage starts at the appropriate level from its own context.

- routine implementation/test/verification: Luna medium;
- moderately difficult planning/debugging/review: Luna high;
- complex cross-module reasoning and ordinary architecture/audit: Luna xhigh;
- important architecture, bounded security review, high ambiguity: Luna max;
- Luna capability exhausted, unresolved architecture, or complex exploit/trust-boundary reasoning: Sol high;
- critical unresolved reasoning: Sol xhigh;
- extreme unresolved reasoning: Sol max.

Role names do not force Sol. In particular, Architect, Plan Auditor, and Security Reviewer begin on Luna unless the actual stage context justifies Sol.

Routing is recomputed after every stage. A Sol stage therefore does not make later routine implementation or verification sticky-Sol.

## Failure-driven escalation

Verification/debugging history raises reasoning budget conservatively:

1. first failure: raise effort within the same family;
2. repeated failure: use Luna max before considering Sol;
3. repeated same failure after Luna max / explicit Luna-max failure: enter Sol high;
4. subsequent Sol failures may raise Sol effort;
5. the bounded fix loop remains the outer retry limit.

A single test failure is never sufficient by itself to jump from Luna to Sol.

## Runtime application

Standalone role TOMLs contain no static `model` or `model_reasoning_effort`. The lead applies the route per spawn.

Current Codex 0.156.1 surface:

- model override: `-m/--model`;
- reasoning override: config key `model_reasoning_effort`.

If the requested model or effort cannot be used, the spawn is retried without model/effort override and the route records `session-inheritance`. Hybrid never invents a replacement model ID.

## Runtime catalog evidence

At the time of this policy revision the installed model cache reports:

```text
gpt-6-luna
  default: medium
  supported: low, medium, high, xhigh, max

gpt-6-sol
  default: medium
  supported: low, medium, high, xhigh, max, ultra
```

Both report reasoning-effort updates as supported.
