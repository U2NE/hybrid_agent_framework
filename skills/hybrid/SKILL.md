---
name: hybrid
description: Codex-first autonomous development front door with flat dispatch, Luna-default routing, conditional Sol escalation, and durable planning state.
---

# Hybrid Front Door

Use this skill when the user asks to implement, change, fix, refactor, or add a feature.

## Entry sequence

1. Read AGENTS.md, .planning/PROJECT.md, and .planning/STATE.md.
2. Classify the task:
   - Tier 0 trivial: execute directly, then independent verification.
   - Tier 1 bounded: scout, plan-lite, execute, verify.
   - Tier 2 complex: scout, spec-lite, approval, planning council, execution waves, independent QA/review.
   - Tier 3 ambiguous: scout, full requirements gate, approved SPEC, then the Tier 2 path.
3. Never ask the user for facts available from the repo.
4. Use .planning as the only canonical state.
5. Compute dependency waves and serialize same-file writers.
6. Keep the lead thin. Only the lead spawns sibling Hybrid agents; workers never recursively delegate.
7. Before each agent spawn, use the Hybrid model-routing decision:
   - normal stage: Luna tier;
   - high ambiguity, architectural decision/refactor, security-sensitive reasoning, complex cross-module debugging/review, or repeated verification failure: Sol tier;
   - after a Sol-only stage, recompute the next stage independently so normal implementer/tester/documentation work can downshift to Luna.
8. If Codex rejects or cannot use the explicit routed model, retry that spawn once without model/reasoning override and record session-inheritance fallback. Never guess a replacement model ID.
9. Run tester → code reviewer → conditional security reviewer → verifier.
10. If verification fails, run targeted fix → verify up to three times.
11. Integrate, run full tests, then update durable docs and the derived wiki.

## Worker context

Give workers only:
- Goal
- Relevant files and interfaces
- Acceptance criteria
- Constraints
- Dependency outputs
- Assigned file ownership
- The lead-selected model tier/model, when an explicit override is being used

Do not dump the full conversation into every worker.

## Approval gate

Complex or ambiguous work must have an approved SPEC before implementation unless the user explicitly requests a safe, bounded direct change.
