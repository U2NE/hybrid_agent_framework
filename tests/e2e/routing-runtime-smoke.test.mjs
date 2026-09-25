import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCodexProbeArgs,
  routingEffortPreflight,
  runAuthenticatedRoutingSmoke,
  runWithFailClosedModel,
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

test('unapproved model fails locally and is never retried without an override', async () => {
  const calls = [];
  const runner = async (_bin, args) => {
    calls.push(args);
    return { code: 0, stdout: 'SHOULD_NOT_RUN', stderr: '' };
  };

  const result = await runWithFailClosedModel({
    codexBin: 'codex',
    workspace: '/tmp/probe',
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
    runner,
  });

  assert.equal(result.ok, false);
  assert.equal(result.localRejected, true);
  assert.equal(result.runnerCalled, false);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.rejectionCode, 'MODEL_NOT_ALLOWED');
  assert.equal(calls.length, 0);
});

test('runtime rejection of an allowed explicit model does not trigger session/default fallback', async () => {
  const calls = [];
  const runner = async (_bin, args) => {
    calls.push(args);
    return { code: 1, stdout: '', stderr: 'requested model unavailable' };
  };

  const result = await runWithFailClosedModel({
    codexBin: 'codex',
    workspace: '/tmp/probe',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    runner,
  });

  assert.equal(result.ok, false);
  assert.equal(result.localRejected, false);
  assert.equal(result.runnerCalled, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.rejectionCode, 'MODEL_OVERRIDE_REJECTED');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('-m'));
  assert.ok(calls[0].includes('-c'));
});

test('authenticated routing smoke report distinguishes explicit request acceptance from serving identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-routing-fixture-'));
  await fs.mkdir(path.join(root, '.git'));
  const calls = [];
  const runner = async (_bin, args) => {
    calls.push(args);
    return { code: 0, stdout: '{"type":"item.completed"}\n', stderr: '' };
  };

  const result = await runAuthenticatedRoutingSmoke({
    workspace: root,
    runner,
    invalidModel: 'gpt-6-astra',
  });

  assert.deepEqual(
    result.effortResults.map((item) => [item.effort, item.overrideRequestAccepted]),
    [['high', true], ['xhigh', true], ['max', true]]
  );
  assert.equal(result.invalidModel.localRejected, true);
  assert.equal(result.invalidModel.runnerCalled, false);
  assert.equal(result.invalidModel.fallbackUsed, false);
  assert.equal(result.invalidModel.rejectionCode, 'MODEL_NOT_ALLOWED');
  assert.equal(calls.length, 3);
  assert.equal(result.claims.modelIdentityAttested, false);
});
