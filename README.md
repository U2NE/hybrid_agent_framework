# Codex Hybrid Agent

Codex-first autonomous development framework combining a thin GSD-style execution kernel with OMC-inspired requirements convergence, independent quality gates, bounded fix loops, and derived project knowledge.

## Pipeline

`classify → clarify/specify when needed → research → plan → [architect/audit for complex work] → dependency-aware execute → test → review → conditional browser functional/adversarial QA → conditional security → verify/fix → integrate → full test → docs/wiki`

## Core invariants

- `.planning/` is canonical project state; `.ai/wiki/` is derived only.
- Dispatch is flat: the lead owns sibling spawning/result collection; workers never recursively delegate.
- Independent tasks may share a wave; dependencies go to later waves; same-file writers serialize; cycles reject.
- One writer per file per execution wave.
- Implementers cannot final-verify their own work.
- Security review is conditional.
- Interactive UI behavior can activate read-only Browser Functional QA; browser-relevant Tier 2/3 or high-regression-risk UI work can additionally activate Browser Adversarial QA.
- Browser QA uses a bounded Playwright-compatible provider for real click/fill/navigation evidence, remains same-origin/non-destructive by default, and cannot final-verify itself; exact browser evidence must be reassessed by the Verifier.
- Required browser proof fails closed when the target project does not provide `playwright` or `@playwright/test` plus its browser runtime.
- Verify/fix stops after 3 failed iterations.
- State uses `hybrid-state/v1` and unsupported/corrupt state fails closed.
- Model routing is stage-local and Luna-first: medium/high/xhigh/max are used before Sol escalation, and later routine stages downshift independently.
- Approved execution is sealed as `hybrid-exec-graph/v4`; each executable task carries the scheduler-selected `current-workspace` or `worktree` isolation mode as part of its authority.
- Mutating execution requires a durable task lease before spawn. The lease, task contract, and dispatch authorization must retain the same descriptor/revision/task/attempt/capability/effect/isolation binding.
- New terminal outcomes require the exact active dispatch authorization and durable lease; competing terminal outcomes for one task attempt fail closed, and lease release requires a persisted evidence-bearing terminal transition.
- Worktree success is integration-backed: both `task_completed` and `recovered_task_completed` require completed durable integration evidence that still matches the main workspace. A detached patch or worker return alone is not completion authority.
- `recovered_task_completed` is worktree recovery-only. Current-workspace mutations use the repository-global mutation guard, and guard completion alone is not lease-release authority.

## Current hardening status

The current `hardening-integration` line combines the latest provenance/actor-contract hardening with Browser Functional QA and Browser Adversarial QA while preserving execution graph v4 isolation authority, durable lease/transition fencing, evidence-bound lease release, current-workspace write-set protection, and worktree integration-backed completion/recovery. The current full deterministic baseline is `npm test` **365/365 PASS** and `npm run test:unit` **125/125 PASS**, with `npm run check` passing.

Authenticated Cases A/B/C and revised J/K are complete. A genuine user-interactive clarification Case D remains intentionally pending, and backend serving-model identity is not independently attested. Worktree lifecycle/restart/conflict/recovery behavior is exercised by Git-backed deterministic fixtures; it has not been demonstrated against a production repository merge.

## Model routing

Canonical mapping: `core/routing/model-routing.json`

```text
default_model_tier = luna -> gpt-6-luna
heavy_model_tier   = sol  -> gpt-6-sol
fallback                 -> fail-closed
```

The concrete IDs were confirmed against the Codex CLI 0.156.1 model catalog on 2026-09-25. Agent TOMLs do not statically pin a model; the lead applies the per-stage route. Every Hybrid-controlled inference must pass an explicit allowlisted model and reasoning effort. If that routed override is unavailable or rejected, execution fails closed; Hybrid never retries model-less, inherits the session/default model, or substitutes an arbitrary model.

See `docs/architecture/MODEL-ROUTING.md`.

## Validate this framework

```bash
npm run check
npm test
npm run test:unit
node bin/hybrid.mjs classify "fix typo"
node bin/hybrid.mjs wiki lint .ai/wiki
node bin/hybrid.mjs state get .
npm run smoke:preflight
```

## Install into another Git repository

```bash
node scripts/install-project.mjs /path/to/target-repo
```

Codex CLI is **not** a prerequisite.

- CLI absent: framework installation succeeds; runtime validation is WARN/SKIP.
- CLI present: installer additionally runs strict-config validation and reports runtime authentication readiness.
- credentials absent: runtime validation remains pending; installation still succeeds.

The installer preserves existing project instructions/config where possible, registers Hybrid-prefixed roles, installs repository-local skills, seeds planning state only when absent, and copies upstream MIT notices.

## Skill surface

This framework repository has one editable skill source:

- `skills/*/SKILL.md`: canonical source.
- `.agents/skills/*/SKILL.md`: symlinks to the canonical source for current repository-local discovery.
- `.codex/skills/*/SKILL.md`: compatibility symlinks to the same source.

Installation into a target repository copies the canonical skill snapshots into `.agents/skills/`; it does not create a second editable framework source or install the compatibility `.codex/skills/` aliases.

## Codex runtime status

Static/runtime-independent validation is complete for config schema, agent registration, skills, routing decisions, scheduler, state, wiki, verification, security triggers, installer behavior, execution graph v4 sealing, durable lease/dispatch authority, terminal transition fencing, current-workspace mutation guarding, worktree integration/recovery validation, browser-lane activation/routing/capabilities, bounded Playwright-compatible interaction, installer propagation, CLI fail-closed behavior, and verifier-gated browser evidence.

Historical authenticated runtime validation covered A/B/C functional cases, sibling parallelism, same-file serialization, quality-lane handoffs, Luna effort overrides, and the then-current rejected-model → session-inheritance retry. That fallback evidence is superseded by the explicit-model fail-closed policy; current deterministic validation rejects unapproved or model-less inference before subprocess spawn. Revised authenticated Case J now passes the Implementer-owned Tier 0 provenance contract with explicit Luna/medium routing and a clean audit. Authenticated Case K passes one parallel wave with two independently owned Implementer children, both spawn records before the first completion, explicit Luna/medium worker routes, reported actor artifacts, exact file ownership, and a clean audit. A genuine user-interactive clarification Case D remains pending by design; explicit request acceptance is observed, but backend serving-model identity is not independently attested.

Prepared functional cases are implemented by `scripts/runtime-smoke.mjs`. Browser QA is implemented by `core/browser/index.mjs`; see `docs/architecture/BROWSER-QA.md` for its role, safety, CLI, Playwright availability, and evidence-authority contract. The framework repository itself currently has no Playwright package/browser runtime, so browser QA is deterministically validated with an injected compatible surface rather than claimed as a real-browser live smoke. See `docs/architecture/RUNTIME-SMOKE.md` and `docs/RUNTIME-VALIDATION.md` for the existing authenticated runtime cases.
