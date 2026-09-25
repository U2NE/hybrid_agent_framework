import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';
import { ExecutionRunStore } from '../../core/transitions/index.mjs';
import { ResourceLeaseStore } from '../../core/leases/index.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hybridBin = path.join(repoRoot, 'bin', 'hybrid.mjs');

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-workspace-guard-cli-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Hybrid Test']);
  await git(root, ['config', 'user.email', 'hybrid-test@example.invalid']);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 0;\n');
  await fs.writeFile(path.join(root, 'src/outside.js'), 'export const outside = 0;\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'baseline']);
  return root;
}

async function runCli(args, cwd) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [hybridBin, ...args],
    { cwd, maxBuffer: 4 * 1024 * 1024 }
  );
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('workspace-guard CLI enforces begin -> observed completion -> lease release ordering', async () => {
  const project = await fixture();
  const runId = 'run-workspace-cli';
  const graph = sealApprovedExecutionPlan({
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
    }],
  }, { runId });
  const runStore = new ExecutionRunStore(project, runId);
  const leaseStore = new ResourceLeaseStore(project, runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'A', 'attempt-1');

  const authPath = path.join(project, 'authorization.json');
  await fs.writeFile(
    authPath,
    JSON.stringify(acquired.authorization, null, 2) + '\n'
  );

  const started = await runCli(
    ['workspace-guard', 'begin', runId, authPath, project],
    project
  );
  assert.equal(started.status, 'started');
  assert.equal(started.guard.identity.taskId, 'A');

  const active = await runCli(
    ['workspace-guard', 'status', project],
    project
  );
  assert.equal(active.active, true);
  assert.equal(active.current.status, 'active');

  await fs.writeFile(path.join(project, 'src/a.js'), 'export const a = 1;\n');

  const completed = await runCli(
    ['workspace-guard', 'complete', runId, authPath, project],
    project
  );
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result.changedFiles, ['src/a.js']);

  const inactive = await runCli(
    ['workspace-guard', 'status', project],
    project
  );
  assert.equal(inactive.active, false);

  const terminal = await runStore.commitTransition({
    transitionId: 'complete-A-attempt-1',
    graphRevision: graph.revisionId,
    nodeId: 'A',
    attemptId: 'attempt-1',
    kind: 'task_completed',
    effectPolicy: acquired.authorization.effectPolicy,
    request: {
      descriptorHash: graph.descriptorHash,
      leaseId: acquired.authorization.leaseId,
    },
    evidenceRefs: ['workspace-guard:' + completed.result.guardId],
    result: {
      outcome: 'pass',
      finalSnapshotHash: completed.result.finalSnapshotHash,
    },
  });

  const released = await runCli(
    [
      'lease',
      'release',
      runId,
      authPath,
      terminal.record.transitionId,
      project,
    ],
    project
  );
  assert.equal(released.status, 'released');
  assert.equal(released.proof.transitionKind, 'task_completed');
});

test('workspace-guard CLI leaves a violation active until outside writes are reconciled', async () => {
  const project = await fixture();
  const runId = 'run-workspace-cli-violation';
  const graph = sealApprovedExecutionPlan({
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
    }],
  }, { runId });
  const runStore = new ExecutionRunStore(project, runId);
  const leaseStore = new ResourceLeaseStore(project, runId);
  await runStore.initializeGraph(graph);
  const acquired = await leaseStore.acquire(graph, 'A', 'attempt-1');

  const authPath = path.join(project, 'authorization.json');
  await fs.writeFile(
    authPath,
    JSON.stringify(acquired.authorization, null, 2) + '\n'
  );
  await runCli(
    ['workspace-guard', 'begin', runId, authPath, project],
    project
  );

  await fs.writeFile(
    path.join(project, 'src/outside.js'),
    'export const outside = 7;\n'
  );

  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [
        hybridBin,
        'workspace-guard',
        'complete',
        runId,
        authPath,
        project,
      ],
      { cwd: project, maxBuffer: 4 * 1024 * 1024 }
    ),
    (error) =>
      error.code === 1 &&
      /changed files outside its sealed write set/i.test(error.stderr)
  );

  const blocked = await runCli(
    ['workspace-guard', 'status', project],
    project
  );
  assert.equal(blocked.active, true);
  assert.equal(blocked.current.status, 'write-set-violation');

  await fs.writeFile(
    path.join(project, 'src/outside.js'),
    'export const outside = 0;\n'
  );
  const reconciled = await runCli(
    ['workspace-guard', 'complete', runId, authPath, project],
    project
  );
  assert.equal(reconciled.status, 'reconciled');
  assert.deepEqual(reconciled.result.changedFiles, []);
});
