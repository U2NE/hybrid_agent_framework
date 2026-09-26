import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserApprovalReceipt } from '../../core/approval/index.mjs';
import {
  ExecutionGraphError,
  executionApprovalSubject,
  materialRevisionReasons,
  proposeMaterialRevision,
  requestLeaseExtension,
  sealApprovedMaterialRevision,
  sealExecutionPlan,
  validateMaterialRevisionProposal,
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

  assert.equal(first.schema, 'hybrid-exec-graph/v4');
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

test('sealed graph binds deterministic scheduler isolation into descriptor authority', () => {
  const parallelPlan = {
    tasks: [
      {
        id: 'alpha',
        owner: 'implementer',
        files_modified: ['src/alpha.js'],
        depends_on: [],
      },
      {
        id: 'beta',
        owner: 'implementer',
        files_modified: ['src/beta.js'],
        depends_on: [],
      },
    ],
  };
  const isolationPlan = {
    isolation: [{
      taskIds: ['alpha', 'beta'],
      mode: 'worktree',
    }],
  };
  const graph = sealApprovedExecutionPlan(parallelPlan, {
    runId: 'run-isolation',
    worktreeAvailable: true,
    isolationPlan,
  });

  assert.equal(
    graph.nodes.find((node) => node.id === 'alpha').isolationMode,
    'worktree'
  );
  assert.equal(
    graph.nodes.find((node) => node.id === 'beta').isolationMode,
    'worktree'
  );
  assert.equal(
    graph.nodes.find((node) => node.id === 'verify-final').isolationMode,
    'none'
  );

  const tampered = structuredClone(graph);
  tampered.nodes.find((node) => node.id === 'alpha').isolationMode =
    'current-workspace';
  assert.throws(
    () => validateSealedExecutionGraph(tampered),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.details.errors.includes('descriptor hash mismatch')
  );

  assert.throws(
    () => sealApprovedExecutionPlan(parallelPlan, {
      runId: 'run-isolation-forged',
      worktreeAvailable: true,
      isolationPlan: {
        isolation: [{
          taskIds: ['alpha', 'beta'],
          mode: 'current-workspace',
        }],
      },
    }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'EXECUTION_ISOLATION_MISMATCH'
  );
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

test('material revision proposal binds a changed subject without mutating the parent graph', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material',
    revisionId: 'G1',
  });
  const revised = structuredClone(plan);
  revised.tasks[1].goal = 'Update client and public response contract';
  revised.tasks[1].files_modified = ['src/client-v2.js'];

  const pending = proposeMaterialRevision(parent, revised, {
    publicApiChanged: true,
    securityPostureChanged: true,
  });

  assert.equal(pending.applied, false);
  assert.equal(pending.status, 'user-approval-required');
  assert.equal(pending.graph, parent);
  assert.equal(pending.proposal.schema, 'hybrid-material-revision-proposal/v1');
  assert.equal(pending.proposal.parentDescriptorHash, parent.descriptorHash);
  assert.equal(pending.proposal.parentRevisionId, 'G1');
  assert.equal(pending.proposal.revisionId, 'G2');
  assert.notEqual(pending.approvalSubject.planHash, parent.planHash);
  assert.equal(pending.approvalSubject.specHash, parent.specHash);
  assert.deepEqual(
    pending.reasons,
    ['PUBLIC_API_CHANGE', 'SECURITY_POSTURE_CHANGE']
  );
  assert.equal(
    validateMaterialRevisionProposal(parent, revised, pending.proposal),
    true
  );
});

test('material revision cannot request approval for an unchanged execution subject', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-unchanged',
  });

  assert.throws(
    () => proposeMaterialRevision(parent, plan, {
      material: true,
      publicApiChanged: true,
    }),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'MATERIAL_REVISION_SUBJECT_UNCHANGED'
  );

  const revised = structuredClone(plan);
  revised.phase = 'auth-v2';
  assert.throws(
    () => proposeMaterialRevision(parent, revised, {}),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'MATERIAL_REVISION_REASON_REQUIRED'
  );
});

test('approved material revision creates a new receipt-bound child graph', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-approved',
    revisionId: 'G1',
  });
  const revised = structuredClone(plan);
  revised.phase = 'auth-v2';
  revised.tasks[0].goal = 'Update API with a new public conflict contract';

  const pending = proposeMaterialRevision(parent, revised, {
    productBehaviorChanged: true,
    publicApiChanged: true,
  });
  const receipt = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: 'material-approval-2',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:00:00+09:00',
  });
  const child = sealApprovedMaterialRevision(
    parent,
    revised,
    pending.proposal,
    { approvalReceipt: receipt }
  );

  assert.equal(child.revisionId, 'G2');
  assert.equal(child.parentDescriptorHash, parent.descriptorHash);
  assert.notEqual(child.descriptorHash, parent.descriptorHash);
  assert.equal(child.approvalScopeHash, receipt.receiptHash);
  assert.notEqual(child.approvalScopeHash, parent.approvalScopeHash);
  assert.deepEqual(child.approvalReceipt, receipt);
  assert.equal(child.planHash, pending.approvalSubject.planHash);
  assert.equal(child.specHash, pending.approvalSubject.specHash);
  assert.equal(validateSealedExecutionGraph(child), true);

  const amendment = child.amendments.at(-1);
  assert.equal(amendment.kind, 'material-revision');
  assert.equal(amendment.proposalHash, pending.proposal.proposalHash);
  assert.equal(amendment.parentDescriptorHash, parent.descriptorHash);
  assert.equal(amendment.priorApprovalScopeHash, parent.approvalScopeHash);
  assert.equal(amendment.approvalScopeHash, receipt.receiptHash);
  assert.deepEqual(
    amendment.reasons,
    ['PRODUCT_BEHAVIOR_CHANGE', 'PUBLIC_API_CHANGE']
  );

  const operationalChild = requestLeaseExtension(child, {
    taskId: 'client',
    resources: [{ key: 'contract:client-v2', mode: 'exclusive' }],
  }).graph;
  assert.equal(operationalChild.approvalScopeHash, child.approvalScopeHash);
  assert.equal(validateSealedExecutionGraph(operationalChild), true);
});

test('material revision requires a fresh approval identity even when receipt matches revised subject', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-fresh',
  });
  const revised = structuredClone(plan);
  revised.tasks[0].goal = 'Materially change API behavior';

  const pending = proposeMaterialRevision(parent, revised, {
    productBehaviorChanged: true,
  });
  const reusedIdentity = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: parent.approvalReceipt.approvalId,
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:01:00+09:00',
  });

  assert.throws(
    () => sealApprovedMaterialRevision(
      parent,
      revised,
      pending.proposal,
      { approvalReceipt: reusedIdentity }
    ),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'MATERIAL_REVISION_FRESH_APPROVAL_REQUIRED'
  );
});

test('material revision proposal fences plan and proposal tampering before sealing', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-tamper',
  });
  const revised = structuredClone(plan);
  revised.tasks[1].goal = 'Materially change client behavior';

  const pending = proposeMaterialRevision(parent, revised, {
    productBehaviorChanged: true,
  });

  const changedAfterProposal = structuredClone(revised);
  changedAfterProposal.tasks[1].files_modified = ['src/unapproved.js'];
  assert.throws(
    () => validateMaterialRevisionProposal(
      parent,
      changedAfterProposal,
      pending.proposal
    ),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'PLAN_HASH_MISMATCH'
  );

  const tamperedProposal = structuredClone(pending.proposal);
  tamperedProposal.reasons.push('PUBLIC_API_CHANGE');
  assert.throws(
    () => validateMaterialRevisionProposal(parent, revised, tamperedProposal),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'INVALID_MATERIAL_REVISION_PROPOSAL' &&
      error.details.errors.includes('proposal hash mismatch')
  );
});

test('material proposal with malformed approval subject fails as a proposal error', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-bad-subject',
  });
  const revised = structuredClone(plan);
  revised.phase = 'v2';
  const pending = proposeMaterialRevision(parent, revised, {
    featureScopeChanged: true,
  });

  const malformed = structuredClone(pending.proposal);
  delete malformed.approvalSubject;
  assert.throws(
    () => validateMaterialRevisionProposal(parent, revised, malformed),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'INVALID_MATERIAL_REVISION_PROPOSAL' &&
      error.details.errors.includes('invalid approval subject')
  );
});

test('successive material revisions preserve approval ancestry and latest semantic authority', () => {
  const first = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-chain',
    revisionId: 'G1',
  });

  const plan2 = structuredClone(plan);
  plan2.phase = 'v2';
  const proposal2 = proposeMaterialRevision(first, plan2, {
    featureScopeChanged: true,
  });
  const receipt2 = createUserApprovalReceipt({
    ...proposal2.approvalSubject,
    approvalId: 'chain-approval-2',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:03:00+09:00',
  });
  const second = sealApprovedMaterialRevision(
    first,
    plan2,
    proposal2.proposal,
    { approvalReceipt: receipt2 }
  );

  const plan3 = structuredClone(plan2);
  plan3.phase = 'v3';
  plan3.tasks[0].goal = 'Change behavior again';
  const proposal3 = proposeMaterialRevision(second, plan3, {
    productBehaviorChanged: true,
  });
  const receipt3 = createUserApprovalReceipt({
    ...proposal3.approvalSubject,
    approvalId: 'chain-approval-3',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:04:00+09:00',
  });
  const third = sealApprovedMaterialRevision(
    second,
    plan3,
    proposal3.proposal,
    { approvalReceipt: receipt3 }
  );

  assert.equal(third.revisionId, 'G3');
  assert.equal(third.parentDescriptorHash, second.descriptorHash);
  assert.equal(third.approvalScopeHash, receipt3.receiptHash);
  assert.equal(third.amendments.filter((item) => item.kind === 'material-revision').length, 2);
  assert.equal(third.amendments.at(-1).priorApprovalScopeHash, receipt2.receiptHash);
  assert.equal(third.amendments.at(-1).approvalScopeHash, receipt3.receiptHash);
  assert.equal(validateSealedExecutionGraph(third), true);
});

test('SPEC-bound material revision requires the exact approved SPEC content again', () => {
  const parent = sealApprovedExecutionPlan(plan, {
    runId: 'run-material-spec',
  });
  const revisedSpec = {
    goal: 'Require conflict responses to hide account existence',
    security: 'enumeration-resistant',
  };

  const pending = proposeMaterialRevision(parent, plan, {
    spec: revisedSpec,
    securityPostureChanged: true,
  });
  assert.equal(pending.proposal.specBinding, 'content');
  assert.notEqual(pending.approvalSubject.specHash, parent.specHash);

  assert.throws(
    () => validateMaterialRevisionProposal(parent, plan, pending.proposal),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'MATERIAL_REVISION_SPEC_REQUIRED'
  );

  assert.throws(
    () => validateMaterialRevisionProposal(
      parent,
      plan,
      pending.proposal,
      { spec: { ...revisedSpec, security: 'weaker' } }
    ),
    (error) =>
      error instanceof ExecutionGraphError &&
      error.code === 'SPEC_HASH_MISMATCH'
  );

  const receipt = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: 'material-spec-approval',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:02:00+09:00',
  });
  const child = sealApprovedMaterialRevision(
    parent,
    plan,
    pending.proposal,
    { spec: revisedSpec, approvalReceipt: receipt }
  );
  assert.equal(child.specHash, pending.approvalSubject.specHash);
  assert.equal(child.planHash, parent.planHash);
  assert.equal(validateSealedExecutionGraph(child), true);
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
