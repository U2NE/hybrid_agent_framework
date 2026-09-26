# Browser QA

Hybrid has two browser-specific review lanes for changes whose correctness depends on real UI interaction.

## Lanes

### Browser Functional Tester

`browser-functional-tester` validates approved interactive behavior in a real browser. It is activated when browser semantics are explicit or when an interactive UI surface changes. It uses bounded acceptance-oriented scenarios when supplied and otherwise exercises safe discovered controls.

Examples:

- open a modal and verify the visible state;
- fill a form field and verify the resulting UI state;
- click a navigation control and verify the destination;
- refresh or navigate when persistence itself is part of the acceptance criterion.

### Browser Adversarial Reviewer

`browser-adversarial-reviewer` is the interactive counterpart of the ordinary Adversarial Reviewer. It is activated for browser-relevant Tier 2/3 work and for explicit high-regression-risk browser work.

It deliberately probes:

- repeated and double clicks;
- malformed text input;
- modal/menu/state-transition edges;
- refresh/navigation boundaries;
- stale UI assumptions;
- neighboring interaction regressions.

The ordinary Adversarial Reviewer still owns code/state/concurrency counterexample analysis. Browser Adversarial QA adds real interaction evidence rather than replacing it.

## Execution model

Both browser roles are read-only with respect to the repository. Real browser interaction is performed through the deterministic browser provider in:

`core/browser/index.mjs`

Installed projects receive the same implementation at:

`.hybrid/core/browser/index.mjs`

The CLI surface is:

```bash
node bin/hybrid.mjs browser-qa browser-qa.json .
# installed project
node .hybrid/bin/hybrid.mjs browser-qa browser-qa.json .
```

The provider dynamically uses a project-owned `playwright` or `@playwright/test` installation. Hybrid does not silently install browser packages or browser binaries. If the required provider is unavailable, browser proof remains unavailable and the acceptance criterion stays a proof gap.

## Browser plan

A browser plan is JSON. A functional scenario can be explicit:

```json
{
  "mode": "functional",
  "url": "http://127.0.0.1:3000/checkout",
  "actions": [
    { "type": "click", "role": "button", "name": "Open checkout" },
    { "type": "fill", "label": "Email", "value": "qa@example.test" },
    { "type": "expect-visible", "role": "dialog", "name": "Checkout" }
  ]
}
```

Supported explicit actions include `goto`, `reload`, `back`, `forward`, `wait`, `click`, `double-click`, `fill`, `press`, `check`, `uncheck`, `select`, `hover`, `expect-url`, `expect-text`, and `expect-visible`.

When `actions` is omitted, the provider discovers a bounded set of ordinary interactive controls and exercises them. Adversarial mode additionally performs bounded malformed-input and double-click probes.

A plan may include `startCommand` as an argv array. Hybrid starts that process, waits for the target URL to become reachable, runs the browser checks, and shuts the process down afterward.

## Safety boundary

Automatic browser discovery is deliberately conservative:

- it remains same-origin;
- destructive-looking controls are skipped by default;
- submit/reset/file controls are skipped by default;
- destructive interaction requires explicit `allowDestructive: true`;
- the number of automatic interactions is bounded;
- browser execution never grants repository write authority to the review role.

This boundary prevents generic QA exploration from casually submitting orders, deleting records, logging users out, or navigating into unrelated origins.

## Evidence authority

Browser execution creates raw `kind: "browser"` evidence containing a stable evidence ID, a bounded JSON summary, screenshot reference when available, and browser telemetry such as page errors, console errors, and failed requests.

A successful browser run is **not** final verification. The evidence remains acquired but unverified until the independent Verifier consumes the exact `evidenceId` and semantically assesses it. `runQualityClosure()` auto-wires the built-in provider for a browser proof gap unless the caller supplies its own provider or explicitly disables browser-provider use.

The authority chain is:

```text
browser-relevant acceptance criterion
  -> Browser Functional / Adversarial QA intent
  -> bounded Playwright browser interaction
  -> raw browser evidence
  -> independent Verifier reassessment of exact evidenceId
  -> completion gate
```

## Current validation boundary

Deterministic tests cover browser-lane activation, capability/routing policy, installer propagation, explicit browser actions, safe automatic control discovery, adversarial malformed-input/double-click probes, unavailable-provider fail-closed behavior, and browser proof reassessment through `runQualityClosure()`.

The framework repository itself does not currently contain Playwright, so these tests use a deterministic injected Playwright surface. A real application/browser demonstration requires Playwright or `@playwright/test` plus its browser runtime in the target project.
