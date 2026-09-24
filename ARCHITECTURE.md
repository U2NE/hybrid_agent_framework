# Architecture

## Invariants

1. `.planning/` is the only canonical mutable project state.
2. `.ai/wiki/` is a derived projection.
3. Dispatch is flat by architecture: only the lead spawns sibling Hybrid agents; workers cannot recursively delegate.
4. `max_depth = 1` is retained as a Codex 0.156.1 compatibility guard, not as the sole enforcement mechanism for flatness.
5. The lead owns scheduling, integration, result collection, model routing, and state transitions.
6. Workers receive narrow context packets, not full chat history.
7. A file has at most one writer in a wave.
8. Verification authority is separate from implementation authority.
9. Fix loops stop after three failed verification cycles.
10. Canonical state is `hybrid-state/v1`; corrupt or unsupported state fails closed.
11. Luna is the default model tier. Sol is escalation-only and routing is recomputed per stage.

## Components

- `classifier`: orchestration tier 0–3.
- `requirements`: weighted clarity gate and edge probes.
- `planning` / `artifacts`: durable SPEC/PLAN representation.
- `scheduler`: dependency waves + same-file serialization + cycle rejection.
- `context`: narrow worker context packets.
- `orchestrator`: pipeline selection, security lane activation, and model-route assembly.
- `routing`: logical Luna/Sol policy, contextual escalation, downshift, and safe session-inheritance fallback.
- `state`: atomic, versioned, recoverable `STATE.md`.
- `verification`: reviewer independence, bounded fixes, security triggers.
- `wiki`: broken/orphan/stale/oversized lint and knowledge projection.
- `.codex/agents`: standalone specialized role config.
- `skills/`: canonical workflow skills, exposed through repository-local aliases.

## Context packet

Workers receive only the bounded contract needed for the assigned task:
- Goal
- acceptance criteria
- constraints/non-goals
- relevant files/interfaces
- dependencies and reduced dependency outputs
- resolved decisions
- required verification
- assigned ownership
- lead-selected routed model/effort when an explicit override is used

If dependency artifacts exceed the context budget, Hybrid reduces lower-priority prose by Markdown section while preserving these critical contract sections.

## Planning council

Planning depth is tier/risk dependent:

- Tier 0/1: no consensus council; Planner itself is conditional for bounded multi-task/dependency work.
- Tier 2: Planner by default; Architect → Plan Auditor is activated only when architecture/security/plan risk warrants it, with at most 3 convergence iterations.
- Tier 3/high-risk: Planner → Architect → Plan Auditor convergence is used, with at most 5 iterations.

Architect and Plan Auditor independently review the same plan revision; Planner combines their feedback only after both reviews. A rejected plan returns to revision/re-review, and reaching the cap never becomes approval. Even an approved consensus plan remains pending explicit user execution approval.

Their role names do not force Sol: ordinary high-judgment review uses Luna xhigh/max, while exceptional unresolved reasoning may enter Sol.

## Execution

Plans declare `depends_on` and `files_modified`.

- independent tasks: same wave, sibling-parallel eligible;
- dependency: later wave;
- same-file writers: serialized even without an explicit dependency;
- cycle/unknown dependency: rejected.

Only the lead dispatches siblings. Every standalone worker role explicitly forbids subagent spawning/delegation.

## Model routing

`core/routing/model-routing.json` is the single concrete-ID mapping.

- default tier: Luna → `gpt-6-luna`;
- heavy tier: Sol → `gpt-6-sol`;
- fallback: session inheritance.

Routing is contextual rather than globally sticky. High ambiguity, architecture/refactor judgment, security-sensitive reasoning, complex cross-module debugging, difficult review, and verification failures first raise Luna reasoning effort; Sol is reserved for Luna-exhausted or exceptional unresolved stages. The next ordinary stage is independently resolved and can return to Luna medium.

Static role TOMLs do not pin model IDs. If a routed model is rejected/unavailable, the lead retries that spawn without a model/reasoning override and records the fallback.

## Verification

Quality depth is also tier/risk dependent.

- Tier 0 normally uses implementer → lightweight verification.
- Tier 1 normally uses implementer → verifier; Tester and Code Reviewer are added only when behavior/test/logic risk requires them.
- Tier 2/3 use the fuller independent quality path.
- Security Reviewer is conditional on an actual trust-boundary/security surface.

For full quality work the shape is `Implementer → [Tester / Code Reviewer / Security Reviewer] → Verifier`, with independent read-only QA roles allowed to run concurrently when their inputs are ready.

Bounded security review uses Luna max; complex exploit/trust-boundary or critical unresolved judgment may enter Sol. The final routine Verifier can independently downshift back to Luna medium.

## State and recovery

`STATE.md` contains:
- document marker `<!-- hybrid-state:v1`;
- machine field `schema: "hybrid-state/v1"`;
- `schemaVersion: 1`.

Pre-audit v1 states that have the v1 marker and `schemaVersion: 1` but no string `schema` remain readable. Unsupported schemas/versions and corrupt JSON fail closed and are never silently reset.

Restart reads `AGENTS.md`, `PROJECT.md`, `STATE.md`, the active SPEC/PLAN, and architecture docs.

## Runtime boundary

Deterministic orchestration and Codex config surfaces are verified, and authenticated A/B/C runtime smoke now verifies model-backed spawn, sibling parallelism, same-file serialization, quality-lane handoff/result collection, accepted Luna effort overrides, and rejected-model → no-override session-inheritance retry. Only real user-interactive Case D remains intentionally pending; serving-model identity is not independently attested. See `docs/RUNTIME-VALIDATION.md` and `docs/architecture/RUNTIME-SMOKE.md`.
