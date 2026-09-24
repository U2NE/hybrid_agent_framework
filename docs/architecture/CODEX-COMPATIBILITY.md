# Codex Compatibility Notes

## Pinned GSD evidence

At GSD Core `9db80da9a047ddaa9cc8812a5d6adab446fe8433`, the inspected adapter uses standalone agent TOMLs, a root `[agents]` table, and flat-dispatch-oriented configuration.

## Codex 0.156.1 surface verified during this audit

The current npm package is `@openai/codex 0.156.1`.

Verified locally with strict config loading:

- `[agents]` and custom `[agents.<name>]` registration.
- `description` and `config_file` role registration.
- `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort`.
- `agents.max_concurrent_threads_per_session`.
- `max_depth = 1` is accepted by the 0.156.1 strict parser, but Hybrid treats it only as a compatibility guard because the current public config reference does not document it.
- standalone agent config layers with `name`, `description`, and `developer_instructions`.
- repository-local skills under `.agents/skills/*/SKILL.md` with YAML `name` and `description`.

Flat dispatch is therefore enforced primarily by architecture: only the lead dispatches sibling workers, every Hybrid worker explicitly forbids recursive delegation, dependency waves decide sibling eligibility, and same-file writers serialize.

## Model catalog and routing

`codex debug models` on 0.156.1 returned both concrete IDs:

- `gpt-6-luna`
- `gpt-6-sol`

Hybrid stores those IDs only in `core/routing/model-routing.json`:

- default tier: Luna;
- heavy tier: Sol;
- fallback: session inheritance.

Static role TOMLs do not pin a model. The lead resolves routing per stage so a high-judgment Sol stage can be followed by routine Luna workers. If an explicit model is unavailable or rejected, the intended retry omits model/reasoning overrides rather than guessing another ID.

Hybrid intentionally does not set `agents.default_subagent_model` globally because a global Luna pin would prevent a no-override retry from reaching the normal Codex session/default inheritance path.

## Runtime boundary

Strict-config loading is verified. Actual authenticated model-backed subagent spawn, sibling parallel execution, handoff/result collection, and runtime application/fallback of per-spawn model overrides remain `runtime validation pending` because this WSL has no Codex credentials.

Use `scripts/runtime-smoke.mjs --live A|B|C` after authentication.
