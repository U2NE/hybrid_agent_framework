import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';
import { ResourceLeaseStore } from '../../core/leases/index.mjs';
import {
  WorkspaceGuardError,
  beginCurrentWorkspaceGuard,
  completeCurrentWorkspaceGuard,
  inspectCurrentWorkspaceGuard,
} from '../../core/workspace-guard/index.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function fixture(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-workspace-guard-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Hybrid Test']);
  await git(root, ['config', 'user.email', 'hybrid-test@example.invalid']);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function graphFor(runId, tasks) {
  return sealApprovedExecutionPlan({ tasks }, { runId });
}

async function authorizationFor(root, graph, taskId, attemptId = 'attempt-1') {
  return (await new ResourceLeaseStore(root, graph.runId).acquire(
    graph,
    taskId,
    attemptId
  )).authorization;
}

test('current-workspace guard records allowed observed writes and prevents duplicate execution', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/other.js': 'export const other = 0;\n',
  });
  const graph = graphFor('run-guard-allowed', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  const begun = await beginCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });
  assert.equal(begun.status, 'started');
  assert.deepEqual(begun.guard.allowedWrites, ['src/a.js']);

  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 1;\n');
  const completed = await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.attribution, 'observed');
  assert.deepEqual(completed.result.changedFiles, ['src/a.js']);
  assert.deepEqual(completed.result.allowedWrites, ['src/a.js']);
  assert.equal((await inspectCurrentWorkspaceGuard(root)).active, false);

  const replayedCompletion = await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });
  assert.equal(replayedCompletion.status, 'replayed');
  assert.deepEqual(replayedCompletion.result, completed.result);

  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WORKSPACE_GUARD_ALREADY_COMPLETED'
  );
});

test('concurrent duplicate completion converges on one durable result', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const graph = graphFor('run-guard-concurrent-complete', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 8;\n');

  const results = await Promise.all([
    completeCurrentWorkspaceGuard({ projectRoot: root, graph, authorization }),
    completeCurrentWorkspaceGuard({ projectRoot: root, graph, authorization }),
  ]);

  assert.deepEqual(
    results.map((item) => item.status).sort(),
    ['completed', 'replayed']
  );
  assert.deepEqual(results[0].result, results[1].result);
  assert.equal((await inspectCurrentWorkspaceGuard(root)).active, false);
});

test('explicit sealed writes beyond files_modified are valid workspace ownership', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/contract.js': 'export const contract = 0;\n',
  });
  const graph = graphFor('run-guard-explicit-write', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
    writes: ['src/contract.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(
    path.join(root, 'src/contract.js'),
    'export const contract = 1;\n'
  );
  const completed = await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });

  assert.deepEqual(completed.result.changedFiles, ['src/contract.js']);
  assert.deepEqual(
    completed.result.allowedWrites,
    ['src/a.js', 'src/contract.js']
  );
});

test('pre-existing dirty state is baseline evidence and is not falsely attributed when untouched', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/preexisting.js': 'export const preexisting = 0;\n',
  });
  await fs.writeFile(
    path.join(root, 'src/preexisting.js'),
    'export const preexisting = 5;\n'
  );

  const graph = graphFor('run-guard-dirty', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 2;\n');

  const completed = await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });
  assert.deepEqual(completed.result.changedFiles, ['src/a.js']);
  assert.equal(
    await fs.readFile(path.join(root, 'src/preexisting.js'), 'utf8'),
    'export const preexisting = 5;\n'
  );
});

test('modifying a pre-existing dirty outside file is still a write-set violation', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/preexisting.js': 'export const preexisting = 0;\n',
  });
  await fs.writeFile(
    path.join(root, 'src/preexisting.js'),
    'export const preexisting = 5;\n'
  );

  const graph = graphFor('run-guard-dirty-change', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(
    path.join(root, 'src/preexisting.js'),
    'export const preexisting = 6;\n'
  );

  await assert.rejects(
    () => completeCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WRITE_SET_VIOLATION' &&
      error.details.outsideWrites.includes('src/preexisting.js')
  );
});

test('outside tracked and untracked writes fail closed and can be reconciled by restoring them', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/outside.js': 'export const outside = 0;\n',
  });
  const graph = graphFor('run-guard-violation', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 3;\n');
  await fs.writeFile(
    path.join(root, 'src/outside.js'),
    'export const outside = 9;\n'
  );
  await fs.writeFile(path.join(root, 'scratch.txt'), 'unexpected\n');

  await assert.rejects(
    () => completeCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WRITE_SET_VIOLATION' &&
      error.details.outsideWrites.includes('src/outside.js') &&
      error.details.outsideWrites.includes('scratch.txt')
  );

  const blocked = await inspectCurrentWorkspaceGuard(root);
  assert.equal(blocked.active, true);
  assert.equal(blocked.current.status, 'write-set-violation');

  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WORKSPACE_GUARD_RECONCILIATION_REQUIRED'
  );

  await fs.writeFile(
    path.join(root, 'src/outside.js'),
    'export const outside = 0;\n'
  );
  await fs.rm(path.join(root, 'scratch.txt'));

  const reconciled = await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph,
    authorization,
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.deepEqual(reconciled.result.changedFiles, ['src/a.js']);
  assert.equal((await inspectCurrentWorkspaceGuard(root)).active, false);
});

test('current-workspace writer guard is repository-global even across separate runs', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/b.js': 'export const b = 0;\n',
  });
  const graphA = graphFor('run-guard-global-a', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const graphB = graphFor('run-guard-global-b', [{
    id: 'B',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/b.js'],
  }]);
  const authorizationA = await authorizationFor(root, graphA, 'A');
  const authorizationB = await authorizationFor(root, graphB, 'B');

  await beginCurrentWorkspaceGuard({
    projectRoot: root,
    graph: graphA,
    authorization: authorizationA,
  });

  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph: graphB,
      authorization: authorizationB,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'CURRENT_WORKSPACE_BUSY'
  );

  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 4;\n');
  await completeCurrentWorkspaceGuard({
    projectRoot: root,
    graph: graphA,
    authorization: authorizationA,
  });

  const second = await beginCurrentWorkspaceGuard({
    projectRoot: root,
    graph: graphB,
    authorization: authorizationB,
  });
  assert.equal(second.status, 'started');
});

test('HEAD movement during a guarded task requires reconciliation and preserves the guard', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const graph = graphFor('run-guard-head', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const authorization = await authorizationFor(root, graph, 'A');

  await beginCurrentWorkspaceGuard({ projectRoot: root, graph, authorization });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 5;\n');
  await git(root, ['add', 'src/a.js']);
  await git(root, ['commit', '-qm', 'unexpected commit']);

  await assert.rejects(
    () => completeCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WORKSPACE_BASE_MOVED'
  );

  const current = await inspectCurrentWorkspaceGuard(root);
  assert.equal(current.active, true);
  assert.equal(current.current.status, 'reconcile-required');

  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization,
    }),
    (error) =>
      error instanceof WorkspaceGuardError &&
      error.code === 'WORKSPACE_GUARD_RECONCILIATION_REQUIRED'
  );
});

test('tampered or inactive dispatch authorization cannot control a workspace guard', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const graph = graphFor('run-guard-auth', [{
    id: 'A',
    owner: 'implementer',
    depends_on: [],
    files_modified: ['src/a.js'],
  }]);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  const acquired = await leaseStore.acquire(graph, 'A', 'attempt-1');

  const tampered = {
    ...acquired.authorization,
    taskId: 'other-task',
  };
  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization: tampered,
    }),
    (error) => /dispatch authorization/i.test(error.message)
  );

  await leaseStore.release(
    acquired.authorization.leaseId,
    acquired.authorization.leaseToken,
    { outcome: 'cancelled' }
  );
  await assert.rejects(
    () => beginCurrentWorkspaceGuard({
      projectRoot: root,
      graph,
      authorization: acquired.authorization,
    }),
    (error) => /no active durable lease/i.test(error.message)
  );
});
