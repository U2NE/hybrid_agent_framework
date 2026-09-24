import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_ROUTING_POLICY,
  fallbackToSessionInheritance,
  resolveRoleRouting,
  routeForDifficulty,
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

test('routing policy records the verified Codex 0.156.1 effort surface', () => {
  assert.equal(MODEL_ROUTING_POLICY.schema, 'hybrid-model-routing/v2');
  assert.deepEqual(
    MODEL_ROUTING_POLICY.runtime_surface.luna_supported_efforts,
    ['low', 'medium', 'high', 'xhigh', 'max']
  );
  assert.deepEqual(
    MODEL_ROUTING_POLICY.runtime_surface.sol_supported_efforts,
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  );
  assert.equal(MODEL_ROUTING_POLICY.default_route, 'luna_medium');
});

test('difficulty profiles use the Luna effort ladder before Sol', () => {
  const expected = {
    routine: ['luna_medium', 'gpt-6-luna', 'medium'],
    moderate: ['luna_high', 'gpt-6-luna', 'high'],
    hard: ['luna_xhigh', 'gpt-6-luna', 'xhigh'],
    very_hard: ['luna_max', 'gpt-6-luna', 'max'],
    exceptional: ['sol_high', 'gpt-6-sol', 'high'],
    critical: ['sol_xhigh', 'gpt-6-sol', 'xhigh'],
    extreme: ['sol_max', 'gpt-6-sol', 'max'],
  };

  for (const [difficulty, [level, model, effort]] of Object.entries(expected)) {
    assert.equal(routeForDifficulty(difficulty), level);
    const route = resolveRoleRouting('implementer', { routeLevel: level });
    assert.equal(route.routeLevel, level);
    assert.equal(route.model, model);
    assert.equal(route.reasoningEffort, effort);
  }
});

test('role name alone never forces architect, plan auditor, or security reviewer onto Sol', () => {
  const architect = resolveRoleRouting('architect');
  assert.equal(architect.routeLevel, 'luna_xhigh');
  assert.equal(architect.modelTier, 'luna');

  const auditor = resolveRoleRouting('plan-auditor');
  assert.equal(auditor.routeLevel, 'luna_xhigh');
  assert.equal(auditor.modelTier, 'luna');

  const security = resolveRoleRouting('security-reviewer');
  assert.equal(security.routeLevel, 'luna_max');
  assert.equal(security.modelTier, 'luna');
});

test('architecture and security reasoning escalate by difficulty, not role name', () => {
  const importantArchitect = resolveRoleRouting('architect', {
    context: { importantArchitecturalDecision: true },
  });
  assert.equal(importantArchitect.routeLevel, 'luna_max');

  const unresolvedArchitect = resolveRoleRouting('architect', {
    context: { unresolvedArchitecture: true },
  });
  assert.equal(unresolvedArchitect.routeLevel, 'sol_high');

  const boundedSecurity = resolveRoleRouting('security-reviewer', {
    context: { securitySensitive: true },
  });
  assert.equal(boundedSecurity.routeLevel, 'luna_max');

  const exploitSecurity = resolveRoleRouting('security-reviewer', {
    context: { complexSecurityReasoning: true, exploitReasoning: true },
  });
  assert.equal(exploitSecurity.routeLevel, 'sol_high');

  const criticalSecurity = resolveRoleRouting('security-reviewer', {
    context: { criticalSecurityJudgment: true },
  });
  assert.equal(criticalSecurity.routeLevel, 'sol_max');
});

test('failure-driven escalation stays in Luna before Sol and is stage-local', () => {
  const firstFailure = resolveRoleRouting('verifier', {
    context: { verificationFailures: 1 },
  });
  assert.equal(firstFailure.routeLevel, 'luna_high');
  assert.equal(firstFailure.modelTier, 'luna');

  const secondFailure = resolveRoleRouting('verifier', {
    context: { verificationFailures: 2 },
  });
  assert.equal(secondFailure.routeLevel, 'luna_max');
  assert.equal(secondFailure.modelTier, 'luna');

  const lunaMaxRepeat = resolveRoleRouting('security-reviewer', {
    context: { verificationFailures: 1, lunaMaxFailed: true, repeatedSameFailure: true },
  });
  assert.equal(lunaMaxRepeat.routeLevel, 'sol_high');

  const nextRoutineWorker = resolveRoleRouting('implementer');
  assert.equal(nextRoutineWorker.routeLevel, 'luna_medium');
  assert.equal(nextRoutineWorker.model, 'gpt-6-luna');
});

test('routing fails safe to session inheritance when model or effort override is unavailable', () => {
  const route = resolveRoleRouting('security-reviewer', {
    context: { complexSecurityReasoning: true },
  });
  assert.equal(route.model, 'gpt-6-sol');

  const unsupportedOverride = resolveRoleRouting('security-reviewer', {
    modelOverrideSupported: false,
  });
  assert.equal(unsupportedOverride.model, null);
  assert.equal(unsupportedOverride.inheritSessionModel, true);
  assert.equal(unsupportedOverride.fallbackReason, 'model-override-unsupported');

  const missingModel = resolveRoleRouting('architect', {
    supportedModels: ['gpt-6-luna'],
    context: { unresolvedArchitecture: true },
  });
  assert.equal(missingModel.model, null);
  assert.equal(missingModel.fallbackReason, 'model-not-available');

  const missingEffort = resolveRoleRouting('implementer', {
    routeLevel: 'luna_max',
    supportedEffortsByModel: { 'gpt-6-luna': ['medium', 'high', 'xhigh'] },
  });
  assert.equal(missingEffort.model, null);
  assert.equal(missingEffort.fallbackReason, 'reasoning-effort-not-available');

  const runtimeRejected = fallbackToSessionInheritance(route);
  assert.equal(runtimeRejected.model, null);
  assert.equal(runtimeRejected.inheritSessionModel, true);
  assert.equal(runtimeRejected.fallbackReason, 'runtime-model-rejected');

  assert.throws(
    () => resolveRoleRouting('planner', { roleModels: { planner: 'claude-opus-4' } }),
    /Refusing non-OpenAI-looking/
  );
});
