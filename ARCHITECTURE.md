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
12. Decision Provenance records bounded observable facts and policy/control-flow choices; it never stores hidden reasoning.
13. The lead is the sole writer of orchestration decisions and runtime events. Each worker may write only its own bounded actor artifact.

## Components

- `classifier`: orchestration tier 0–3.
- `requirements`: weighted clarity gate and edge probes.
- `planning` / `artifacts`: durable SPEC/PLAN representation.
- `scheduler`: dependency waves + same-file serialization + cycle rejection.
- `context`: narrow worker context packets; optional deterministic shared snapshot/cache for immutable repo/SPEC/PLAN facts.
- `orchestrator`: pipeline selection, security lane activation, model-route assembly, and the small generic `runQualityClosure()` primitive used after an integrated snapshot exists. The default Tier 0/1 pipelines do not contain cache/QE/repair/observability stages.
- `routing`: logical Luna/Sol positive allowlist, contextual escalation/downshift, and fail-closed explicit model/effort enforcement; session/default inheritance is prohibited.
- `runtime`: derived runtime-root resolution for cache/evidence/log artifacts; never canonical project state.
- `state`: atomic, versioned, recoverable `STATE.md`.
- `verification`: acceptance trace plus tier-aware evidence/completion gates.
- `repair`: deterministic finding policy, fingerprinting, targeted implementation-owner repair, and the existing bounded fix-loop/routing policy.
- `qe`: proof-gap-only deterministic process/HTTP/browser-provider adapters; no QE agent.
- `observability`: best-effort redacted JSONL instrumentation with no model/agent call.
- `decision provenance`: lead-owned structured decisions linked to actual actions, isolated per-worker artifacts, and a deterministic audit; it is passive and is not a reasoning engine.
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

For full quality work the shape is `Implementer → [Tester / Code Reviewer / Security Reviewer] → Verifier`, with independent read-only QA roles allowed to run concurrently against the integrated snapshot when their inputs are ready.

Completion is evidence-gated on the existing acceptance trace through `runQualityClosure()`. Tier 0 requires only fresh minimal evidence; Tier 1 uses targeted evidence; Tier 2/3 require full independent evidence. An implementer self-claim is never completion proof. For Tier 2/3, final-verifier authority is accepted only when structured coverage contains every required AC, is fresh, and is bound to the current integrated snapshot; criterion-level independent evidence is the alternative.

Verifier distinguishes a real defect from missing proof. A blocking defect enters at most three targeted implementation-owner repair cycles; repeated failures reuse the existing Luna→Sol escalation and QA/verification runs again on the repaired snapshot. A `PROOF_GAP` instead selects the cheapest semantically adequate deterministic proof. Acquired evidence remains `acquired=true, assessed=false, verified=false` until a Verifier semantically reassesses the exact `evidenceId`; exit code 0 alone cannot satisfy an AC. Browser interaction is used only when the acceptance criterion truly requires it and a provider exists; unavailable required proof remains unverified.

`runQualityClosure()` routes sibling shared immutable context through `buildWorkerContextWithCache()` only when reuse is worthwhile; cache miss/corruption/write failure falls back to ordinary context construction. The same generic closure emits passive best-effort QA/verifier/repair/proof/completion/cache events under the derived runtime root. Cache and observability add no agent/LLM call and are never correctness dependencies.

Bounded security review uses Luna max; complex exploit/trust-boundary or critical unresolved judgment may enter Sol. The final routine Verifier can independently downshift back to Luna medium.

## State and recovery

`STATE.md` contains:
- document marker `<!-- hybrid-state:v1`;
- machine field `schema: "hybrid-state/v1"`;
- `schemaVersion: 1`.

Pre-audit v1 states that have the v1 marker and `schemaVersion: 1` but no string `schema` remain readable. Unsupported schemas/versions and corrupt JSON fail closed and are never silently reset.

Restart reads `AGENTS.md`, `PROJECT.md`, `STATE.md`, the active SPEC/PLAN, and architecture docs.

## Runtime boundary

Deterministic orchestration and Codex config surfaces are verified. Authenticated A/B/C verify spawn, sibling parallelism, same-file serialization, and quality-lane handoff; E verifies the disposable worktree lifecycle; F verifies bounded planning convergence. G and H exercise the framework-source generic `runQualityClosure()` primitive directly: G verifies review → implementation-owner repair → re-review/verifier convergence, while H verifies proof-gap detection → raw CLI proof acquisition → exact-evidence verifier reassessment → completion. Case I closes the installed Lead boundary. Revised Case J now authenticates the Implementer-owned Tier 0 provenance path, and Case K authenticates a two-child parallel provenance wave. Hybrid-controlled Codex inference is fail-closed on model policy: only canonical allowlisted models with explicit supported reasoning effort may execute, and session/default inheritance is prohibited. When an explicit integrated snapshot exists, assessed/verified runtime proof fails closed unless its snapshot exactly matches the current snapshot. Explicit model/effort request acceptance is observed, but serving-model identity is not independently attested. Real user-interactive Case D remains intentionally pending. See `docs/RUNTIME-VALIDATION.md` and `docs/architecture/RUNTIME-SMOKE.md`.

Decision Provenance adds a passive FACTS → POLICY → DECISION → INTENDED ACTION → ACTUAL ACTION → EVIDENCE → AUDIT record. Runtime Event means what actually happened; Decision Provenance means which control-flow policy selected an action; Actor Artifact means what one worker did; Audit means whether those records agree. The lead writes `decisions.jsonl` and orchestration-level `events.jsonl`; each worker API is structurally restricted to `actors/<its-agentRunId>.jsonl`. This is API-level ownership, not an OS sandbox against a hostile process. The bounded `audit.json` is deterministic and does not gate normal execution; it evaluates recorded decisions, actions, ownership declarations, and evidence links, and cannot independently observe unreported filesystem mutations. Canonical decisions expose facts, policy.rule, reasonCodes, intendedAction, and evidenceRefs directly, with a Lead actor and one of the nine canonical control-flow stages. Pure decisions have a null timestamp; the Lead writer stamps persisted records without changing deterministic identity. Attribution distinguishes observed, derived, and reported data; bounded worker self-reports are valid artifacts but cannot by themselves prove an observed action. Metadata-only intended actions explicitly set expectsEvent=false. File mutation records contain bounded paths and attribution, never diffs or source. Sanitization recursively removes secret-bearing and prompt/reasoning/source fields. No layer stores chain-of-thought.

Decision Provenance runtime wiring now distinguishes pure calculation from real execution: `prepareExecution()` remains zero-I/O, `prepareExecutionWithProvenance()` is the normal installed preparation path, `runQualityClosure()` auto-constructs Lead-owned persistence by default, and public `appendRuntimeEvent()` cannot write central action-bearing records. Tier 0 task mutation remains Implementer-owned rather than Lead-direct.

Revised Case J validates the tightened Tier 0 contract with an authenticated outer Lead explicitly requesting `gpt-6-luna` at medium effort. The run persisted Tier 0 classification and Implementer activation, used an explicit Luna/medium Implementer route, produced linked Lead-owned spawn/completion actions plus a reported actor artifact, completed lightweight verification and completion provenance, left no Lead-owned README mutation, and persisted a clean audit. Case K validates one authenticated `parallel_wave` with two independent Implementer children: task IDs `A` and `B` share the same parent/wave, both spawn actions precede the first completion, each owns only its target file, both routes explicitly request Luna/medium, both actor artifacts remain reported, and the audit is clean. Framework-logical worker identities remain explicit where the Codex JSON stream does not independently expose native worker IDs.
