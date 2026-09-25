import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';
import { ExecutionRunStore } from '../../core/transitions/index.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cli = path.join(root, 'bin', 'hybrid.mjs');

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-lease-cli-test-'));
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('lease CLI acquires verifies lists and releases a sealed task authorization', async () => {
  const project = await tempProject();
  const graph = sealApprovedExecutionPlan({
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
    }],
  }, {
    runId: 'run-cli',
  });
  const runStore = new ExecutionRunStore(project, graph.runId);
  await runStore.initializeGraph(graph);

  const acquired = await runCli([
    'lease',
    'acquire',
    graph.runId,
    'A',
    'attempt-1',
    project,
  ]);
  assert.equal(acquired.status, 'acquired');
  assert.equal(acquired.authorization.taskId, 'A');

  const authorizationPath = path.join(project, 'authorization.json');
  await fs.writeFile(
    authorizationPath,
    JSON.stringify(acquired.authorization, null, 2) + '\n',
    'utf8'
  );

  const verified = await runCli([
    'lease',
    'verify',
    graph.runId,
    authorizationPath,
    project,
  ]);
  assert.deepEqual(verified, {
    valid: true,
    leaseId: acquired.lease.leaseId,
  });

  const listed = await runCli(['lease', 'list', graph.runId, project]);
  assert.equal(listed.leases.length, 1);
  assert.equal(listed.leases[0].status, 'active');

  await assert.rejects(
    () => runCli([
      'lease',
      'release',
      graph.runId,
      authorizationPath,
      'missing-terminal-transition',
      project,
    ]),
    (error) =>
      String(error?.stderr || '').includes(
        'lease release transition is not present in the durable transition ledger'
      )
  );

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
    evidenceRefs: ['test:lease-cli-completion'],
    result: { outcome: 'pass' },
  });

  const released = await runCli([
    'lease',
    'release',
    graph.runId,
    authorizationPath,
    terminal.record.transitionId,
    project,
  ]);
  assert.equal(released.status, 'released');
  assert.equal(released.proof.transitionKind, 'task_completed');

  await assert.rejects(
    () => runCli([
      'lease',
      'verify',
      graph.runId,
      authorizationPath,
      project,
    ]),
    (error) => {
      const stderr = String(error?.stderr || '');
      return stderr.includes('dispatch authorization has no active durable lease');
    }
  );
});

test('lease abort CLI commits reconciled evidence before release and replays safely', async () => {
  const project = await tempProject();
  const graph = sealApprovedExecutionPlan({
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
      effect_policy: 'reconcile_required',
    }],
  }, {
    runId: 'run-cli-abort',
  });
  await new ExecutionRunStore(project, graph.runId).initializeGraph(graph);

  const acquired = await runCli([
    'lease',
    'acquire',
    graph.runId,
    'A',
    'attempt-abort',
    project,
  ]);
  const authorizationPath = path.join(project, 'abort-authorization.json');
  await fs.writeFile(
    authorizationPath,
    JSON.stringify(acquired.authorization, null, 2) + '\n',
    'utf8'
  );
  const abortPath = path.join(project, 'abort.json');
  await fs.writeFile(
    abortPath,
    JSON.stringify({
      reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
      evidenceRefs: ['workspace-guard:reconciled'],
      result: { changedFiles: [] },
    }, null, 2) + '\n',
    'utf8'
  );

  const first = await runCli([
    'lease',
    'abort',
    graph.runId,
    authorizationPath,
    abortPath,
    project,
  ]);
  const replay = await runCli([
    'lease',
    'abort',
    graph.runId,
    authorizationPath,
    abortPath,
    project,
  ]);

  assert.equal(first.status, 'aborted-released');
  assert.equal(replay.status, 'replayed');
  assert.equal(first.transition.kind, 'task_aborted_reconciled');
  assert.equal(first.proof.outcome, 'aborted-reconciled');

  const listed = await runCli(['lease', 'list', graph.runId, project]);
  assert.equal(listed.leases[0].status, 'released');
  assert.equal(
    listed.leases[0].releaseResult.schema,
    'hybrid-lease-release-proof/v1'
  );
});
