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

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-lease-test-'));
}

function graphFor(tasks, runId = 'run-lease') {
  return sealApprovedExecutionPlan({ tasks }, { runId });
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
  assert.equal(await restartedStore.assertAuthorization(graph, replay.authorization), true);

  const listed = await restartedStore.list();
  assert.equal(listed.leases[0].leaseToken, undefined);

  const stat = await fs.stat(first.path);
  assert.equal(stat.mode & 0o777, 0o600);
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

test('release is token-bound idempotent and a released attempt cannot execute again', async () => {
  const root = await tempProject();
  const graph = graphFor([{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const store = new ResourceLeaseStore(root, graph.runId);
  const acquired = await store.acquire(graph, 'A');

  await assert.rejects(
    () => store.release(acquired.lease.leaseId, 'wrong-token', { outcome: 'pass' }),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_TOKEN_INVALID'
  );

  const first = await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    { outcome: 'pass', patchHash: 'a'.repeat(64) }
  );
  const replay = await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    { outcome: 'pass', patchHash: 'a'.repeat(64) }
  );
  assert.equal(first.status, 'released');
  assert.equal(replay.status, 'replayed');

  await assert.rejects(
    () => store.release(
      acquired.lease.leaseId,
      acquired.authorization.leaseToken,
      { outcome: 'fail' }
    ),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_RELEASE_FENCED'
  );

  await assert.rejects(
    () => store.acquire(graph, 'A'),
    (error) => error instanceof ResourceLeaseError && error.code === 'LEASE_ALREADY_RELEASED'
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

  await store.release(
    acquired.lease.leaseId,
    acquired.authorization.leaseToken,
    { outcome: 'pass' }
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
