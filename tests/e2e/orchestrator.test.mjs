import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareExecution } from '../../core/orchestrator/index.mjs';

function route(result, stage) {
  return result.modelRouting.stages.find((entry) => entry.stage === stage);
}

test('Tier 0 trivial work uses implementer plus lightweight verification only', () => {
  const result = prepareExecution({
    task: { request: '오타 한 줄 수정', files: ['README.md'] },
    request: '오타 한 줄 수정',
    tasks: [{ id: 'edit', depends_on: [], files_modified: ['README.md'] }],
  });

  assert.equal(result.classification.name, 'trivial');
  assert.deepEqual(result.pipeline, ['implementer', 'lightweight-verify']);
  assert.equal(result.modelRouting.stages.length, 1);
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
});

test('Tier 1 bounded default avoids scout planner tester reviewer and knowledge fan-out', () => {
  const result = prepareExecution({
    task: { request: 'Update src/parser.js error message', files: ['src/parser.js'] },
    request: 'Update src/parser.js error message',
    tasks: [{ id: 'parser', depends_on: [], files_modified: ['src/parser.js'] }],
  });

  assert.equal(result.classification.name, 'bounded');
  assert.deepEqual(result.pipeline, ['implementer', 'verifier']);
  assert.equal(result.needs.scout, false);
  assert.equal(result.needs.planning, false);
  assert.equal(result.needs.tester, false);
  assert.equal(result.needs.review, false);
  assert.equal(result.needs.knowledge, false);
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
  assert.equal(route(result, 'verifier').routeLevel, 'luna_medium');
});

test('execution graph is sealed only after explicit execution approval', () => {
  const base = {
    task: { request: 'Update parser behavior', files: ['src/parser.js'] },
    request: 'Update parser behavior',
    runId: 'run-approved',
    tasks: [{ id: 'parser', depends_on: [], files_modified: ['src/parser.js'] }],
  };

  const pending = prepareExecution(base);
  assert.equal(pending.executionGraph, null);

  const approved = prepareExecution({
    ...base,
    executionApproved: true,
    approvalScopeHash: 'approved-scope',
  });
  assert.equal(approved.executionGraph.schema, 'hybrid-exec-graph/v2');
  assert.equal(approved.executionGraph.runId, 'run-approved');
  assert.equal(approved.executionGraph.approvalScopeHash, 'approved-scope');
  assert.ok(approved.executionGraph.descriptorHash);

  assert.throws(
    () => prepareExecution({ ...base, executionApproved: true }),
    /approvalScopeHash or approvalScope is required/
  );
});

test('Tier 1 conditionally adds planning, tester, and reviewer only when evidence requires them', () => {
  const result = prepareExecution({
    task: {
      request: 'Implement parser behavior using src/parser.js and tests/parser.test.js',
      files: ['src/parser.js', 'tests/parser.test.js'],
    },
    request: 'Implement parser behavior using src/parser.js and tests/parser.test.js',
    newBehavior: true,
    meaningfulLogicChange: true,
    tasks: [
      { id: 'parser', depends_on: [], files_modified: ['src/parser.js'] },
      { id: 'tests', depends_on: ['parser'], files_modified: ['tests/parser.test.js'] },
    ],
  });

  assert.deepEqual(
    result.pipeline,
    ['planner', 'scheduler', 'implementer', 'tester', 'code-reviewer', 'verifier']
  );
  assert.deepEqual(result.waves.map((wave) => wave.map((task) => task.id)), [['parser'], ['tests']]);
});

test('Tier 2 ordinary complex work keeps council conditional and skips knowledge without durable change', () => {
  const result = prepareExecution({
    task: {
      request: 'Coordinate parser and cache behavior',
      files: ['src/parser.js', 'src/cache.js'],
      components: ['parser', 'cache'],
      complex: true,
    },
    request: 'Coordinate parser and cache behavior',
    tasks: [
      { id: 'parser', depends_on: [], files_modified: ['src/parser.js'] },
      { id: 'cache', depends_on: [], files_modified: ['src/cache.js'] },
    ],
  });

  assert.equal(result.classification.name, 'complex');
  assert.deepEqual(result.pipeline, [
    'scout',
    'spec-lite',
    'user-approval',
    'planner',
    'scheduler',
    'implementer',
    'tester',
    'code-reviewer',
    'verifier',
    'integrate',
    'full-test',
  ]);
  assert.equal(result.pipeline.includes('architect'), false);
  assert.equal(result.pipeline.includes('knowledge-synthesizer'), false);
});

test('Tier 2 architecture risk activates one planning council and durable knowledge update', () => {
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

  for (const stage of ['architect', 'plan-auditor', 'knowledge-synthesizer', 'wiki-lint']) {
    assert.ok(result.pipeline.includes(stage));
  }
  assert.equal(route(result, 'planner').routeLevel, 'luna_xhigh');
  assert.equal(route(result, 'architect').routeLevel, 'luna_max');
  assert.equal(route(result, 'plan-auditor').routeLevel, 'luna_xhigh');
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');
});

test('Tier 3 ambiguous work retains clarification, council, and full quality flow', () => {
  const result = prepareExecution({
    task: { request: '알아서 로그인 잘 만들어줘', ambiguous: true },
    request: '알아서 로그인 잘 만들어줘',
    tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
  });

  assert.equal(result.classification.name, 'ambiguous');
  for (const stage of [
    'scout',
    'requirements-gate',
    'user-approval',
    'researcher',
    'planner',
    'architect',
    'plan-auditor',
    'scheduler',
    'implementer',
    'tester',
    'code-reviewer',
    'verifier',
    'integrate',
    'full-test',
  ]) {
    assert.ok(result.pipeline.includes(stage), stage);
  }
});

test('bounded security-sensitive work activates quality lanes but starts security reviewer at Luna max', () => {
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

test('complex exploit reasoning reaches Luna Max before targeted failure can enter Sol', () => {
  const base = {
    task: { request: 'Review authorization trust boundary exploit path', files: ['src/auth.js'] },
    request: 'Review authorization trust boundary exploit path',
    complexSecurityReasoning: true,
    exploitReasoning: true,
    tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
  };
  const result = prepareExecution(base);
  assert.equal(route(result, 'security-reviewer').routeLevel, 'luna_max');
  assert.equal(route(result, 'implementer').routeLevel, 'luna_medium');

  const escalated = prepareExecution({
    ...base,
    failureEnvelope: {
      kind: 'security-reasoning',
      stage: 'review',
      targetRole: 'security-reviewer',
      attemptedRoute: 'luna_max',
      sameFailureCount: 2,
      semanticProgress: 'none',
    },
  });
  assert.equal(route(escalated, 'security-reviewer').routeLevel, 'sol_high');
  assert.equal(route(escalated, 'implementer').routeLevel, 'luna_medium');
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
    meaningfulLogicChange: true,
    difficultReview: true,
    tasks: [{ id: 'fix', depends_on: [], files_modified: ['src/parser.js'] }],
  });
  assert.equal(route(twice, 'code-reviewer').routeLevel, 'luna_xhigh');
  assert.equal(route(twice, 'verifier').routeLevel, 'luna_xhigh');

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

  const gate = route(result, 'requirements-gate');
  assert.equal(gate.routeLevel, 'luna_max');
  assert.ok(gate.escalationReasons.includes('high-ambiguity'));
});

test('risky parallel writers use worktree isolation and unavailable worktrees fall back to serialization', () => {
  const input = {
    task: {
      request: 'Update package metadata and generated client independently',
      files: ['package-lock.json', 'generated/client.js'],
      bounded: true,
    },
    request: 'Update package metadata and generated client independently',
    tasks: [
      { id: 'lock', depends_on: [], files_modified: ['package-lock.json'] },
      { id: 'client', depends_on: [], files_modified: ['generated/client.js'], generated_files: true },
    ],
  };

  const isolated = prepareExecution({ ...input, worktreeAvailable: true });
  assert.deepEqual(isolated.waves.map((wave) => wave.map((task) => task.id)), [['client', 'lock']]);
  assert.equal(isolated.isolationPlan.isolation[0].mode, 'worktree');

  const fallback = prepareExecution({ ...input, worktreeAvailable: false });
  assert.deepEqual(fallback.waves.map((wave) => wave.map((task) => task.id)), [['client'], ['lock']]);
  assert.ok(fallback.isolationPlan.isolation.every((entry) => entry.reason === 'worktree-unavailable-safe-serialization'));
});


test('evidence repair cache QE and observability helpers add no default fast-path stages', () => {
  const forbidden = new Set([
    'repair',
    'repair-controller',
    'qe',
    'qe-agent',
    'context-cache',
    'context-snapshot',
    'observability',
    'evidence-collector',
  ]);

  const tier0 = prepareExecution({
    task: { request: '오타 한 줄 수정', files: ['README.md'] },
    request: '오타 한 줄 수정',
    tasks: [{ id: 'edit', depends_on: [], files_modified: ['README.md'] }],
  });
  assert.deepEqual(tier0.pipeline, ['implementer', 'lightweight-verify']);
  assert.equal(tier0.pipeline.some((stage) => forbidden.has(stage)), false);

  const tier1 = prepareExecution({
    task: { request: 'Update src/parser.js error message', files: ['src/parser.js'] },
    request: 'Update src/parser.js error message',
    tasks: [{ id: 'parser', depends_on: [], files_modified: ['src/parser.js'] }],
  });
  assert.deepEqual(tier1.pipeline, ['implementer', 'verifier']);
  assert.equal(tier1.pipeline.some((stage) => forbidden.has(stage)), false);
});
