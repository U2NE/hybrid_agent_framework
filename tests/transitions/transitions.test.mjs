import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  proposeMaterialRevision,
  requestLeaseExtension,
  sealApprovedMaterialRevision,
} from '../../core/execution-graph/index.mjs';
import { createUserApprovalReceipt } from '../../core/approval/index.mjs';
import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';
import { ResourceLeaseStore } from '../../core/leases/index.mjs';
import {
  ExecutionRunStore,
  TransitionError,
  reconcileActivityEvidence,
} from '../../core/transitions/index.mjs';

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-transition-test-'));
}

function graphFor(effectPolicy = 'reconcile_required') {
  return sealApprovedExecutionPlan({
    tasks: [
      {
        id: 'task-a',
        files_modified: effectPolicy === 'side_effect_free' ? [] : ['src/a.js'],
        depends_on: [],
        resources: [],
        effect_policy: effectPolicy,
        owner: 'implementer',
      },
    ],
  }, {
    runId: 'run-1',
    revisionId: 'G1',
  });
}

test('run store persists sealed graph and exact initialization replays', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);

  const first = await store.initializeGraph(graph);
  const second = await store.initializeGraph(graph);

  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'replayed');
  assert.equal((await store.loadGraph()).descriptorHash, graph.descriptorHash);
  assert.equal(
    (await store.loadGraphRevision(graph.descriptorHash)).descriptorHash,
    graph.descriptorHash
  );
});

test('graph advancement requires the current descriptor as parent and retains revisions', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  await store.initializeGraph(graph);

  const amended = requestLeaseExtension(graph, {
    taskId: 'task-a',
    resources: ['contract:a'],
  }).graph;
  const advanced = await store.advanceGraph(amended);

  assert.equal(advanced.status, 'advanced');
  assert.equal((await store.loadGraph()).descriptorHash, amended.descriptorHash);
  assert.equal(
    (await store.loadGraphRevision(graph.descriptorHash)).descriptorHash,
    graph.descriptorHash
  );

  const sibling = requestLeaseExtension(graph, {
    taskId: 'task-a',
    resources: ['contract:b'],
  }).graph;
  await assert.rejects(
    () => store.advanceGraph(sibling),
    (error) => error instanceof TransitionError && error.code === 'GRAPH_FENCED'
  );
});

test('graph advancement is fenced by active dispatch leases and succeeds after release', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);

  const amendedResult = requestLeaseExtension(graph, {
    taskId: 'task-a',
    resources: ['contract:expanded'],
  });
  assert.equal(amendedResult.applied, true);

  const acquired = await leaseStore.acquire(graph, 'task-a', 'attempt-active');
  await assert.rejects(
    () => runStore.advanceGraph(amendedResult.graph),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'GRAPH_ADVANCE_ACTIVE_LEASES' &&
      error.details.activeLeases.some((lease) =>
        lease.taskId === 'task-a' &&
        lease.attemptId === 'attempt-active' &&
        lease.descriptorHash === graph.descriptorHash
      )
  );

  assert.equal((await runStore.loadGraph()).descriptorHash, graph.descriptorHash);
  const replay = await runStore.advanceGraph(graph);
  assert.equal(replay.status, 'replayed');

  await leaseStore.release(
    acquired.authorization.leaseId,
    acquired.authorization.leaseToken,
    { outcome: 'aborted-before-revision' }
  );
  const advanced = await runStore.advanceGraph(amendedResult.graph);
  assert.equal(advanced.status, 'advanced');
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    amendedResult.graph.descriptorHash
  );
});

test('runtime lease extension auto-publishes a non-material child when the run is drained', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  await runStore.initializeGraph(graph);

  const extended = await runStore.extendTaskResources({
    taskId: 'task-a',
    resources: [{ key: 'contract:expanded', mode: 'exclusive' }],
  });

  assert.equal(extended.status, 'extended');
  assert.equal(extended.applied, true);
  assert.equal(extended.graph.revisionId, 'G2');
  assert.equal(extended.graph.parentDescriptorHash, graph.descriptorHash);
  assert.equal(extended.graph.approvalScopeHash, graph.approvalScopeHash);
  assert.deepEqual(
    extended.graph.nodes.find((node) => node.id === 'task-a').resources,
    [{ key: 'contract:expanded', mode: 'exclusive' }]
  );
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    extended.graph.descriptorHash
  );

  const noOp = await runStore.extendTaskResources({
    taskId: 'task-a',
    resources: [{ key: 'contract:expanded', mode: 'exclusive' }],
  });
  assert.equal(noOp.status, 'no-op');
  assert.equal(noOp.applied, false);
  assert.equal(noOp.graph.descriptorHash, extended.graph.descriptorHash);
});

test('runtime lease extension drains active old-revision leases before publishing and reacquiring', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);

  const active = await leaseStore.acquire(graph, 'task-a', 'attempt-before-extension');
  const blocked = await runStore.extendTaskResources({
    taskId: 'task-a',
    resources: ['contract:expanded'],
  });

  assert.equal(blocked.status, 'drain-required');
  assert.equal(blocked.applied, false);
  assert.equal(blocked.currentDescriptorHash, graph.descriptorHash);
  assert.equal(blocked.proposedRevisionId, 'G2');
  assert.equal(blocked.activeLeases.length, 1);
  assert.equal(blocked.activeLeases[0].leaseId, active.authorization.leaseId);
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    graph.descriptorHash
  );

  await leaseStore.release(
    active.authorization.leaseId,
    active.authorization.leaseToken,
    { outcome: 'aborted-and-reconciled-before-resource-extension' }
  );

  const extended = await runStore.extendTaskResources({
    taskId: 'task-a',
    resources: ['contract:expanded'],
  });
  assert.equal(extended.status, 'extended');
  assert.equal(extended.graph.revisionId, 'G2');

  const reacquired = await leaseStore.acquire(
    extended.graph,
    'task-a',
    'attempt-after-extension'
  );
  assert.deepEqual(
    reacquired.authorization.taskContract.resources,
    [{ key: 'contract:expanded', mode: 'exclusive' }]
  );

  await assert.rejects(
    () => leaseStore.assertAuthorization(
      extended.graph,
      active.authorization
    ),
    (error) => error.code === 'DISPATCH_AUTH_GRAPH_MISMATCH'
  );
});

test('runtime lease extension routes material semantics to user re-approval without graph mutation', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  await runStore.initializeGraph(graph);

  const result = await runStore.extendTaskResources({
    taskId: 'task-a',
    resources: ['schema:database'],
    schemaMeaningChanged: true,
  });

  assert.equal(result.status, 'user-approval-required');
  assert.equal(result.applied, false);
  assert.equal(result.materialRevisionRequired, true);
  assert.deepEqual(result.reasons, ['SCHEMA_MEANING_CHANGE']);
  assert.equal(result.graph.descriptorHash, graph.descriptorHash);
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    graph.descriptorHash
  );
});

test('runtime lease extension cannot mutate file/read/write contracts or choose revision ids', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  await runStore.initializeGraph(graph);

  for (const input of [
    { taskId: 'task-a', resources: ['contract:x'], files_modified: ['src/b.js'] },
    { taskId: 'task-a', resources: ['contract:x'], writes: ['src/b.js'] },
    { taskId: 'task-a', resources: ['contract:x'], reads: ['src/b.js'] },
    { taskId: 'task-a', resources: ['contract:x'], revisionId: 'custom-revision' },
    { taskId: 'task-a', resources: ['contract:x'], plan: { tasks: [] } },
    { taskId: 'task-a', resources: ['contract:x'], spec: { goal: 'changed' } },
  ]) {
    await assert.rejects(
      () => runStore.extendTaskResources(input),
      (error) =>
        error instanceof TransitionError &&
        error.code === 'LEASE_EXTENSION_CONTRACT_CHANGE_FORBIDDEN'
    );
  }

  assert.equal((await runStore.loadGraph()).descriptorHash, graph.descriptorHash);
});

test('concurrent identical runtime lease extensions converge on one child descriptor', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const firstStore = new ExecutionRunStore(root, graph.runId);
  const secondStore = new ExecutionRunStore(root, graph.runId);
  await firstStore.initializeGraph(graph);

  const [left, right] = await Promise.all([
    firstStore.extendTaskResources({
      taskId: 'task-a',
      resources: ['contract:race'],
    }),
    secondStore.extendTaskResources({
      taskId: 'task-a',
      resources: ['contract:race'],
    }),
  ]);

  assert.deepEqual(
    [left.status, right.status].sort(),
    ['extended', 'replayed']
  );
  assert.equal(left.graph.descriptorHash, right.graph.descriptorHash);
  assert.equal(
    (await firstStore.loadGraph()).descriptorHash,
    left.graph.descriptorHash
  );
});

test('concurrent different runtime lease extensions fence stale parents and converge by retry', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const firstStore = new ExecutionRunStore(root, graph.runId);
  const secondStore = new ExecutionRunStore(root, graph.runId);
  await firstStore.initializeGraph(graph);

  const [left, right] = await Promise.all([
    firstStore.extendTaskResources({
      taskId: 'task-a',
      resources: ['contract:left'],
    }),
    secondStore.extendTaskResources({
      taskId: 'task-a',
      resources: ['contract:right'],
    }),
  ]);

  const winner = [left, right].find((item) => item.status === 'extended');
  const stale = [left, right].find((item) => item.status === 'retry-required');
  assert.ok(winner);
  assert.ok(stale);
  assert.equal(stale.graph.descriptorHash, winner.graph.descriptorHash);
  assert.equal(stale.attemptedParentDescriptorHash, graph.descriptorHash);

  const missingKey = winner.graph.nodes
    .find((node) => node.id === 'task-a')
    .resources.some((resource) => resource.key === 'contract:left')
      ? 'contract:right'
      : 'contract:left';

  const retried = await firstStore.extendTaskResources({
    taskId: 'task-a',
    resources: [missingKey],
  });
  assert.equal(retried.status, 'extended');
  assert.equal(retried.graph.revisionId, 'G3');
  assert.deepEqual(
    retried.graph.nodes
      .find((node) => node.id === 'task-a')
      .resources.map((resource) => resource.key)
      .sort(),
    ['contract:left', 'contract:right']
  );
});

test('approved material child cannot publish across an active parent lease', async () => {
  const root = await tempProject();
  const parent = graphFor();
  const runStore = new ExecutionRunStore(root, parent.runId);
  const leaseStore = new ResourceLeaseStore(root, parent.runId);
  await runStore.initializeGraph(parent);

  const revisedPlan = {
    phase: 'material-v2',
    tasks: [
      {
        id: 'task-a',
        files_modified: ['src/a-v2.js'],
        depends_on: [],
        resources: [],
        effect_policy: 'reconcile_required',
        owner: 'implementer',
      },
    ],
  };
  const pending = proposeMaterialRevision(parent, revisedPlan, {
    productBehaviorChanged: true,
  });
  const receipt = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: 'material-transition-approval',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:10:00+09:00',
  });
  const child = sealApprovedMaterialRevision(
    parent,
    revisedPlan,
    pending.proposal,
    { approvalReceipt: receipt }
  );

  const lease = await leaseStore.acquire(parent, 'task-a', 'attempt-material-parent');
  await assert.rejects(
    () => runStore.advanceGraph(child),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'GRAPH_ADVANCE_ACTIVE_LEASES'
  );
  assert.equal((await runStore.loadGraph()).descriptorHash, parent.descriptorHash);

  await leaseStore.release(
    lease.authorization.leaseId,
    lease.authorization.leaseToken,
    { outcome: 'reconciled-before-material-revision' }
  );
  const advanced = await runStore.advanceGraph(child);
  assert.equal(advanced.status, 'advanced');
  assert.equal((await runStore.loadGraph()).descriptorHash, child.descriptorHash);
  assert.equal(
    (await runStore.loadGraphRevision(parent.descriptorHash)).descriptorHash,
    parent.descriptorHash
  );
});

test('same transition request replays while different request is fenced', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  await store.initializeGraph(graph);

  const input = {
    transitionId: 'dispatch-task-a',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-1',
    kind: 'task_dispatched',
    effectPolicy: 'reconcile_required',
    request: { descriptorHash: graph.descriptorHash, model: 'gpt-6-luna' },
  };

  const first = await store.commitTransition(input);
  const replay = await store.commitTransition(input);
  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'replayed');
  assert.equal(first.record.requestFingerprint, replay.record.requestFingerprint);
  assert.equal((await store.loadTransitions()).length, 1);

  await assert.rejects(
    () => store.commitTransition({
      ...input,
      request: { descriptorHash: graph.descriptorHash, model: 'gpt-6-sol' },
    }),
    (error) => error instanceof TransitionError && error.code === 'TRANSITION_FENCED'
  );
});

test('corrupt transition ledger fails closed on restart', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  await store.initializeGraph(graph);
  await fs.mkdir(store.runDir, { recursive: true });
  await fs.writeFile(store.transitionsPath, '{"not":"complete"\n', 'utf8');

  const restarted = new ExecutionRunStore(root, graph.runId);
  await assert.rejects(
    () => restarted.loadTransitions(),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TRANSITION_LEDGER_CORRUPT'
  );
});

test('observed worktree patch recovers completion without redispatch', () => {
  const graph = graphFor();
  const patchHash = 'a'.repeat(64);
  const owner = {
    schema: 'hybrid-worktree-owner/v1',
    runId: graph.runId,
    revisionId: graph.revisionId,
    graphHash: graph.descriptorHash,
    taskId: 'task-a',
    agentRunId: 'agent-a',
    baseCommit: 'base-commit',
  };
  const result = {
    taskId: 'task-a',
    agentRunId: 'agent-a',
    baseCommit: 'base-commit',
    changedFiles: ['src/a.js'],
    patchHash,
    attribution: 'observed',
  };

  const recovery = reconcileActivityEvidence({
    graph,
    taskId: 'task-a',
    worktreeOwner: owner,
    worktreeResult: result,
  });

  assert.equal(recovery.status, 'recover-completed-activity');
  assert.equal(recovery.shouldRedispatch, false);
  assert.equal(recovery.suggestedTransition.kind, 'recovered_task_completed');
  assert.equal(recovery.suggestedTransition.result.patchHash, patchHash);
  assert.ok(recovery.suggestedTransition.evidenceRefs.includes('patch:' + patchHash));
});

test('unsafe unknown effects stop for reconciliation while idempotent work can retry', () => {
  const reconcile = reconcileActivityEvidence({
    graph: graphFor('reconcile_required'),
    taskId: 'task-a',
  });
  assert.equal(reconcile.status, 'reconcile-required');
  assert.equal(reconcile.shouldRedispatch, false);

  const atMostOnce = reconcileActivityEvidence({
    graph: graphFor('at_most_once'),
    taskId: 'task-a',
  });
  assert.equal(atMostOnce.status, 'reconcile-required');
  assert.equal(atMostOnce.shouldRedispatch, false);

  const idempotent = reconcileActivityEvidence({
    graph: graphFor('idempotent'),
    taskId: 'task-a',
  });
  assert.equal(idempotent.status, 'retry-safe');
  assert.equal(idempotent.shouldRedispatch, true);
});

test('an existing completion transition wins over incomplete runtime evidence', () => {
  const graph = graphFor();
  const completed = {
    schema: 'hybrid-transition/v1',
    runId: graph.runId,
    transitionId: 'complete-a',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-1',
    kind: 'task_completed',
    effectPolicy: 'reconcile_required',
    requestFingerprint: 'b'.repeat(64),
    evidenceRefs: ['patch:' + 'c'.repeat(64)],
    result: null,
    timestamp: new Date().toISOString(),
  };

  const recovery = reconcileActivityEvidence({
    graph,
    taskId: 'task-a',
    transitions: [completed],
  });
  assert.equal(recovery.status, 'already-completed');
  assert.equal(recovery.shouldRedispatch, false);
  assert.equal(recovery.evidence.transitionId, 'complete-a');
});
