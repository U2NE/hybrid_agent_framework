import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveRoleRouting } from '../../core/routing/index.mjs';
import { createModelBudgetApprovalReceipt } from '../../core/routing/budget.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hybridBin = path.join(root, 'bin', 'hybrid.mjs');

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-model-budget-cli-'));
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

test('model-budget CLI reserves verifies lists and applies user-approved limit changes', async () => {
  const project = await tempProject();
  const route = resolveRoleRouting('verifier', { routeLevel: 'sol_high' });
  const routePath = path.join(project, 'route.json');
  await fs.writeFile(routePath, JSON.stringify(route, null, 2) + '\n');

  const reserved = await runCli(
    ['model-budget', 'reserve', 'run-cli-budget', 'verify', 'attempt-1', routePath, project],
    project
  );
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.budget.usedSolReservations, 1);

  const authorizationPath = path.join(project, 'authorization.json');
  await fs.writeFile(
    authorizationPath,
    JSON.stringify(reserved.authorization, null, 2) + '\n'
  );

  const verified = await runCli(
    [
      'model-budget',
      'verify',
      'run-cli-budget',
      'verify',
      'attempt-1',
      routePath,
      authorizationPath,
      project,
    ],
    project
  );
  assert.equal(verified.valid, true);
  assert.equal(verified.status, 'reserved');

  const listed = await runCli(
    ['model-budget', 'list', 'run-cli-budget', project],
    project
  );
  assert.equal(listed.usedSolReservations, 1);
  assert.equal(listed.maxSolReservations, 3);

  const receipt = createModelBudgetApprovalReceipt({
    runId: 'run-cli-budget',
    approvalId: 'cli-user-budget-approval',
    approvedBy: 'user',
    approvedAt: '2026-09-26T06:00:00+09:00',
    currentLimit: 3,
    newLimit: 4,
  });
  const receiptPath = path.join(project, 'budget-approval.json');
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  const approved = await runCli(
    ['model-budget', 'approve', 'run-cli-budget', receiptPath, project],
    project
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.budget.maxSolReservations, 4);
});
