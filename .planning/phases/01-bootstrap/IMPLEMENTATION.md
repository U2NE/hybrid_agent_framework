# IMPLEMENTATION

Implemented and consolidated the framework around the existing Node execution kernel.

## Canonical runtime
- `core/classifier`: Tier 0–3 task classification.
- `core/requirements`: topology-first ambiguity/acceptance gate and edge probes.
- `core/planning` + `core/artifacts`: canonical SPEC/PLAN artifact handling.
- `core/scheduler`: dependency waves, same-file serialization, cycle rejection.
- `core/context`: narrow fresh worker context packets.
- `core/orchestrator`: flat pipeline preparation and conditional quality lanes.
- `core/state`: atomic canonical state with corruption fail-closed behavior.
- `core/routing`: role tiers with session-model inheritance by default.
- `core/verification`: independent verification, security activation, bounded fix loop.
- `core/wiki` + `core/docs`: derived knowledge and documentation drift handling.

## Codex surface
- Registered 11 specialized roles.
- Pinned `agents.max_depth = 1` and forbade recursive Hybrid delegation in each role.
- Kept model fields absent so roles inherit the active session model.
- Added skill frontmatter required for discovery.
- Preserved both `.agents/skills` and `.codex/skills` as aliases to one canonical `skills/` source.

## Installer
The project installer preserves existing AGENTS/config/planning content, registers Hybrid-prefixed roles, normalizes the Hybrid flat-dispatch depth to 1, installs skills, and preserves upstream MIT notices.

## Cleanup
A temporary parallel Python implementation created during integration was removed after discovering the pre-existing Node kernel. Node remains the single canonical implementation.
