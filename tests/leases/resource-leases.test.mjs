import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';
import {
  ResourceLeaseError,
  ResourceLeaseStore,
  buildTaskLeaseRequest,
} from '../../core/leases/index.mjs';
import {
  ExecutionRunStore,
  buildLeaseReleaseProof,
} from '../../core/transitions/index.mjs';

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-lease-test-'));
}

function graphFor(tasks, runId = 'run-lease', options = {}) {
  return sealApprovedExecutionPlan({ tasks }, { runId, ...options });
}

function forgedReleaseProofFor(authorization, overrides = {}) {
  return {
    schema: 'hybrid-lease-release-proof/v1',
    source: 'transition',
    transitionId: 'complete-' + authorization.attemptId,
    transitionKind: 'task_completed',
    transitionFingerprint: 'a'.repeat(64),
    runId: authorization.runId,
    descriptorHash: authorization.descriptorHash,
    graphRevision: authorization.graphRevision,
    taskId: authorization.taskId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    outcome: 'completed',
    ...overrides,
  };
}

async function commitCompletionProof(root, graph, authorization) {
  const runStore = new ExecutionRunStore(root, graph.runId);
  await runStore.initializeGraph(graph);
  const committed = await runStore.commitTransition({
    authorization,
    transitionId: 'complete-' + authorization.attemptId,
    graphRevision: authorization.graphRevision,
    nodeId: authorization.taskId,
    attemptId: authorization.attemptId,
    kind: 'task_completed',
    effectPolicy: authorization.effectPolicy,
    request: {
      descriptorHash: authorization.descriptorHash,
      leaseId: authorization.leaseId,
    },
    evidenceRefs: ['test:lease-release'],
    result: { outcome: 'pass' },
  });
  return {
    runStore,
    transition: committed.record,
    proof: buildLeaseReleaseProof(authorization, committed.record),
  };
}

test('lease request is deterministically bound to the sealed task contract', () => {
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
    reads: ['src/shared.js'],
    resources: [{ key: 'contract:a', mode: 'exclusive' }],
  }]);
  const first = buildTaskLeaseRequest(graph, 'A', 'attempt-1');
  const second = buildTaskLeaseRequest(graph, 'A', 'attempt-1');

  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.equal(first.descriptorHash, graph.descriptorHash);
  assert.equal(first.isolationMode, 'current-workspace');
  assert.equal(first.taskContract.isolation_mode, 'current-workspace');
  assert.deepEqual(first.taskContract.files_modified, ['src/a.js']);
  assert.deepEqual(first.taskContract.reads, ['src/shared.js']);
  assert.deepEqual(first.taskContract.resources, [{
    key: 'contract:a',
    mode: 'exclusive',
  }]);
});

test('exact acquire replays the same durable lease and authorization', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const firstStore = new ResourceLeaseStore(root, graph.runId);
  const first = await firstStore.acquire(graph, 'A', 'attempt-1');

  const restartedStore = new ResourceLeaseStore(root, graph.runId);
  const replay = await restartedStore.acquire(graph, 'A', 'attempt-1');

  assert.equal(first.status, 'acquired');
  assert.equal(replay.status, 'replayed');
  assert.equal(first.lease.leaseId, replay.lease.leaseId);
  assert.equal(first.lease.leaseToken, undefined);
  assert.equal(replay.lease.leaseToken, undefined);
  assert.equal(first.authorization.leaseToken, replay.authorization.leaseToken);
  assert.equal(first.authorization.isolationMode, 'current-workspace');
  assert.equal(first.authorization.taskContract.isolation_mode, 'current-workspace');
  assert.equal(await restartedStore.assertAuthorization(graph, replay.authorization), true);

  const listed = await restartedStore.list();
  assert.equal(listed.leases[0].leaseToken, undefined);

  const stat = await fs.stat(first.path);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('worktree isolation is bound into lease request and dispatch authorization', async () => {
  const root = await tempProject();
  const graph = graphFor(
    [
      {
        id: 'A',
        owner: 'implementer',
        depends_on: [],
        files_modified: ['src/a.js'],
      },
      {
        id: 'B',
        owner: 'implementer',
        depends_on: [],
        files_modified: ['src/b.js'],
      },
    ],
    'run-worktree-authority',
    {
      worktreeAvailable: true,
      isolationPlan: {
        isolation: [{ taskIds: ['A', 'B'], mode: 'worktree' }],
      },
    }
  );
  const request = buildTaskLeaseRequest(graph, 'A', 'attempt-worktree');
  assert.equal(request.isolationMode, 'worktree');
  assert.equal(request.taskContract.isolation_mode, 'worktree');

  const acquired = await new ResourceLeaseStore(root, graph.runId).acquire(
    graph,
    'A',
    'attempt-worktree'
  );
  assert.equal(acquired.authorization.isolationMode, 'worktree');
  assert.equal(
    acquired.authorization.taskContract.isolation_mode,
    'worktree'
  );
});

test('graph revision fence serializes against concurrent lease acquisition', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const store = new ResourceLeaseStore(root, graph.runId);

  let enterFence;
  const entered = new Promise((resolve) => {
    enterFence = resolve;
  });
  let releaseFence;
  const gate = new Promise((resolve) => {
    releaseFence = resolve;
  });

  const fence = store.withGraphRevisionFence(async ({ activeLeases }) => {
    assert.deepEqual(activeLeases, []);
    enterFence();
    await gate;
    return 'advanced';
  });

  await entered;
  let acquired = false;
  const acquisition = store.acquire(graph, 'A', 'attempt-after-fence').then((value) => {
    acquired = true;
    return value;
  });

  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(acquired, false);

  releaseFence();
  assert.equal(await fence, 'advanced');
  const result = await acquisition;
  assert.equal(result.status, 'acquired');
  assert.equal(acquired, true);
});

test('active writer lease blocks overlapping writer and reader leases', async () => {
  const root = await tempProject();
  const graph = graphFor([
    {
      id: 'writer',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/shared.js'],
    },
    {
      id: 'reader',
      owner: 'implementer',
      depends_on: [],
      reads: ['src/shared.js'],
      effect_policy: 'side_effect_free',
    },
    {
      id: 'other-writer',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/shared.js'],
    },
  ]);
  const store = new ResourceLeaseStore(root, graph.runId);
  await store.acquire(graph, 'writer');

  for (const taskId of ['reader', 'other-writer']) {
    await assert.rejects(
      () => store.acquire(graph, taskId),
      (error) =>
        error instanceof ResourceLeaseError &&
        error.code === 'LEASE_CONFLICT' &&
        error.details.conflicts[0].taskId === 'writer'
    );
  }
});

test('disjoint leases can be acquired concurrently by separate store instances', async () => {
  const root = await tempProject();
  const graph = graphFor([
    {
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
      resources: [{ key: 'contract:a', mode: 'exclusive' }],
    },
    {
      id: 'B',
      owner: 'design-executor',
      depends_on: [],
      files_modified: ['src/components/B.tsx'],
      resources: [{ key: 'ui:b', mode: 'exclusive' }],
    },
  ]);
  const left = new ResourceLeaseStore(root, graph.runId);
  const right = new ResourceLeaseStore(root, graph.runId);

  const results = await Promise.all([
    left.acquire(graph, 'A', 'attempt-1'),
    right.acquire(graph, 'B', 'attempt-1'),
  ]);
  assert.deepEqual(
    results.map((item) => item.status).sort(),
    ['acquired', 'acquired']
  );

  const active = await left.list({ activeOnly: true });
  assert.deepEqual(
    active.leases.map((lease) => lease.taskId).sort(),
    ['A', 'B']
  );
});

test('concurrent conflicting acquisition has exactly one winner', async () => {
  const root = await tempProject();
  const graph = graphFor([
    {
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/shared.js'],
    },
    {
      id: 'B',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/shared.js'],
    },
  ]);
  const left = new ResourceLeaseStore(root, graph.runId);
  const right = new ResourceLeaseStore(root, graph.runId);

  const settled = await Promise.allSettled([
    left.acquire(graph, 'A'),
    right.acquire(graph, 'B'),
  ]);
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = settled.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'LEASE_CONFLICT');
});

test('release is token-bound ledger-backed idempotent and a released attempt cannot execute again', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const store = new ResourceLeaseStore(root, graph.runId);
  const acquired = await store.acquire(graph, 'A');
  const forgedProof = forgedReleaseProofFor(acquired.authorization);

  await assert.rejects(
    () => store.release(acquired.lease.leaseId, 'wrong-token', forgedProof),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_TOKEN_INVALID'
  );
  await assert.rejects(
    () => store.release(
      acquired.lease.leaseId,
      acquired.authorization.leaseToken,
      null
    ),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'INVALID_LEASE_RELEASE_PROOF'
  );
  await assert.rejects(
    () => store.release(
      acquired.lease.leaseId,
      acquired.authorization.leaseToken,
      { outcome: 'pass' }
    ),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'INVALID_LEASE_RELEASE_PROOF'
  );
  await assert.rejects(
    () => store.release(
      acquired.lease.leaseId,
      acquired.authorization.leaseToken,
      forgedProof
    ),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'LEASE_RELEASE_TRANSITION_NOT_FOUND'
  );

  const { proof } = await commitCompletionProof(
    root,
    graph,
    acquired.authorization
  );

  const first = await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    proof
  );
  const replay = await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    proof
  );
  assert.equal(first.status, 'released');
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(first.lease.releaseResult, proof);

  await assert.rejects(
    () => store.release(
      acquired.lease.leaseId,
      acquired.authorization.leaseToken,
      {
        ...proof,
        transitionFingerprint: 'b'.repeat(64),
      }
    ),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_RELEASE_FENCED'
  );

  await assert.rejects(
    () => store.acquire(graph, 'A'),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_ALREADY_RELEASED'
  );
});

test('released lease fails closed if its durable terminal ledger is corrupted or removed', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }], 'run-release-ledger-integrity');
  const store = new ResourceLeaseStore(root, graph.runId);
  const acquired = await store.acquire(graph, 'A', 'attempt-ledger');
  const { runStore, proof } = await commitCompletionProof(
    root,
    graph,
    acquired.authorization
  );

  await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    proof
  );

  await fs.writeFile(runStore.transitionsPath, '{"broken":\n', 'utf8');
  await assert.rejects(
    () => new ResourceLeaseStore(root, graph.runId).list(),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'LEASE_RELEASE_LEDGER_CORRUPT'
  );

  await fs.rm(runStore.transitionsPath, { force: true });
  await assert.rejects(
    () => new ResourceLeaseStore(root, graph.runId).list(),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'LEASE_RELEASE_TRANSITION_NOT_FOUND'
  );
});

test('tampered or released dispatch authorization fails closed', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const store = new ResourceLeaseStore(root, graph.runId);
  const acquired = await store.acquire(graph, 'A');

  const tampered = structuredClone(acquired.authorization);
  tampered.taskContract.files_modified.push('src/escape.js');
  await assert.rejects(
    () => store.assertAuthorization(graph, tampered),
    (error) => error instanceof ResourceLeaseError && error.code === 'DISPATCH_AUTH_TAMPERED'
  );

  const { proof } = await commitCompletionProof(
    root,
    graph,
    acquired.authorization
  );
  await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    proof
  );
  await assert.rejects(
    () => store.assertAuthorization(graph, acquired.authorization),
    (error) => error instanceof ResourceLeaseError && error.code === 'DISPATCH_AUTH_INACTIVE'
  );
});

test('stale store lock is reclaimed only when its owner process is gone', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const runDir = path.join(root, '.planning', 'runs', graph.runId);
  const lockPath = path.join(runDir, '.leases.lock');
  await fs.mkdir(runDir, { recursive: true });

  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date(0).toISOString() }) + '\n',
    'utf8'
  );
  await fs.utimes(lockPath, new Date(0), new Date(0));

  const liveOwnerStore = new ResourceLeaseStore(root, graph.runId, {
    lockTimeoutMs: 60,
    staleLockMs: 1,
  });
  await assert.rejects(
    () => liveOwnerStore.acquire(graph, 'A'),
    (error) =>
      error instanceof ResourceLeaseError &&
      error.code === 'LEASE_STORE_LOCK_TIMEOUT'
  );

  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 999999999, acquiredAt: new Date(0).toISOString() }) + '\n',
    'utf8'
  );
  await fs.utimes(lockPath, new Date(0), new Date(0));

  const orphanStore = new ResourceLeaseStore(root, graph.runId, {
    lockTimeoutMs: 200,
    staleLockMs: 1,
  });
  const acquired = await orphanStore.acquire(graph, 'A');
  assert.equal(acquired.status, 'acquired');
});

test('active lease survives restart and is never guessed stale from worker absence', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const firstStore = new ResourceLeaseStore(root, graph.runId);
  const acquired = await firstStore.acquire(graph, 'A');

  const restarted = new ResourceLeaseStore(root, graph.runId);
  const active = await restarted.list({ activeOnly: true });
  assert.equal(active.leases.length, 1);
  assert.equal(active.leases[0].leaseId, acquired.lease.leaseId);
  assert.equal(active.leases[0].status, 'active');
});
