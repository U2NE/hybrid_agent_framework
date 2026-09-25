import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserApprovalReceipt } from '../../core/approval/index.mjs';
import {
  ExecutionGraphError,
  executionApprovalSubject,
  materialRevisionReasons,
  requestLeaseExtension,
  sealExecutionPlan,
  validateSealedExecutionGraph,
} from '../../core/execution-graph/index.mjs';
import {
  sealApprovedExecutionPlan,
  testApprovalReceipt,
} from '../helpers/execution-approval.mjs';

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

test('approved plan seals into a deterministic receipt-bound execution graph', () => {
  const input = {
    runId: 'run-1',
    revisionId: 'G1',
    concurrencyLimit: 4,
  };
  const receipt = testApprovalReceipt(plan, input);
  const first = sealExecutionPlan(plan, { ...input, approvalReceipt: receipt });
  const second = sealExecutionPlan(plan, { ...input, approvalReceipt: receipt });

  assert.equal(first.schema, 'hybrid-exec-graph/v3');
  assert.equal(first.descriptorHash, second.descriptorHash);
  assert.equal(first.approvalScopeHash, receipt.receiptHash);
  assert.deepEqual(first.approvalReceipt, receipt);
  assert.equal(first.specHash, receipt.specHash);
  assert.equal(first.planHash, receipt.planHash);
  assert.equal(first.terminalVerificationNodeId, 'verify-final');
  assert.deepEqual(first.entryNodeIds, ['api']);
  assert.equal(first.concurrencyLimit, 4);
  assert.ok(first.nodes.some((node) => node.id === 'verify-final' && node.kind === 'verification'));
  assert.equal(validateSealedExecutionGraph(first), true);
});

test('sealed graph carries deterministic role capability grants', () => {
  const graph = sealApprovedExecutionPlan(plan, {
    runId: 'run-capabilities',
  });
  const api = graph.nodes.find((node) => node.id === 'api');
  const verifier = graph.nodes.find((node) => node.id === 'verify-final');

  assert.deepEqual(api.capabilityGrant, {
    sandboxMode: 'workspace-write',
    writeScope: 'leased-task',
    capabilities: ['fs.read', 'fs.write.leased', 'process.execute'],
  });
  assert.equal(verifier.capabilityGrant.sandboxMode, 'read-only');
  assert.equal(verifier.capabilityGrant.writeScope, 'none');
});

test('read-only roles cannot be sealed as mutating execution owners', () => {
  for (const owner of ['planner', 'code-reviewer', 'verifier']) {
    assert.throws(
      () => sealExecutionPlan({
        tasks: [{
          id: 'bad-' + owner,
          owner,
          files_modified: ['src/a.js'],
          depends_on: [],
        }],
      }, {
        runId: 'run-' + owner,
      }),
      (error) => error?.code === 'ROLE_WRITE_DENIED'
    );
  }
});

test('capability grant tampering fails sealed graph validation', () => {
  const graph = sealApprovedExecutionPlan(plan, {
    runId: 'run-cap-tamper',
  });
  const tampered = structuredClone(graph);
  const api = tampered.nodes.find((node) => node.id === 'api');
  api.capabilityGrant.capabilities.push('network.write');

  assert.throws(
    () => validateSealedExecutionGraph(tampered),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.details.errors.some((item) =>
        item.includes('capability policy violation: api') ||
        item.includes('capability grant mismatch: api')
      )
  );
});

test('design executor seals only with an exclusive UI resource lease', () => {
  const designPlan = {
    tasks: [{
      id: 'design-checkout',
      owner: 'design-executor',
      files_modified: ['src/components/Checkout.tsx'],
      resources: [{ key: 'ui:checkout', mode: 'exclusive' }],
      depends_on: [],
    }],
  };
  const graph = sealApprovedExecutionPlan(designPlan, {
    runId: 'run-design',
  });

  const node = graph.nodes.find((item) => item.id === 'design-checkout');
  assert.equal(node.capabilityGrant.writeScope, 'leased-ui');
  assert.ok(node.capabilityGrant.capabilities.includes('ui.implement'));
  assert.equal(validateSealedExecutionGraph(graph), true);

  assert.throws(
    () => sealExecutionPlan({
      tasks: [{
        id: 'design-without-lease',
        owner: 'design-executor',
        files_modified: ['src/components/Checkout.tsx'],
        depends_on: [],
      }],
    }, {
      runId: 'run-design-no-lease',
    }),
    (error) => error?.code === 'UI_LEASE_REQUIRED'
  );
});

test('execution sealing fails closed without a user approval receipt', () => {
  assert.throws(
    () => sealExecutionPlan(plan, { runId: 'run-1' }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'APPROVAL_RECEIPT_REQUIRED'
  );
});

test('approval receipt cannot be reused for a different execution plan', () => {
  const runId = 'run-reuse';
  const receipt = testApprovalReceipt(plan, { runId });
  const changed = structuredClone(plan);
  changed.tasks[1].files_modified = ['src/other-client.js'];

  assert.throws(
    () => sealExecutionPlan(changed, { runId, approvalReceipt: receipt }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'APPROVAL_SUBJECT_MISMATCH' &&
      error.details.mismatches.some((item) => item.field === 'planHash')
  );
});

test('approval receipt tampering fails validation before execution', () => {
  const runId = 'run-receipt-tamper';
  const receipt = structuredClone(testApprovalReceipt(plan, { runId }));
  receipt.approvedAt = '2026-01-02T00:00:00.000Z';

  assert.throws(
    () => sealExecutionPlan(plan, { runId, approvalReceipt: receipt }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'INVALID_APPROVAL_RECEIPT'
  );
});

test('caller cannot substitute planHash or specHash for the content being approved', () => {
  const wrong = '0'.repeat(64);

  assert.throws(
    () => executionApprovalSubject(plan, {
      runId: 'run-hash-mismatch',
      planHash: wrong,
    }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'PLAN_HASH_MISMATCH'
  );

  assert.throws(
    () => executionApprovalSubject(plan, {
      runId: 'run-spec-mismatch',
      spec: { goal: 'approved behavior' },
      specHash: wrong,
    }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'SPEC_HASH_MISMATCH'
  );
});

test('approval receipt binds exact run spec and normalized plan hashes', () => {
  const subject = executionApprovalSubject(plan, {
    runId: 'run-subject',
    spec: { goal: 'ship auth' },
  });
  const receipt = createUserApprovalReceipt({
    ...subject,
    approvalId: 'approval-subject',
    approvedBy: 'user',
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const graph = sealExecutionPlan(plan, {
    runId: 'run-subject',
    spec: { goal: 'ship auth' },
    approvalReceipt: receipt,
  });

  assert.equal(graph.runId, receipt.runId);
  assert.equal(graph.specHash, receipt.specHash);
  assert.equal(graph.planHash, receipt.planHash);
  assert.equal(graph.approvalScopeHash, receipt.receiptHash);
});

test('descriptor tampering is detected before execution', () => {
  const graph = sealApprovedExecutionPlan(plan, {
    runId: 'run-1',
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

test('non-material lease extension creates a child revision and preserves approval receipt', () => {
  const graph = sealApprovedExecutionPlan(plan, {
    runId: 'run-1',
    revisionId: 'G1',
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
  assert.deepEqual(result.graph.approvalReceipt, graph.approvalReceipt);
  assert.notEqual(result.graph.descriptorHash, graph.descriptorHash);
  assert.equal(result.requiresReschedule, true);
  assert.deepEqual(result.conflicts, ['api']);
  assert.equal(validateSealedExecutionGraph(result.graph), true);
});

test('material semantic lease request requires new user approval and does not mutate graph', () => {
  const graph = sealApprovedExecutionPlan(plan, {
    runId: 'run-1',
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
