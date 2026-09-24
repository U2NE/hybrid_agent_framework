# Verification

## Commands

```bash
npm test
npm run check
node scripts/lint-wiki.mjs .ai/wiki
python3 - <<'PY'
import tomllib, pathlib
root=pathlib.Path('.codex')
with open(root/'config.toml','rb') as f: tomllib.load(f)
for p in sorted((root/'agents').glob('*.toml')):
    with open(p,'rb') as f: tomllib.load(f)
PY
```

## Result

- Deterministic tests: **33 passed, 0 failed**.
- Syntax checks: passed for all core modules, CLI, and project installer.
- Wiki lint: clean; no broken links, stale pages, oversized pages, orphan pages, or structural contradictions in the bootstrap wiki.
- TOML parsing: project config and all 11 standalone agent TOMLs parse successfully.
- Installer tests verify preservation of existing Codex config, `AGENTS.md`, existing planning docs, dry-run behavior, state initialization, skill installation, and propagation of both upstream MIT notices.
- Canonical bootstrap `PLAN.md` is machine-readable and compiles into two dependency waves.

## Not verified in this environment

A live Codex host dispatch smoke test was not run because the current WSL environment has no `codex` executable. Therefore current host-side agent discovery, actual subagent dispatch, and locally supported concrete model IDs remain Phase 01 verification work.
