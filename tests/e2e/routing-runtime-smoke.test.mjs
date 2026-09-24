import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodexProbeArgs,
  routingEffortPreflight,
  runAuthenticatedRoutingSmoke,
  runWithSessionFallback,
} from '../../scripts/routing-runtime-smoke.mjs';

test('routing effort preflight covers Luna medium high xhigh max before Sol', () => {
  assert.deepEqual(routingEffortPreflight(), [
    { name: 'routine', routeLevel: 'luna_medium', model: 'gpt-6-luna', reasoningEffort: 'medium' },
    { name: 'moderate', routeLevel: 'luna_high', model: 'gpt-6-luna', reasoningEffort: 'high' },
    { name: 'hard', routeLevel: 'luna_xhigh', model: 'gpt-6-luna', reasoningEffort: 'xhigh' },
    { name: 'very-hard', routeLevel: 'luna_max', model: 'gpt-6-luna', reasoningEffort: 'max' },
    { name: 'luna-exhausted', routeLevel: 'sol_high', model: 'gpt-6-sol', reasoningEffort: 'high' },
  ]);
});

test('Codex routing probe uses explicit model plus model_reasoning_effort config override', () => {
  const args = buildCodexProbeArgs({
    model: 'gpt-6-luna',
    reasoningEffort: 'xhigh',
    cwd: '/tmp/probe',
  });
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('gpt-6-luna'));
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
});

test('negative model rejection retries once with session inheritance and no override', async () => {
  const calls = [];
  const runner = async (_bin, args) => {
    calls.push(args);
    return calls.length === 1
      ? { code: 1, stdout: '', stderr: 'unknown model' }
      : { code: 0, stdout: 'OK', stderr: '' };
  };

  const result = await runWithSessionFallback({
    codexBin: 'codex',
    workspace: '/tmp/probe',
    model: 'gpt-6-invalid',
    reasoningEffort: 'medium',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fallbackUsed, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('-m'));
  assert.equal(calls[1].includes('-m'), false);
  assert.equal(calls[1].includes('-c'), false);
});

test('authenticated routing smoke report semantics distinguish override acceptance from model identity attestation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-routing-fixture-'));
  await fs.mkdir(path.join(root, '.git'));
  let call = 0;
  const runner = async () => {
    call++;
    if (call === 4) return { code: 1, stdout: '', stderr: 'model not found' };
    return { code: 0, stdout: '{"type":"item.completed"}\n', stderr: '' };
  };

  const result = await runAuthenticatedRoutingSmoke({
    workspace: root,
    runner,
    invalidModel: 'gpt-6-invalid',
  });

  assert.deepEqual(
    result.effortResults.map((item) => [item.effort, item.overrideRequestAccepted]),
    [['high', true], ['xhigh', true], ['max', true]]
  );
  assert.equal(result.fallback.firstRejected, true);
  assert.equal(result.fallback.fallbackUsed, true);
  assert.equal(result.fallback.fallbackSucceeded, true);
  assert.equal(result.claims.modelIdentityAttested, false);
});
