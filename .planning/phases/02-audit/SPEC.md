# SPEC — Framework Audit

## Goal
Audit the verified Hybrid framework in place and minimally strengthen model routing, Codex runtime boundaries, installer behavior, skill discovery, state versioning, parallelization invariants, security escalation, Git guidance, and authenticated runtime smoke preparation.

## Constraints
- Preserve the canonical Node implementation.
- Do not rebuild the framework or replace verified scheduler/state/wiki/verification architecture.
- Preserve the pre-audit 37/37 passing baseline.
- Do not invent Codex model IDs or claim authenticated runtime behavior without credentials.
- Do not set Git identity or create a commit for the user.

## Acceptance Criteria
- Luna is the default logical model tier.
- Sol escalation is contextual and non-sticky.
- concrete Luna/Sol IDs are isolated in one routing mapping and verified against Codex 0.156.1.
- failed/unavailable explicit model override can fall back to session inheritance.
- current custom-agent TOMLs meet current standalone-agent metadata requirements.
- CLI absence does not block installation; CLI presence adds best-effort validation.
- skills have one canonical source with discoverable aliases/frontmatter.
- state explicitly records hybrid-state/v1 and rejects unsupported schema/version.
- scheduler and flat-worker invariants remain covered.
- security triggers cover the requested trust-boundary surfaces and map Security Reviewer to Sol.
- three authenticated runtime smoke cases are prepared.
- full syntax/tests/wiki/state/config checks pass after modification.

## Runtime boundary
Authenticated subagent spawn, real sibling parallelism, live handoff/result collection, and live model override/fallback remain pending until Codex credentials are available.
