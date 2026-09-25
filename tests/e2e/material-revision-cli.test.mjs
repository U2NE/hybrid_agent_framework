import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createUserApprovalReceipt } from '../../core/approval/index.mjs';
import { ExecutionRunStore } from '../../core/transitions/index.mjs';
import { ResourceLeaseStore } from '../../core/leases/index.mjs';
import { sealApprovedExecutionPlan } from '../helpers/execution-approval.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hybridBin = path.join(repoRoot, 'bin', 'hybrid.mjs');

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-revision-cli-'));
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

function parentPlan() {
  return {
    phase: 'v1',
    tasks: [{
      id: 'A',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/a.js'],
      resources: [],
    }],
  };
}

test('material revision CLI proposes without mutation then applies only a new user-approved child', async () => {
  const project = await tempProject();
  const runId = 'run-revision-cli';
  const plan = parentPlan();
  const parent = sealApprovedExecutionPlan(plan, {
    runId,
    revisionId: 'G1',
  });
  const runStore = new ExecutionRunStore(project, runId);
  await runStore.initializeGraph(parent);

  const revised = structuredClone(plan);
  revised.phase = 'v2';
  revised.tasks[0].goal = 'Change public API behavior';
  revised.tasks[0].files_modified = ['src/a-v2.js'];

  const proposeInputPath = path.join(project, 'revision-propose.json');
  await fs.writeFile(
    proposeInputPath,
    JSON.stringify({
      plan: revised,
      publicApiChanged: true,
      productBehaviorChanged: true,
    }, null, 2) + '\n'
  );

  const pending = await runCli(
    ['revision', 'propose', runId, proposeInputPath, project],
    project
  );
  assert.equal(pending.status, 'user-approval-required');
  assert.equal(pending.applied, false);
  assert.equal(pending.proposal.parentDescriptorHash, parent.descriptorHash);
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    parent.descriptorHash
  );

  const receipt = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: 'revision-cli-approval',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:20:00+09:00',
  });
  const applyInputPath = path.join(project, 'revision-apply.json');
  await fs.writeFile(
    applyInputPath,
    JSON.stringify({
      plan: revised,
      proposal: pending.proposal,
      approvalReceipt: receipt,
    }, null, 2) + '\n'
  );

  const applied = await runCli(
    ['revision', 'apply', runId, applyInputPath, project],
    project
  );
  assert.equal(applied.status, 'advanced');
  assert.equal(applied.graph.revisionId, 'G2');
  assert.equal(applied.graph.parentDescriptorHash, parent.descriptorHash);
  assert.equal(applied.graph.approvalScopeHash, receipt.receiptHash);
  assert.equal(
    (await runStore.loadGraph()).descriptorHash,
    applied.graph.descriptorHash
  );
});

test('material revision CLI apply remains fenced while the parent has an active lease', async () => {
  const project = await tempProject();
  const runId = 'run-revision-cli-lease';
  const plan = parentPlan();
  const parent = sealApprovedExecutionPlan(plan, {
    runId,
    revisionId: 'G1',
  });
  const runStore = new ExecutionRunStore(project, runId);
  const leaseStore = new ResourceLeaseStore(project, runId);
  await runStore.initializeGraph(parent);

  const revised = structuredClone(plan);
  revised.phase = 'v2';
  revised.tasks[0].files_modified = ['src/a-v2.js'];

  const proposeInputPath = path.join(project, 'revision-propose.json');
  await fs.writeFile(
    proposeInputPath,
    JSON.stringify({
      plan: revised,
      featureScopeChanged: true,
    }, null, 2) + '\n'
  );
  const pending = await runCli(
    ['revision', 'propose', runId, proposeInputPath, project],
    project
  );
  const receipt = createUserApprovalReceipt({
    ...pending.approvalSubject,
    approvalId: 'revision-cli-lease-approval',
    approvedBy: 'user',
    approvedAt: '2026-09-26T07:21:00+09:00',
  });
  const applyInputPath = path.join(project, 'revision-apply.json');
  await fs.writeFile(
    applyInputPath,
    JSON.stringify({
      plan: revised,
      proposal: pending.proposal,
      approvalReceipt: receipt,
    }, null, 2) + '\n'
  );

  const active = await leaseStore.acquire(parent, 'A', 'attempt-active');
  await assert.rejects(
    () => execFileAsync(
      process.execPath,
      [
        hybridBin,
        'revision',
        'apply',
        runId,
        applyInputPath,
        project,
      ],
      { cwd: project, maxBuffer: 4 * 1024 * 1024 }
    ),
    (error) =>
      error.code === 1 &&
      /graph revision cannot advance while task leases are active/.test(error.stderr)
  );
  assert.equal((await runStore.loadGraph()).descriptorHash, parent.descriptorHash);

  await runStore.abortTaskLease(active.authorization, {
    reasonCode: 'MATERIAL_REVISION_REQUIRED',
    evidenceRefs: ['reconcile:material-revision-cli'],
  });
  const applied = await runCli(
    ['revision', 'apply', runId, applyInputPath, project],
    project
  );
  assert.equal(applied.status, 'advanced');
});
