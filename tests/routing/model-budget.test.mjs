import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRoleRouting } from '../../core/routing/index.mjs';
import {
  ModelBudgetError,
  ModelBudgetStore,
  createModelBudgetApprovalReceipt,
} from '../../core/routing/budget.mjs';

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-model-budget-test-'));
}

function solRoute(level = 'sol_high') {
  return resolveRoleRouting('verifier', { routeLevel: level });
}

function lunaRoute(level = 'luna_max') {
  return resolveRoleRouting('verifier', { routeLevel: level });
}

test('Luna routes require no durable Sol reservation', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-luna');

  const reserved = await store.reserve(lunaRoute(), 'verify', 'attempt-1');
  assert.equal(reserved.status, 'not-required');
  assert.equal(reserved.consumed, false);

  const verified = await store.verify(lunaRoute(), 'verify', 'attempt-1');
  assert.equal(verified.valid, true);
  assert.equal(verified.status, 'not-required');

  const listed = await store.list();
  assert.equal(listed.usedSolReservations, 0);
  assert.equal(listed.maxSolReservations, 3);
  await assert.rejects(
    () => fs.stat(path.join(root, '.planning', 'runs', 'run-luna', 'MODEL-BUDGET.json')),
    (error) => error.code === 'ENOENT'
  );
});

test('Sol reservation is durable, idempotent, and required for verification', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-sol');
  const route = solRoute();

  await assert.rejects(
    () => store.verify(route, 'verify', 'attempt-1', {}),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_RESERVATION_REQUIRED'
  );

  const first = await store.reserve(route, 'verify', 'attempt-1');
  await assert.rejects(
    () => store.verify(route, 'verify', 'attempt-1'),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_AUTHORIZATION_REQUIRED'
  );
  const replay = await new ModelBudgetStore(root, 'run-sol').reserve(
    route,
    'verify',
    'attempt-1'
  );

  assert.equal(first.status, 'reserved');
  assert.equal(replay.status, 'replayed');
  assert.deepEqual(replay.authorization, first.authorization);
  assert.equal(first.budget.usedSolReservations, 1);
  assert.equal(first.budget.remainingSolReservations, 2);

  const verified = await store.verify(
    route,
    'verify',
    'attempt-1',
    first.authorization
  );
  assert.equal(verified.valid, true);
  assert.equal(verified.reservation.reservationId, first.reservation.reservationId);

  const stat = await fs.stat(first.path);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('same stage attempt is fenced from route mutation and authorization tampering', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-fence');
  const first = await store.reserve(solRoute('sol_high'), 'review', 'attempt-1');

  await assert.rejects(
    () => store.reserve(solRoute('sol_xhigh'), 'review', 'attempt-1'),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_ATTEMPT_FENCED'
  );

  const tampered = {
    ...first.authorization,
    reasoningEffort: 'max',
  };
  await assert.rejects(
    () => store.verify(solRoute('sol_high'), 'review', 'attempt-1', tampered),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_AUTHORIZATION_TAMPERED'
  );
});

test('automatic Sol reservations stop at the policy cap', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-cap');
  const route = solRoute();

  for (let index = 1; index <= 3; index++) {
    const result = await store.reserve(route, 'stage-' + index, 'attempt-1');
    assert.equal(result.status, 'reserved');
  }

  await assert.rejects(
    () => store.reserve(route, 'stage-4', 'attempt-1'),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_USER_APPROVAL_REQUIRED' &&
      error.details.maxSolReservations === 3 &&
      error.details.usedSolReservations === 3
  );

  const listed = await store.list();
  assert.equal(listed.initialMaxSolReservations, 3);
  assert.equal(listed.maxSolReservations, 3);
  assert.equal(listed.usedSolReservations, 3);
  assert.equal(listed.remainingSolReservations, 0);
});

test('concurrent Sol reservations cannot oversubscribe the run cap', async () => {
  const root = await tempProject();
  const route = solRoute();

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      new ModelBudgetStore(root, 'run-race').reserve(
        route,
        'stage-' + index,
        'attempt-1'
      )
    )
  );

  const fulfilled = results.filter((item) => item.status === 'fulfilled');
  const rejected = results.filter((item) => item.status === 'rejected');

  assert.equal(fulfilled.length, 3);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every(
    (item) => item.reason?.code === 'MODEL_BUDGET_USER_APPROVAL_REQUIRED'
  ));

  const listed = await new ModelBudgetStore(root, 'run-race').list();
  assert.equal(listed.usedSolReservations, 3);
});

test('only an explicit user approval receipt can raise the durable Sol limit', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-approved');
  const route = solRoute();

  for (let index = 1; index <= 3; index++) {
    await store.reserve(route, 'stage-' + index, 'attempt-1');
  }

  assert.throws(
    () => new ModelBudgetStore(root, 'run-approved', { maxSolReservations: 5 }),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_LIMIT_RAISE_REQUIRES_APPROVAL'
  );

  const receipt = createModelBudgetApprovalReceipt({
    runId: 'run-approved',
    approvalId: 'budget-approval-1',
    approvedBy: 'user',
    approvedAt: '2026-09-26T06:00:00+09:00',
    currentLimit: 3,
    newLimit: 5,
  });

  const approved = await store.approveLimit(receipt);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.budget.maxSolReservations, 5);
  assert.equal(approved.budget.remainingSolReservations, 2);

  const replay = await store.approveLimit(receipt);
  assert.equal(replay.status, 'replayed');

  await store.reserve(route, 'stage-4', 'attempt-1');
  await store.reserve(route, 'stage-5', 'attempt-1');
  await assert.rejects(
    () => store.reserve(route, 'stage-6', 'attempt-1'),
    (error) => error.code === 'MODEL_BUDGET_USER_APPROVAL_REQUIRED'
  );
});

test('multiple user budget approvals preserve approval order as a validated chain', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-chain');

  const first = createModelBudgetApprovalReceipt({
    runId: 'run-chain',
    approvalId: 'z-first',
    approvedBy: 'user',
    approvedAt: '2026-09-26T06:00:00+09:00',
    currentLimit: 3,
    newLimit: 4,
  });
  const second = createModelBudgetApprovalReceipt({
    runId: 'run-chain',
    approvalId: 'a-second',
    approvedBy: 'user',
    approvedAt: '2026-09-26T06:01:00+09:00',
    currentLimit: 4,
    newLimit: 6,
  });

  await store.approveLimit(first);
  await store.approveLimit(second);

  const listed = await new ModelBudgetStore(root, 'run-chain').list();
  assert.equal(listed.maxSolReservations, 6);
  assert.deepEqual(
    listed.limitApprovals.map((item) => item.approvalId),
    ['z-first', 'a-second']
  );
});

test('tampering with a persisted Sol reservation fails closed on restart', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-reservation-tamper');
  await store.reserve(solRoute(), 'stage-1', 'attempt-1');

  const listed = await store.list();
  const raw = JSON.parse(await fs.readFile(listed.path, 'utf8'));
  raw.reservations[0].reasoningEffort = 'xhigh';
  await fs.writeFile(listed.path, JSON.stringify(raw, null, 2) + '\n');

  await assert.rejects(
    () => new ModelBudgetStore(root, 'run-reservation-tamper').list(),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_STORE_CORRUPT' &&
      error.details.errors.includes('reservation fingerprint mismatch')
  );
});

test('tampering with the persisted limit without an approval chain fails closed', async () => {
  const root = await tempProject();
  const store = new ModelBudgetStore(root, 'run-tamper');
  await store.reserve(solRoute(), 'stage-1', 'attempt-1');

  const listed = await store.list();
  const raw = JSON.parse(await fs.readFile(listed.path, 'utf8'));
  raw.maxSolReservations = 99;
  await fs.writeFile(listed.path, JSON.stringify(raw, null, 2) + '\n');

  await assert.rejects(
    () => new ModelBudgetStore(root, 'run-tamper').list(),
    (error) =>
      error instanceof ModelBudgetError &&
      error.code === 'MODEL_BUDGET_STORE_CORRUPT' &&
      error.details.errors.includes('maxSolReservations does not match approval chain')
  );
});
