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
  assert.equal(route(result, 'planner').routeLevel, 'luna_medium');
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
  assert.equal(route(result, 'verifier').routeLevel, 'luna_medium');
  assert.deepEqual(result.waves.map((wave) => wave.map((task) => task.id)), [['parser'], ['tests']]);
});

test('complex architecture uses high Luna effort before Sol while routine implementation downshifts', () => {
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
  assert.equal(route(result, 'planner').routeLevel, 'luna_xhigh');
  assert.equal(route(result, 'architect').routeLevel, 'luna_max');
  assert.equal(route(result, 'plan-auditor').routeLevel, 'luna_xhigh');
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
  assert.deepEqual(result.waves.map((wave) => wave.map((task) => task.id)), [['cache', 'parser']]);
});

test('exceptionally difficult unresolved architecture can enter Sol while following routine stage downshifts', () => {
  const result = prepareExecution({
    task: {
      request: 'Architecture migration across session and token middleware',
      files: ['src/session.js', 'src/token.js'],
      components: ['session', 'token'],
      complex: true,
    },
    request: 'Architecture migration across session and token middleware',
    architecturalChange: true,
    unresolvedArchitecture: true,
    tasks: [{ id: 'change', depends_on: [], files_modified: ['src/session.js'] }],
  });

  assert.equal(route(result, 'architect').routeLevel, 'sol_high');
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
});

test('bounded security-sensitive review uses Luna max and preserves independent QA lanes', () => {
  const result = prepareExecution({
    task: { request: 'Change auth permission checks', files: ['src/auth.js'] },
    request: 'Change auth permission checks',
    tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
  });
  assert.equal(result.securityReview, true);
  for (const stage of ['tester', 'code-reviewer', 'security-reviewer', 'verifier']) {
    assert.ok(result.pipeline.includes(stage));
  }
  assert.equal(route(result, 'security-reviewer').routeLevel, 'luna_max');
});

test('complex exploit reasoning can escalate security reviewer to Sol', () => {
  const result = prepareExecution({
    task: { request: 'Review authorization trust boundary exploit path', files: ['src/auth.js'] },
    request: 'Review authorization trust boundary exploit path',
    complexSecurityReasoning: true,
    exploitReasoning: true,
    tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
  });
  assert.equal(result.securityReview, true);
  assert.equal(route(result, 'security-reviewer').routeLevel, 'sol_high');
});

test('verification failures increase Luna effort before Sol and do not make escalation sticky', () => {
  const once = prepareExecution({
    task: { request: 'Fix parser failure', files: ['src/parser.js'] },
    request: 'Fix parser failure',
    verificationFailures: 1,
    tasks: [{ id: 'fix', depends_on: [], files_modified: ['src/parser.js'] }],
  });
  assert.equal(route(once, 'verifier').routeLevel, 'luna_high');

  const twice = prepareExecution({
    task: { request: 'Fix parser failure', files: ['src/parser.js'] },
    request: 'Fix parser failure',
    verificationFailures: 2,
    difficultReview: true,
    tasks: [{ id: 'fix', depends_on: [], files_modified: ['src/parser.js'] }],
  });
  assert.equal(route(twice, 'code-reviewer').routeLevel, 'luna_max');
  assert.equal(route(twice, 'verifier').routeLevel, 'luna_max');

  const routine = prepareExecution({
    task: { request: 'Update parser message', files: ['src/parser.js'] },
    request: 'Update parser message',
    tasks: [{ id: 'edit', depends_on: [], files_modified: ['src/parser.js'] }],
  });
  assert.equal(route(routine, 'implementer').routeLevel, 'luna_medium');
});

test('high-ambiguity requirements reasoning uses Luna max before Sol', () => {
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
  assert.equal(gate.routeLevel, 'luna_max');
  assert.ok(gate.escalationReasons.includes('high-ambiguity'));
});
