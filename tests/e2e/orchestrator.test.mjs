import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareExecution } from '../../core/orchestrator/index.mjs';

function route(result, stage) {
  return result.modelRouting.stages.find((entry) => entry.stage === stage);
}

test('bounded work keeps the routine path on Luna and produces dependency waves', () => {
  const result = prepareExecution({
    task: { request: 'Implement parser with these files', files: ['src/parser.js'], acceptanceCriteria: ['parses valid input'] },
    request: 'Implement parser with these files',
    tasks: [
      { id: 'parser', depends_on: [], files_modified: ['src/parser.js'] },
      { id: 'tests', depends_on: ['parser'], files_modified: ['tests/parser.test.js'] },
    ],
  });

  assert.equal(result.classification.name, 'bounded');
  assert.ok(result.pipeline.includes('planner'));
  assert.ok(result.pipeline.includes('verifier'));
  assert.equal(result.pipeline.includes('architect'), false);
  assert.equal(route(result, 'planner').model, 'gpt-6-luna');
  assert.equal(route(result, 'implementer').model, 'gpt-6-luna');
  assert.equal(route(result, 'verifier').model, 'gpt-6-luna');
  assert.deepEqual(result.waves.map((wave) => wave.map((task) => task.id)), [['parser'], ['tests']]);
});

test('complex architectural work escalates planning council to Sol while worker stages can downshift to Luna', () => {
  const result = prepareExecution({
    task: {
      request: 'Refactor architecture across parser and cache modules',
      files: ['src/parser.js', 'src/cache.js'],
      components: ['parser', 'cache'],
      complex: true,
    },
    request: 'Refactor architecture across parser and cache modules',
    architecturalChange: true,
    tasks: [
      { id: 'parser', depends_on: [], files_modified: ['src/parser.js'] },
      { id: 'cache', depends_on: [], files_modified: ['src/cache.js'] },
    ],
  });

  assert.ok(result.pipeline.includes('architect'));
  assert.ok(result.pipeline.includes('plan-auditor'));
  assert.equal(route(result, 'planner').model, 'gpt-6-sol');
  assert.equal(route(result, 'architect').model, 'gpt-6-sol');
  assert.equal(route(result, 'plan-auditor').model, 'gpt-6-sol');
  assert.equal(route(result, 'implementer').model, 'gpt-6-luna');
  assert.deepEqual(result.waves.map((wave) => wave.map((task) => task.id)), [['cache', 'parser']]);
});

test('security-sensitive plan adds a Sol security reviewer and preserves independent QA lanes', () => {
  const result = prepareExecution({
    task: { request: 'Change auth permission checks', files: ['src/auth.js'] },
    request: 'Change auth permission checks',
    tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
  });
  assert.equal(result.securityReview, true);
  for (const stage of ['tester', 'code-reviewer', 'security-reviewer', 'verifier']) assert.ok(result.pipeline.includes(stage));
  assert.equal(route(result, 'security-reviewer').model, 'gpt-6-sol');
});

test('repeated verification failure escalates difficult review and verification without making escalation sticky', () => {
  const result = prepareExecution({
    task: { request: 'Fix parser failure', files: ['src/parser.js'] },
    request: 'Fix parser failure',
    verificationFailures: 2,
    difficultReview: true,
    tasks: [{ id: 'fix', depends_on: [], files_modified: ['src/parser.js'] }],
  });

  assert.equal(route(result, 'code-reviewer').model, 'gpt-6-sol');
  assert.equal(route(result, 'verifier').model, 'gpt-6-sol');
  assert.equal(route(result, 'knowledge-synthesizer').model, 'gpt-6-luna');
});

test('high-ambiguity requirements reasoning escalates the requirements gate to Sol', () => {
  const result = prepareExecution({
    task: { request: 'make it better', ambiguous: true },
    request: 'make it better',
    spec: {
      type: 'brownfield',
      goal: 'Improve behavior',
      topology: [{ id: 'core', clarity: { goal: 0.4, constraints: 0.5, criteria: 0.4, context: 0.6 } }],
      acceptanceCriteria: ['approved behavior is specified'],
    },
  });

  assert.equal(result.classification.name, 'ambiguous');
  const gate = route(result, 'requirements-gate');
  assert.ok(gate);
  assert.equal(gate.agentRole, 'researcher');
  assert.equal(gate.model, 'gpt-6-sol');
  assert.ok(gate.escalationReasons.includes('high-ambiguity'));
});
