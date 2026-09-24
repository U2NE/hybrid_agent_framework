# Codex Hybrid Agent

Codex-first autonomous development framework combining a thin GSD-style execution kernel with OMC-inspired requirements convergence, independent quality gates, bounded fix loops, and derived project knowledge.

## Pipeline

`classify → clarify/specify when needed → research → plan → [architect/audit for complex work] → dependency-aware execute → test → review → conditional security → verify/fix → integrate → full test → docs/wiki`

## Core invariants

- `.planning/` is canonical project state; `.ai/wiki/` is derived only.
- Dispatch is flat: the lead owns sibling spawning/result collection; workers never recursively delegate.
- Independent tasks may share a wave; dependencies go to later waves; same-file writers serialize; cycles reject.
- One writer per file per execution wave.
- Implementers cannot final-verify their own work.
- Security review is conditional.
- Verify/fix stops after 3 failed iterations.
- State uses `hybrid-state/v1` and unsupported/corrupt state fails closed.
- Model routing is stage-local and Luna-first: medium/high/xhigh/max are used before Sol escalation, and later routine stages downshift independently.

## Model routing

Canonical mapping: `core/routing/model-routing.json`

```text
default_model_tier = luna -> gpt-6-luna
heavy_model_tier   = sol  -> gpt-6-sol
fallback                 -> session-inheritance
```

The concrete IDs were confirmed against the Codex CLI 0.156.1 model catalog on 2026-09-25. Agent TOMLs do not statically pin a model; the lead applies the per-stage route. If an explicit model is unavailable/rejected, that spawn is retried without a model/reasoning override so Codex can inherit its session/default model.

See `docs/architecture/MODEL-ROUTING.md`.

## Validate this framework

```bash
npm run check
npm test
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

Static/runtime-independent validation is complete for config schema, agent registration, skills, routing decisions, scheduler, state, wiki, verification, security triggers, and installer behavior.

Authenticated runtime validation is still pending for actual subagent spawning, sibling parallel execution, handoff/result collection, and actual model override/fallback behavior because this WSL currently has no Codex credentials.

Prepared functional cases are implemented by `scripts/runtime-smoke.mjs`. See `docs/architecture/RUNTIME-SMOKE.md` and `docs/RUNTIME-VALIDATION.md`.
