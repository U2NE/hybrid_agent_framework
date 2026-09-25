# Run-level Sol budget authorization

Hybrid routes ordinary work through Luna first. Sol remains available for unresolved reasoning after Luna max, but automatic Sol use is bounded per run.

## Default policy

The canonical routing policy defines:

```json
{
  "budget_policy": {
    "default_max_sol_reservations_per_run": 3
  }
}
```

The limit counts unique Sol **stage-attempt reservations**, not every function call. Replaying the same exact stage/attempt/route does not consume another unit.

Luna routes do not consume this budget.

## Durable state

Each run stores its budget state at:

```text
.planning/runs/<run-id>/MODEL-BUDGET.json
```

The store records:

- the initial automatic limit;
- the current limit;
- every Sol reservation;
- every explicit user approval that raised the limit.

Store mutations are serialized by `.model-budget.lock`.

The current limit is re-derived from the initial limit plus the ordered user-approval chain. Editing `maxSolReservations` alone therefore makes the store invalid instead of silently raising the budget.

## Sol execution boundary

A Sol route is not executable merely because routing selected `gpt-6-sol`.

Before spawning the Sol stage, the Lead must:

1. reserve the exact `runId / stageId / attemptId / role / routeLevel / model / reasoning effort`;
2. retain the returned `hybrid-model-budget-authorization/v1` object;
3. verify that exact authorization immediately before spawn;
4. pass the already selected model and reasoning effort explicitly to the worker runtime.

Reservation is fail-closed:

- the same attempt with identical route data replays idempotently;
- the same stage/attempt with a different Sol route is fenced;
- a missing reservation blocks verification;
- a missing or modified authorization blocks verification;
- concurrent processes cannot oversubscribe the run cap.

## Exhaustion and user authority

When the automatic cap is exhausted, the next Sol reservation fails with:

```text
MODEL_BUDGET_USER_APPROVAL_REQUIRED
```

Hybrid must not silently:

- downgrade to Luna;
- inherit a session model;
- increase the limit itself;
- issue a fake user approval receipt;
- merge several future Sol attempts into one reservation.

The user decides whether to spend additional Sol budget.

An external trusted user interaction may create a
`hybrid-user-model-budget-approval/v1` receipt bound to:

- run ID;
- current limit;
- new higher limit;
- explicit user attribution;
- approval timestamp.

The installed Lead may **consume** that receipt through `model-budget approve`, but Lead/worker agents must not self-issue it and treat it as user consent.

## CLI

```text
node .hybrid/bin/hybrid.mjs model-budget reserve <run-id> <stage-id> <attempt-id> <route.json> [project-root]

node .hybrid/bin/hybrid.mjs model-budget verify <run-id> <stage-id> <attempt-id> <route.json> <authorization.json> [project-root]

node .hybrid/bin/hybrid.mjs model-budget approve <run-id> <user-approval-receipt.json> [project-root]

node .hybrid/bin/hybrid.mjs model-budget list <run-id> [project-root]
```

The route JSON must be the exact route resolved by Hybrid. Sol budget accounting never authorizes a different model family than the selected route.
