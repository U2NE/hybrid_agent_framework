import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionGraphError,
  materialRevisionReasons,
  requestLeaseExtension,
  sealExecutionPlan,
  validateSealedExecutionGraph,
} from '../../core/execution-graph/index.mjs';

const plan = {
  phase: 'auth',
  tasks: [
    {
      id: 'api',
      goal: 'Update API',
      files_modified: ['src/api.js'],
      reads: ['src/types.js'],
      resources: [{ key: 'contract:user-api', mode: 'exclusive' }],
      depends_on: [],
      acceptance_criteria: ['api works'],
      verify: 'node --test tests/api.test.js',
      owner: 'implementer',
    },
    {
      id: 'client',
      goal: 'Update client',
      files_modified: ['src/client.js'],
      depends_on: ['api'],
      acceptance_criteria: ['client works'],
      verify: 'node --test tests/client.test.js',
      owner: 'implementer',
    },
  ],
};

test('approved plan seals into a deterministic hash-bound execution graph', () => {
  const input = {
    runId: 'run-1',
    revisionId: 'G1',
    approvalScopeHash: 'approval-hash',
    specHash: 'spec-hash',
    concurrencyLimit: 4,
  };
  const first = sealExecutionPlan(plan, input);
  const second = sealExecutionPlan(plan, input);

  assert.equal(first.schema, 'hybrid-exec-graph/v2');
  assert.equal(first.descriptorHash, second.descriptorHash);
  assert.equal(first.approvalScopeHash, 'approval-hash');
  assert.equal(first.terminalVerificationNodeId, 'verify-final');
  assert.deepEqual(first.entryNodeIds, ['api']);
  assert.equal(first.concurrencyLimit, 4);
  assert.ok(first.nodes.some((node) => node.id === 'verify-final' && node.kind === 'verification'));
  assert.equal(validateSealedExecutionGraph(first), true);
});

test('execution sealing fails closed without an approval scope', () => {
  assert.throws(
    () => sealExecutionPlan(plan, { runId: 'run-1' }),
    (error) => error instanceof ExecutionGraphError && error.code === 'APPROVAL_SCOPE_REQUIRED'
  );
});

test('descriptor tampering is detected before execution', () => {
  const graph = sealExecutionPlan(plan, {
    runId: 'run-1',
    approvalScopeHash: 'approval-hash',
  });
  const tampered = structuredClone(graph);
  const node = tampered.nodes.find((item) => item.id === 'client');
  node.filesModified.push('src/escape.js');

  assert.throws(
    () => validateSealedExecutionGraph(tampered),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.details.errors.includes('descriptor hash mismatch')
  );
});

test('non-material lease extension creates a child revision and preserves approval scope', () => {
  const graph = sealExecutionPlan(plan, {
    runId: 'run-1',
    revisionId: 'G1',
    approvalScopeHash: 'approval-hash',
  });

  const result = requestLeaseExtension(graph, {
    taskId: 'client',
    resources: [{ key: 'contract:user-api', mode: 'exclusive' }],
  });

  assert.equal(result.applied, true);
  assert.equal(result.status, 'amended');
  assert.equal(result.graph.revisionId, 'G2');
  assert.equal(result.graph.parentDescriptorHash, graph.descriptorHash);
  assert.equal(result.graph.approvalScopeHash, graph.approvalScopeHash);
  assert.notEqual(result.graph.descriptorHash, graph.descriptorHash);
  assert.equal(result.requiresReschedule, true);
  assert.deepEqual(result.conflicts, ['api']);
  assert.equal(validateSealedExecutionGraph(result.graph), true);
});

test('material semantic lease request requires user approval and does not mutate graph', () => {
  const graph = sealExecutionPlan(plan, {
    runId: 'run-1',
    approvalScopeHash: 'approval-hash',
  });

  const result = requestLeaseExtension(graph, {
    taskId: 'client',
    resources: ['schema:users'],
    publicApiChanged: true,
    securityPostureChanged: true,
  });

  assert.equal(result.applied, false);
  assert.equal(result.status, 'user-approval-required');
  assert.deepEqual(result.reasons, ['PUBLIC_API_CHANGE', 'SECURITY_POSTURE_CHANGE']);
  assert.equal(result.graph, graph);
});

test('material revision classification is deterministic and explicit', () => {
  assert.deepEqual(
    materialRevisionReasons({
      material: true,
      featureScopeChanged: true,
      productBehaviorChanged: true,
    }),
    ['EXPLICIT_MATERIAL_REVISION', 'FEATURE_SCOPE_CHANGE', 'PRODUCT_BEHAVIOR_CHANGE']
  );
});
