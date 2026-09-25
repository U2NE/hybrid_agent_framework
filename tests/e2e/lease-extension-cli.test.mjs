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

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-lease-extension-cli-'));
}

function graphFor(runId) {
  return sealApprovedExecutionPlan({
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
      resources: [],
    }],
  }, { runId, revisionId: 'G1' });
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

test('lease extend CLI drains old revision then publishes child and requires a fresh attempt', async () => {
  const project = await tempProject();
  const runId = 'run-lease-extension-cli';
  const graph = graphFor(runId);
  const runStore = new ExecutionRunStore(project, runId);
  const leaseStore = new ResourceLeaseStore(project, runId);
  await runStore.initializeGraph(graph);

  const oldAttempt = await leaseStore.acquire(graph, 'A', 'attempt-1');
  const extensionPath = path.join(project, 'extension.json');
  await fs.writeFile(
    extensionPath,
    JSON.stringify({
      taskId: 'A',
      resources: [{ key: 'contract:api', mode: 'exclusive' }],
    }, null, 2) + '\n'
  );

  const blocked = await runCli(
    ['lease', 'extend', runId, extensionPath, project],
    project
  );
  assert.equal(blocked.status, 'drain-required');
  assert.equal(blocked.applied, false);
  assert.equal(blocked.graph.descriptorHash, graph.descriptorHash);
  assert.equal(blocked.activeLeases.length, 1);

  await runStore.abortTaskLease(oldAttempt.authorization, {
    reasonCode: 'RESOURCE_EXTENSION_REQUIRED',
    evidenceRefs: ['reconcile:lease-extension-cli'],
  });

  const extended = await runCli(
    ['lease', 'extend', runId, extensionPath, project],
    project
  );
  assert.equal(extended.status, 'extended');
  assert.equal(extended.applied, true);
  assert.equal(extended.graph.revisionId, 'G2');
  assert.equal(extended.graph.parentDescriptorHash, graph.descriptorHash);

  const newAttempt = await leaseStore.acquire(
    extended.graph,
    'A',
    'attempt-2'
  );
  assert.deepEqual(
    newAttempt.authorization.taskContract.resources,
    [{ key: 'contract:api', mode: 'exclusive' }]
  );
});

test('lease extend CLI returns user approval boundary for material semantics', async () => {
  const project = await tempProject();
  const runId = 'run-lease-extension-material-cli';
  const graph = graphFor(runId);
  const runStore = new ExecutionRunStore(project, runId);
  await runStore.initializeGraph(graph);

  const extensionPath = path.join(project, 'extension-material.json');
  await fs.writeFile(
    extensionPath,
    JSON.stringify({
      taskId: 'A',
      resources: ['schema:database'],
      schemaMeaningChanged: true,
    }, null, 2) + '\n'
  );

  const result = await runCli(
    ['lease', 'extend', runId, extensionPath, project],
    project
  );
  assert.equal(result.status, 'user-approval-required');
  assert.equal(result.materialRevisionRequired, true);
  assert.deepEqual(result.reasons, ['SCHEMA_MEANING_CHANGE']);
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    graph.descriptorHash
  );
});

test('lease extend CLI refuses file contract mutation', async () => {
  const project = await tempProject();
  const runId = 'run-lease-extension-forbidden-cli';
  const graph = graphFor(runId);
  await new ExecutionRunStore(project, runId).initializeGraph(graph);

  const extensionPath = path.join(project, 'extension-forbidden.json');
  await fs.writeFile(
    extensionPath,
    JSON.stringify({
      taskId: 'A',
      resources: ['contract:x'],
      writes: ['src/b.js'],
    }, null, 2) + '\n'
  );

  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [hybridBin, 'lease', 'extend', runId, extensionPath, project],
      { cwd: project, maxBuffer: 4 * 1024 * 1024 }
    ),
    (error) =>
      error.code === 1 &&
      /contract changes require a material revision/i.test(error.stderr)
  );

  assert.equal(
    (await new ExecutionRunStore(project, runId).loadGraph()).descriptorHash,
    graph.descriptorHash
  );
});
