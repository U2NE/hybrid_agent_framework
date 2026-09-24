import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDocumentationDrift } from '../../core/docs/index.mjs';

test('documentation drift selects only durable affected surfaces', () => {
  const result = detectDocumentationDrift({
    files: ['package.json', 'src/api/routes.js', 'tests/api.test.js'],
    description: 'API contract and setup dependency changed',
  });
  assert.equal(result.durableKnowledgeChanged, true);
  assert.ok(result.changedAxes.includes('api'));
  assert.ok(result.changedAxes.includes('dependency'));
  assert.ok(result.changedAxes.includes('testing'));
  assert.ok(result.suggestedDocs.includes('README.md'));
  assert.ok(result.suggestedDocs.includes('docs/API.md'));
});

test('ordinary implementation log does not force durable documentation changes', () => {
  const result = detectDocumentationDrift({
    files: ['src/math/add.js'],
    description: 'Implement arithmetic helper',
  });
  assert.equal(result.durableKnowledgeChanged, false);
  assert.deepEqual(result.suggestedDocs, []);
});


test('routing documentation stays semantically aligned with canonical Luna-first policy', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const policy = JSON.parse(await fs.readFile(path.join(root, 'core/routing/model-routing.json'), 'utf8'));
  const plan = await fs.readFile(path.join(root, 'skills/plan/SKILL.md'), 'utf8');
  const runtimeReadme = await fs.readFile(path.join(root, 'runtime-smoke/README.md'), 'utf8');
  const runtimeDoc = await fs.readFile(path.join(root, 'docs/architecture/RUNTIME-SMOKE.md'), 'utf8');

  assert.equal(policy.default_route, 'luna_medium');
  assert.equal(policy.profiles.moderate, 'luna_high');
  assert.equal(policy.profiles.hard, 'luna_xhigh');
  assert.equal(policy.profiles.very_hard, 'luna_max');
  assert.equal(policy.profiles.exceptional, 'sol_high');

  assert.match(plan, /raises Luna reasoning effort first/i);
  assert.match(plan, /Sol is reserved for exceptional or unresolved reasoning/i);
  assert.doesNotMatch(plan, /Planner escalates to Sol for high ambiguity/i);

  assert.match(runtimeReadme, /bounded Security Reviewer: Luna max/i);
  assert.match(runtimeReadme, /Code Reviewer: raises Luna effort first/i);
  assert.match(runtimeReadme, /routine Verifier can downshift to Luna medium/i);
  assert.doesNotMatch(runtimeReadme, /Security Reviewer: Sol/i);
  assert.doesNotMatch(runtimeReadme, /Code Reviewer: Sol for the security-sensitive review/i);

  assert.match(runtimeDoc, /bounded security reviewer uses Luna max/i);

  for (const alias of ['.agents/skills/plan/SKILL.md', '.codex/skills/plan/SKILL.md']) {
    const stat = await fs.lstat(path.join(root, alias));
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(
      await fs.realpath(path.join(root, alias)),
      await fs.realpath(path.join(root, 'skills/plan/SKILL.md'))
    );
  }
});
