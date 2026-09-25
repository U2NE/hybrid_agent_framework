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

The default route remains Luna medium. A stage may begin higher inside the Luna family when concrete task evidence already establishes higher reasoning difficulty, but automatic static routing never skips from Luna directly into Sol.

- routine implementation/test/verification: Luna medium;
- moderately difficult planning/debugging/review: Luna high;
- complex cross-module reasoning and ordinary architecture/audit: Luna xhigh;
- important architecture, bounded or complex security review, high ambiguity, and unresolved high-risk reasoning: Luna max;
- Sol is entered only after Luna max is actually exhausted for the affected stage, starting at Sol high.

Role names do not force Sol. Static difficulty flags such as complex exploit reasoning or unresolved architecture can raise the stage to Luna max, but they do not directly select Sol. An explicit administrative `routeLevel` override remains available as a compatibility/control surface.

## Failure-driven escalation

Hybrid represents actionable failures with `hybrid-failure-envelope/v1`. The envelope distinguishes environment/tool/policy failures from reasoning failures and carries the affected target role, attempted route, semantic progress, stable fingerprint, and retry recommendation.

The ordered automatic escalation ladder is:

```text
Luna medium
  -> Luna high
  -> Luna xhigh
  -> Luna max
  -> Sol high
  -> Sol xhigh
  -> Sol max
```

A reasoning failure advances at most one rung from the model that actually attempted the failed stage. Environment, tool, and policy failures stay on the same model and recover the failed dependency instead. A first model-format failure retries the same route. New actionable defect evidence may also be retried at the same route when a targeted retry is more appropriate than spending more reasoning budget.

Failure routing is stage-local. A verifier failure does not raise the code reviewer, implementer, or the next unrelated stage. Sol therefore never becomes sticky: the next ordinary stage is independently routed and may return to Luna medium.

The legacy `verificationFailures` counter remains supported for compatibility, but now walks the same ladder one rung per failure and applies only to the verifier or implementation-owner repair path. It no longer jumps directly from Luna high to Luna max or forces Sol merely because the bounded repair loop reached its final attempt.

## Runtime application

Standalone role TOMLs contain no static `model` or `model_reasoning_effort`. The lead applies the route per spawn.

Current Codex 0.156.1 surface:

- model override: `-m/--model`;
- reasoning override: config key `model_reasoning_effort`.

Hybrid-controlled inference always supplies both the policy-selected model and reasoning effort. The positive allowlist is derived from this canonical routing policy (`gpt-6-luna`, `gpt-6-sol`). Missing model/effort, an unapproved model, or an unsupported effort is rejected before subprocess spawn. If an allowed explicit override is unavailable or rejected at runtime, execution fails closed: Hybrid does not retry without overrides, inherit the Codex session/default model, or substitute another model. Sol is selected only through the existing routing/escalation rules.

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
