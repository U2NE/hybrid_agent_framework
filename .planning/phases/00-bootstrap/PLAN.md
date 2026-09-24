# PLAN

<!-- hybrid-plan:v1
{
  "phase": "00-bootstrap",
  "tasks": [
    {
      "id": "A-core-requirements",
      "goal": "Implement task classification and requirements ambiguity gate.",
      "files_modified": [
        "core/classifier/index.mjs",
        "core/requirements/index.mjs"
      ],
      "depends_on": [],
      "acceptance_criteria": [
        "Tier 0-3 classification works",
        "ambiguity threshold and topology checks are deterministic"
      ],
      "verify": "node --test tests/requirements/*.test.mjs",
      "owner": "implementer",
      "security_relevant": false
    },
    {
      "id": "B-scheduler",
      "goal": "Implement dependency waves and same-file writer serialization.",
      "files_modified": [
        "core/scheduler/index.mjs"
      ],
      "depends_on": [],
      "acceptance_criteria": [
        "dependency ordering works",
        "independent tasks parallelize",
        "same-file writers serialize",
        "cycles fail closed"
      ],
      "verify": "node --test tests/scheduler/*.test.mjs",
      "owner": "implementer",
      "security_relevant": false
    },
    {
      "id": "C-state",
      "goal": "Implement atomic human-readable persistent state.",
      "files_modified": [
        "core/state/index.mjs"
      ],
      "depends_on": [],
      "acceptance_criteria": [
        "state resumes after restart",
        "corrupt state fails closed without reset"
      ],
      "verify": "node --test tests/state/*.test.mjs",
      "owner": "implementer",
      "security_relevant": false
    },
    {
      "id": "D-verification-routing",
      "goal": "Implement role routing, independent verification, conditional security review, and bounded repair.",
      "files_modified": [
        "core/routing/index.mjs",
        "core/verification/index.mjs"
      ],
      "depends_on": [],
      "acceptance_criteria": [
        "implementer cannot self-verify",
        "security review is conditional",
        "fix loop stops after three fixes"
      ],
      "verify": "node --test tests/verification/*.test.mjs",
      "owner": "implementer",
      "security_relevant": false
    },
    {
      "id": "E-wiki",
      "goal": "Implement derived wiki query and lint.",
      "files_modified": [
        "core/wiki/index.mjs"
      ],
      "depends_on": [],
      "acceptance_criteria": [
        "broken links, orphan pages, stale pages are detected",
        "query supports terms/category"
      ],
      "verify": "node --test tests/wiki/*.test.mjs",
      "owner": "implementer",
      "security_relevant": false
    },
    {
      "id": "F-runtime-surface",
      "goal": "Compose orchestration, artifact helpers, Codex agents/skills, CLI, and safe project installer.",
      "files_modified": [
        "core/orchestrator/index.mjs",
        "core/planning/index.mjs",
        "core/context/index.mjs",
        "core/artifacts/index.mjs",
        "bin/hybrid.mjs",
        "scripts/install-project.mjs",
        ".codex/config.toml",
        ".codex/agents",
        ".codex/skills",
        "AGENTS.md"
      ],
      "depends_on": [
        "A-core-requirements",
        "B-scheduler",
        "C-state",
        "D-verification-routing",
        "E-wiki"
      ],
      "acceptance_criteria": [
        "Codex surface is flat",
        "session model inheritance is default",
        "installer preserves existing project content",
        "full suite passes"
      ],
      "verify": "npm test && npm run check",
      "owner": "implementer",
      "security_relevant": false
    }
  ]
}
-->

## Execution Waves

### Wave 1

- A-core-requirements
- B-scheduler
- C-state
- D-verification-routing
- E-wiki

### Wave 2

- F-runtime-surface

## Tasks

### A-core-requirements

Implement task classification and requirements ambiguity gate.

- Owner: implementer
- Depends on: (none)
- Files: core/classifier/index.mjs, core/requirements/index.mjs
- Verify: `node --test tests/requirements/*.test.mjs`
- Acceptance:
  - Tier 0-3 classification works
  - ambiguity threshold and topology checks are deterministic

### B-scheduler

Implement dependency waves and same-file writer serialization.

- Owner: implementer
- Depends on: (none)
- Files: core/scheduler/index.mjs
- Verify: `node --test tests/scheduler/*.test.mjs`
- Acceptance:
  - dependency ordering works
  - independent tasks parallelize
  - same-file writers serialize
  - cycles fail closed

### C-state

Implement atomic human-readable persistent state.

- Owner: implementer
- Depends on: (none)
- Files: core/state/index.mjs
- Verify: `node --test tests/state/*.test.mjs`
- Acceptance:
  - state resumes after restart
  - corrupt state fails closed without reset

### D-verification-routing

Implement role routing, independent verification, conditional security review, and bounded repair.

- Owner: implementer
- Depends on: (none)
- Files: core/routing/index.mjs, core/verification/index.mjs
- Verify: `node --test tests/verification/*.test.mjs`
- Acceptance:
  - implementer cannot self-verify
  - security review is conditional
  - fix loop stops after three fixes

### E-wiki

Implement derived wiki query and lint.

- Owner: implementer
- Depends on: (none)
- Files: core/wiki/index.mjs
- Verify: `node --test tests/wiki/*.test.mjs`
- Acceptance:
  - broken links, orphan pages, stale pages are detected
  - query supports terms/category

### F-runtime-surface

Compose orchestration, artifact helpers, Codex agents/skills, CLI, and safe project installer.

- Owner: implementer
- Depends on: A-core-requirements, B-scheduler, C-state, D-verification-routing, E-wiki
- Files: core/orchestrator/index.mjs, core/planning/index.mjs, core/context/index.mjs, core/artifacts/index.mjs, bin/hybrid.mjs, scripts/install-project.mjs, .codex/config.toml, .codex/agents, .codex/skills, AGENTS.md
- Verify: `npm test && npm run check`
- Acceptance:
  - Codex surface is flat
  - session model inheritance is default
  - installer preserves existing project content
  - full suite passes
