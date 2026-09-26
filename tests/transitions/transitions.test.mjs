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
  buildTransitionRecord,
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

test('concurrent identical initial graph binding across stores converges to one durable graph', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const left = new ExecutionRunStore(root, graph.runId);
  const right = new ExecutionRunStore(root, graph.runId);

  const [first, second] = await Promise.all([
    left.initializeGraph(graph),
    right.initializeGraph(graph),
  ]);

  assert.deepEqual(
    [first.status, second.status].sort(),
    ['committed', 'replayed']
  );
  assert.equal(
    (await left.loadGraph()).descriptorHash,
    graph.descriptorHash
  );
  assert.equal(
    (await left.loadGraphRevision(graph.descriptorHash)).descriptorHash,
    graph.descriptorHash
  );
});

test('concurrent conflicting initial graph binding has one winner and one fenced loser', async () => {
  const root = await tempProject();
  const leftGraph = graphFor('reconcile_required');
  const rightGraph = graphFor('side_effect_free');
  assert.notEqual(leftGraph.descriptorHash, rightGraph.descriptorHash);

  const left = new ExecutionRunStore(root, leftGraph.runId);
  const right = new ExecutionRunStore(root, rightGraph.runId);
  const settled = await Promise.allSettled([
    left.initializeGraph(leftGraph),
    right.initializeGraph(rightGraph),
  ]);

  assert.equal(
    settled.filter((item) => item.status === 'fulfilled').length,
    1
  );
  const rejected = settled.find((item) => item.status === 'rejected');
  assert.ok(rejected);
  assert.equal(rejected.reason.code, 'GRAPH_FENCED');

  const winner = settled.find((item) => item.status === 'fulfilled').value.graph;
  const persisted = await left.loadGraph();
  assert.equal(persisted.descriptorHash, winner.descriptorHash);

  const losingGraph =
    winner.descriptorHash === leftGraph.descriptorHash
      ? rightGraph
      : leftGraph;
  await assert.rejects(
    () => left.loadGraphRevision(losingGraph.descriptorHash),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'GRAPH_REVISION_MISSING'
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

  await runStore.abortTaskLease(acquired.authorization, {
    reasonCode: 'GRAPH_REVISION_REQUIRED',
    evidenceRefs: ['reconcile:test-aborted-before-revision'],
  });
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

  await runStore.abortTaskLease(active.authorization, {
    reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
    evidenceRefs: ['reconcile:test-resource-extension'],
  });

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

  await runStore.abortTaskLease(lease.authorization, {
    reasonCode: 'MATERIAL_REVISION_REQUIRED',
    evidenceRefs: ['reconcile:test-material-revision'],
  });
  const advanced = await runStore.advanceGraph(child);
  assert.equal(advanced.status, 'advanced');
  assert.equal((await runStore.loadGraph()).descriptorHash, child.descriptorHash);
  assert.equal(
    (await runStore.loadGraphRevision(parent.descriptorHash)).descriptorHash,
    parent.descriptorHash
  );
});

test('lease release requires a durable terminal transition with evidence and replays idempotently', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'task-a', 'attempt-release');

  await assert.rejects(
    () => runStore.releaseTaskLease(
      acquired.authorization,
      'complete-task-a-attempt-release'
    ),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'LEASE_RELEASE_TRANSITION_NOT_FOUND'
  );
  assert.equal((await leaseStore.list({ activeOnly: true })).leases.length, 1);

  const nonTerminal = await runStore.commitTransition({
    transitionId: 'dispatch-task-a-attempt-release',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-release',
    kind: 'task_dispatched',
    effectPolicy: 'reconcile_required',
    request: { descriptorHash: graph.descriptorHash },
    evidenceRefs: ['dispatch:test'],
  });
  await assert.rejects(
    () => runStore.releaseTaskLease(
      acquired.authorization,
      nonTerminal.record.transitionId
    ),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'LEASE_RELEASE_TRANSITION_INVALID' &&
      error.details.errors.some((item) => /not terminal/.test(item))
  );

  await assert.rejects(
    () => runStore.commitTransition({
      transitionId: 'complete-task-a-no-evidence',
      graphRevision: graph.revisionId,
      nodeId: 'task-a',
      attemptId: 'attempt-release',
      kind: 'task_completed',
      effectPolicy: 'reconcile_required',
      request: { descriptorHash: graph.descriptorHash },
      evidenceRefs: [],
    }),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TERMINAL_TRANSITION_EVIDENCE_REQUIRED'
  );
  assert.equal(
    (await runStore.loadTransitions()).some(
      (record) => record.transitionId === 'complete-task-a-no-evidence'
    ),
    false
  );

  const completed = await runStore.commitTransition({
    transitionId: 'complete-task-a-attempt-release',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-release',
    kind: 'task_completed',
    effectPolicy: 'reconcile_required',
    request: { descriptorHash: graph.descriptorHash },
    evidenceRefs: ['test:acceptance-pass', 'file:src/a.js'],
    result: { outcome: 'pass' },
  });

  const first = await runStore.releaseTaskLease(
    acquired.authorization,
    completed.record.transitionId
  );
  const replay = await new ExecutionRunStore(root, graph.runId).releaseTaskLease(
    acquired.authorization,
    completed.record.transitionId
  );

  assert.equal(first.status, 'released');
  assert.equal(replay.status, 'replayed');
  assert.equal(first.proof.schema, 'hybrid-lease-release-proof/v1');
  assert.equal(first.proof.transitionKind, 'task_completed');
  assert.equal(first.proof.outcome, 'completed');
  assert.equal(first.proof.leaseId, acquired.authorization.leaseId);
  assert.equal(first.proof.descriptorHash, graph.descriptorHash);
  assert.equal(first.proof.transitionFingerprint.length, 64);
  assert.equal((await leaseStore.list({ activeOnly: true })).leases.length, 0);
});

test('lease release transition is fenced to the exact task attempt and effect policy', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'task-a', 'attempt-bound');

  const wrongAttempt = await runStore.commitTransition({
    transitionId: 'complete-wrong-attempt',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'other-attempt',
    kind: 'task_completed',
    effectPolicy: 'reconcile_required',
    request: { descriptorHash: graph.descriptorHash },
    evidenceRefs: ['test:wrong-attempt'],
  });
  await assert.rejects(
    () => runStore.releaseTaskLease(
      acquired.authorization,
      wrongAttempt.record.transitionId
    ),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'LEASE_RELEASE_TRANSITION_INVALID' &&
      error.details.errors.includes('attempt mismatch')
  );

  await assert.rejects(
    () => runStore.commitTransition({
      transitionId: 'complete-wrong-policy',
      graphRevision: graph.revisionId,
      nodeId: 'task-a',
      attemptId: 'attempt-bound',
      kind: 'task_completed',
      effectPolicy: 'at_most_once',
      request: { descriptorHash: graph.descriptorHash },
      evidenceRefs: ['test:wrong-policy'],
    }),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TERMINAL_TRANSITION_GRAPH_MISMATCH' &&
      error.details.errors.includes('effectPolicy mismatch')
  );

  assert.equal(
    (await runStore.loadTransitions()).some(
      (record) => record.transitionId === 'complete-wrong-policy'
    ),
    false
  );
  assert.equal((await leaseStore.list({ activeOnly: true })).leases.length, 1);
});

test('reconciled abort commits durable evidence before releasing and replays exactly', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'task-a', 'attempt-abort');

  await assert.rejects(
    () => runStore.abortTaskLease(acquired.authorization, {
      reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
      evidenceRefs: [],
    }),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'RECONCILED_ABORT_EVIDENCE_REQUIRED'
  );

  const first = await runStore.abortTaskLease(acquired.authorization, {
    reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
    evidenceRefs: ['workspace-guard:reconciled'],
    result: { changedFiles: [] },
  });
  const replay = await new ExecutionRunStore(root, graph.runId).abortTaskLease(
    acquired.authorization,
    {
      reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
      evidenceRefs: ['workspace-guard:reconciled'],
      result: { changedFiles: [] },
    }
  );

  assert.equal(first.status, 'aborted-released');
  assert.equal(replay.status, 'replayed');
  assert.equal(first.transition.kind, 'task_aborted_reconciled');
  assert.equal(first.transition.result.outcome, 'aborted-reconciled');
  assert.deepEqual(first.transition.evidenceRefs, ['workspace-guard:reconciled']);
  assert.equal(first.proof.outcome, 'aborted-reconciled');
  assert.equal((await leaseStore.list({ activeOnly: true })).leases.length, 0);
});

test('completed lease cannot later append a contradictory reconciled abort transition', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const runStore = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'task-a', 'attempt-terminal');

  const completed = await runStore.commitTransition({
    transitionId: 'complete-task-a-attempt-terminal',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-terminal',
    kind: 'task_completed',
    effectPolicy: 'reconcile_required',
    request: {
      descriptorHash: graph.descriptorHash,
      leaseId: acquired.authorization.leaseId,
    },
    evidenceRefs: ['test:terminal-completion'],
    result: { outcome: 'pass' },
  });
  await runStore.releaseTaskLease(
    acquired.authorization,
    completed.record.transitionId
  );

  const before = await runStore.loadTransitions();
  await assert.rejects(
    () => runStore.abortTaskLease(acquired.authorization, {
      reasonCode: 'LATE_ABORT_SHOULD_NOT_APPEND',
      evidenceRefs: ['reconcile:late-abort'],
    }),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'LEASE_TERMINAL_OUTCOME_FENCED' &&
      error.details.priorTransitionKind === 'task_completed'
  );
  const after = await runStore.loadTransitions();

  assert.equal(after.length, before.length);
  assert.equal(
    after.some((record) => record.kind === 'task_aborted_reconciled'),
    false
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

test('concurrent identical transition commits across stores converge to one durable record', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const left = new ExecutionRunStore(root, graph.runId);
  const right = new ExecutionRunStore(root, graph.runId);
  await left.initializeGraph(graph);

  const input = {
    transitionId: 'dispatch-concurrent-same',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-concurrent-same',
    kind: 'task_dispatched',
    effectPolicy: 'reconcile_required',
    request: {
      descriptorHash: graph.descriptorHash,
      marker: 'same',
    },
    evidenceRefs: ['dispatch:concurrent-same'],
  };

  const [first, second] = await Promise.all([
    left.commitTransition(input),
    right.commitTransition(input),
  ]);

  assert.deepEqual(
    [first.status, second.status].sort(),
    ['committed', 'replayed']
  );
  const records = await left.loadTransitions();
  assert.equal(
    records.filter(
      (record) => record.transitionId === input.transitionId
    ).length,
    1
  );
});

test('concurrent conflicting reuse of one transition id has one winner and one fenced loser', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const left = new ExecutionRunStore(root, graph.runId);
  const right = new ExecutionRunStore(root, graph.runId);
  await left.initializeGraph(graph);

  const base = {
    transitionId: 'dispatch-concurrent-conflict',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-concurrent-conflict',
    kind: 'task_dispatched',
    effectPolicy: 'reconcile_required',
    evidenceRefs: ['dispatch:concurrent-conflict'],
  };
  const settled = await Promise.allSettled([
    left.commitTransition({
      ...base,
      request: {
        descriptorHash: graph.descriptorHash,
        marker: 'left',
      },
    }),
    right.commitTransition({
      ...base,
      request: {
        descriptorHash: graph.descriptorHash,
        marker: 'right',
      },
    }),
  ]);

  assert.equal(
    settled.filter((item) => item.status === 'fulfilled').length,
    1
  );
  const rejected = settled.find((item) => item.status === 'rejected');
  assert.ok(rejected);
  assert.equal(rejected.reason.code, 'TRANSITION_FENCED');

  const records = await left.loadTransitions();
  assert.equal(
    records.filter(
      (record) => record.transitionId === base.transitionId
    ).length,
    1
  );
});

test('concurrent terminal outcomes for one task attempt have exactly one winner', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const left = new ExecutionRunStore(root, graph.runId);
  const right = new ExecutionRunStore(root, graph.runId);
  await left.initializeGraph(graph);

  const common = {
    descriptorHash: graph.descriptorHash,
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-terminal-race',
    effectPolicy: 'reconcile_required',
  };
  const settled = await Promise.allSettled([
    left.commitTransition({
      ...common,
      transitionId: 'terminal-race-completed',
      kind: 'task_completed',
      evidenceRefs: ['test:completed'],
      result: { outcome: 'pass' },
    }),
    right.commitTransition({
      ...common,
      transitionId: 'terminal-race-aborted',
      kind: 'task_aborted_reconciled',
      evidenceRefs: ['reconcile:aborted'],
      result: { outcome: 'aborted-reconciled' },
    }),
  ]);

  assert.equal(
    settled.filter((item) => item.status === 'fulfilled').length,
    1
  );
  const rejected = settled.find((item) => item.status === 'rejected');
  assert.ok(rejected);
  assert.equal(rejected.reason.code, 'TERMINAL_TRANSITION_FENCED');

  const records = await left.loadTransitions();
  const terminalRecords = records.filter(
    (record) =>
      record.graphRevision === graph.revisionId &&
      record.nodeId === 'task-a' &&
      record.attemptId === 'attempt-terminal-race' &&
      ['task_completed', 'task_aborted_reconciled'].includes(record.kind)
  );
  assert.equal(terminalRecords.length, 1);
});

test('persisted duplicate terminal outcomes for one task attempt fail closed on restart', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  await store.initializeGraph(graph);
  await fs.mkdir(store.runDir, { recursive: true });

  const common = {
    descriptorHash: graph.descriptorHash,
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-corrupt-terminal',
    effectPolicy: 'reconcile_required',
  };
  const completed = buildTransitionRecord(graph.runId, {
    ...common,
    transitionId: 'corrupt-terminal-completed',
    kind: 'task_completed',
    evidenceRefs: ['test:completed'],
    result: { outcome: 'pass' },
  });
  const aborted = buildTransitionRecord(graph.runId, {
    ...common,
    transitionId: 'corrupt-terminal-aborted',
    kind: 'task_aborted_reconciled',
    evidenceRefs: ['reconcile:aborted'],
    result: { outcome: 'aborted-reconciled' },
  });
  await fs.writeFile(
    store.transitionsPath,
    JSON.stringify(completed) + '\n' + JSON.stringify(aborted) + '\n',
    'utf8'
  );

  await assert.rejects(
    () => new ExecutionRunStore(root, graph.runId).loadTransitions(),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TRANSITION_LEDGER_CORRUPT' &&
      /multiple terminal outcomes/i.test(error.message)
  );
});

test('stale transition lock is reclaimed only after its owner is gone', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const base = new ExecutionRunStore(root, graph.runId);
  await base.initializeGraph(graph);
  await fs.mkdir(base.runDir, { recursive: true });

  const input = {
    transitionId: 'transition-after-stale-lock',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-after-stale-lock',
    kind: 'task_dispatched',
    effectPolicy: 'reconcile_required',
    evidenceRefs: ['dispatch:stale-lock'],
  };

  await fs.writeFile(
    base.transitionLockPath,
    JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date(0).toISOString(),
    }) + '\n',
    'utf8'
  );
  await fs.utimes(
    base.transitionLockPath,
    new Date(0),
    new Date(0)
  );

  const liveOwnerStore = new ExecutionRunStore(root, graph.runId, {
    transitionLockTimeoutMs: 75,
    transitionStaleLockMs: 1,
  });
  await assert.rejects(
    () => liveOwnerStore.commitTransition(input),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TRANSITION_LOCK_TIMEOUT'
  );

  let deadPid = 99999999;
  while (deadPid > 1000000) {
    try {
      process.kill(deadPid, 0);
      deadPid -= 1;
    } catch (error) {
      if (error?.code === 'ESRCH') break;
      deadPid -= 1;
    }
  }
  await fs.writeFile(
    base.transitionLockPath,
    JSON.stringify({
      pid: deadPid,
      acquiredAt: new Date(0).toISOString(),
    }) + '\n',
    'utf8'
  );
  await fs.utimes(
    base.transitionLockPath,
    new Date(0),
    new Date(0)
  );

  const recovered = await new ExecutionRunStore(root, graph.runId, {
    transitionLockTimeoutMs: 500,
    transitionStaleLockMs: 1,
  }).commitTransition(input);

  assert.equal(recovered.status, 'committed');
  assert.equal(
    (await base.loadTransitions()).some(
      (record) => record.transitionId === input.transitionId
    ),
    true
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

test('exact terminal replay remains idempotent after the run advances to a child graph', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await store.initializeGraph(graph);
  const acquired = await leaseStore.acquire(
    graph,
    'task-a',
    'attempt-replay-after-advance'
  );

  const input = {
    transitionId: 'complete-before-advance',
    graphRevision: graph.revisionId,
    nodeId: 'task-a',
    attemptId: acquired.authorization.attemptId,
    kind: 'task_completed',
    effectPolicy: acquired.authorization.effectPolicy,
    request: {
      descriptorHash: graph.descriptorHash,
      leaseId: acquired.authorization.leaseId,
    },
    evidenceRefs: ['test:complete-before-advance'],
    result: { outcome: 'pass' },
  };
  const committed = await store.commitTransition(input);
  await store.releaseTaskLease(
    acquired.authorization,
    committed.record.transitionId
  );

  const child = requestLeaseExtension(graph, {
    taskId: 'task-a',
    resources: ['contract:after-completion'],
  }).graph;
  await store.advanceGraph(child);

  const replay = await store.commitTransition(input);
  assert.equal(replay.status, 'replayed');
  assert.equal(
    replay.record.transitionId,
    committed.record.transitionId
  );
  assert.equal(
    (await store.loadGraph()).descriptorHash,
    child.descriptorHash
  );
});

test('terminal transition commit rejects a descriptor that is not the current sealed graph', async () => {
  const root = await tempProject();
  const graph = graphFor();
  const store = new ExecutionRunStore(root, graph.runId);
  await store.initializeGraph(graph);

  await assert.rejects(
    () => store.commitTransition({
      transitionId: 'complete-wrong-descriptor',
      descriptorHash: 'f'.repeat(64),
      graphRevision: graph.revisionId,
      nodeId: 'task-a',
      attemptId: 'attempt-wrong-descriptor',
      kind: 'task_completed',
      effectPolicy: 'reconcile_required',
      evidenceRefs: ['test:wrong-descriptor'],
      result: { outcome: 'pass' },
    }),
    (error) =>
      error instanceof TransitionError &&
      error.code === 'TERMINAL_TRANSITION_GRAPH_MISMATCH' &&
      error.details.errors.includes('descriptorHash mismatch')
  );

  assert.equal(
    (await store.loadTransitions()).some(
      (record) => record.transitionId === 'complete-wrong-descriptor'
    ),
    false
  );
});

test('an existing completion transition wins over incomplete runtime evidence', () => {
  const graph = graphFor();
  const completed = {
    schema: 'hybrid-transition/v1',
    runId: graph.runId,
    transitionId: 'complete-a',
    descriptorHash: graph.descriptorHash,
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

test('completion from an older graph revision cannot satisfy recovery for the current revision', () => {
  const oldGraph = graphFor();
  const currentGraph = requestLeaseExtension(oldGraph, {
    taskId: 'task-a',
    resources: ['contract:new-revision'],
  }).graph;

  const oldCompletion = {
    schema: 'hybrid-transition/v1',
    runId: oldGraph.runId,
    transitionId: 'complete-old-revision',
    descriptorHash: oldGraph.descriptorHash,
    graphRevision: oldGraph.revisionId,
    nodeId: 'task-a',
    attemptId: 'attempt-old',
    kind: 'task_completed',
    effectPolicy: 'reconcile_required',
    requestFingerprint: 'd'.repeat(64),
    evidenceRefs: ['test:old-revision'],
    result: { outcome: 'pass' },
    timestamp: new Date().toISOString(),
  };

  const recovery = reconcileActivityEvidence({
    graph: currentGraph,
    taskId: 'task-a',
    transitions: [oldCompletion],
  });

  assert.equal(recovery.status, 'reconcile-required');
  assert.equal(recovery.shouldRedispatch, false);
});
