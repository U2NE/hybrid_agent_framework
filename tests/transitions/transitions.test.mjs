import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestLeaseExtension } from '../../core/execution-graph/index.mjs';
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
