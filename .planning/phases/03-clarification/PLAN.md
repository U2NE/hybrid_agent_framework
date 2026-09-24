# PLAN — Clarification Port

## Wave 1

- Extend core/requirements/index.mjs with threshold policy and iterative interview state transitions.
- Preserve existing ambiguity functions and tests.

## Wave 2

- Preserve clarification data as a backwards-compatible field in core/state/index.mjs.
- Add clarification provenance to the existing SPEC renderer.
- Rewrite canonical skills/clarify/SKILL.md to reflect the pinned OMC loop without hard floors.

## Wave 3

- Add deep-interview regression tests.
- Add Case D deterministic fixture/report assertions.
- Update front-door and durable clarification documentation.

## Verification

- targeted requirements/state/artifact/smoke tests;
- npm run check;
- npm test;
- npm run smoke:preflight;
- wiki lint;
- repository STATE recovery;
- Codex authentication status;
- live D must remain pending rather than simulate user answers.
