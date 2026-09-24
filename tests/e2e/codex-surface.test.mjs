import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_ROUTING_POLICY,
  fallbackToSessionInheritance,
  resolveRoleRouting,
} from '../../core/routing/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

test('Codex config registers roles, enables sibling capacity, and leaves model defaults unpinned', async () => {
  const config = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /^\[agents\]$/m);
  assert.match(config, /^enabled = true$/m);
  assert.match(config, /^max_depth = 1$/m);
  assert.match(config, /^max_concurrent_threads_per_session = 8$/m);
  assert.doesNotMatch(config, /^default_subagent_model\s*=/m);
  assert.match(config, /^\[agents\."scout"\]$/m);
  assert.match(config, /^config_file = "agents\/scout\.toml"$/m);
});

test('standalone role config layers carry identity, inherit routed model, and forbid recursive delegation', async () => {
  const dir = path.join(root, '.codex', 'agents');
  const entries = (await fs.readdir(dir)).filter((name) => name.endsWith('.toml'));
  assert.equal(entries.length, 11);

  for (const entry of entries) {
    const role = entry.replace(/\.toml$/, '');
    const text = await fs.readFile(path.join(dir, entry), 'utf8');
    assert.match(text, new RegExp('^name = "' + role.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '"$', 'm'));
    assert.match(text, /^description = ".+"$/m);
    assert.match(text, /^sandbox_mode = "(read-only|workspace-write)"$/m);
    assert.match(text, /^developer_instructions = '''$/m);
    assert.match(text, /Do not spawn or delegate to another subagent/);
    assert.doesNotMatch(text, /^model\s*=/m);
    assert.doesNotMatch(text, /^model_reasoning_effort\s*=/m);
  }
});

test('repository-local skills have one canonical source and valid frontmatter', async () => {
  for (const skill of ['hybrid', 'clarify', 'plan', 'execute', 'review', 'wiki']) {
    const canonical = path.join(root, 'skills', skill, 'SKILL.md');
    const canonicalText = await fs.readFile(canonical, 'utf8');
    assert.match(canonicalText, /^---\nname: [^\n]+\ndescription: [^\n]+\n---\n/);

    for (const aliasRoot of ['.agents/skills', '.codex/skills']) {
      const alias = path.join(root, aliasRoot, skill, 'SKILL.md');
      const stat = await fs.lstat(alias);
      assert.equal(stat.isSymbolicLink(), true);
      assert.equal(await fs.realpath(alias), await fs.realpath(canonical));
    }
  }
});

test('routing policy defaults normal work to Luna and escalates only high-judgment work to Sol', () => {
  assert.equal(MODEL_ROUTING_POLICY.default_model_tier, 'luna');
  assert.equal(MODEL_ROUTING_POLICY.heavy_model_tier, 'sol');

  const worker = resolveRoleRouting('implementer');
  assert.equal(worker.modelTier, 'luna');
  assert.equal(worker.model, 'gpt-6-luna');
  assert.equal(worker.inheritSessionModel, false);

  const routinePlanner = resolveRoleRouting('planner');
  assert.equal(routinePlanner.modelTier, 'luna');
  assert.equal(routinePlanner.model, 'gpt-6-luna');

  const complexTaskPlanner = resolveRoleRouting('planner', { context: { classification: 'complex' } });
  assert.equal(complexTaskPlanner.modelTier, 'sol');
  assert.equal(complexTaskPlanner.model, 'gpt-6-sol');
  assert.ok(complexTaskPlanner.escalationReasons.includes('complex-planning'));

  const complexPlanner = resolveRoleRouting('planner', { context: { architecturalChange: true } });
  assert.equal(complexPlanner.modelTier, 'sol');
  assert.equal(complexPlanner.model, 'gpt-6-sol');

  const architect = resolveRoleRouting('architect');
  assert.equal(architect.modelTier, 'sol');
  assert.equal(architect.model, 'gpt-6-sol');

  const complexDebugger = resolveRoleRouting('implementer', {
    context: { complexDebugging: true, crossModuleDebugging: true },
  });
  assert.equal(complexDebugger.modelTier, 'sol');
  assert.equal(complexDebugger.model, 'gpt-6-sol');

  const routineVerifier = resolveRoleRouting('verifier');
  assert.equal(routineVerifier.modelTier, 'luna');
  const escalatedVerifier = resolveRoleRouting('verifier', { context: { verificationFailures: 2 } });
  assert.equal(escalatedVerifier.modelTier, 'sol');
});

test('routing downshifts after a Sol stage and fails safe to session inheritance when override is unavailable', () => {
  const heavy = resolveRoleRouting('code-reviewer', { context: { difficultReview: true } });
  assert.equal(heavy.model, 'gpt-6-sol');

  const nextRoutineWorker = resolveRoleRouting('implementer');
  assert.equal(nextRoutineWorker.model, 'gpt-6-luna');

  const unsupportedOverride = resolveRoleRouting('security-reviewer', { modelOverrideSupported: false });
  assert.equal(unsupportedOverride.model, null);
  assert.equal(unsupportedOverride.inheritSessionModel, true);
  assert.equal(unsupportedOverride.fallbackReason, 'model-override-unsupported');

  const missingModel = resolveRoleRouting('architect', { supportedModels: ['gpt-6-luna'] });
  assert.equal(missingModel.model, null);
  assert.equal(missingModel.fallbackReason, 'model-not-available');

  const runtimeRejected = fallbackToSessionInheritance(heavy);
  assert.equal(runtimeRejected.model, null);
  assert.equal(runtimeRejected.inheritSessionModel, true);
  assert.equal(runtimeRejected.fallbackReason, 'runtime-model-rejected');

  assert.throws(
    () => resolveRoleRouting('planner', { roleModels: { planner: 'claude-opus-4' } }),
    /Refusing non-OpenAI-looking/
  );
});
