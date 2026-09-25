import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFailureEnvelope,
  failureNeedsModelEscalation,
} from '../../core/routing/failure-envelope.mjs';
import {
  nextRouteStep,
  resolveRoleRouting,
} from '../../core/routing/index.mjs';

test('route ladder advances one rung at a time across Luna Max into Sol High', () => {
  assert.equal(nextRouteStep('luna_medium'), 'luna_high');
  assert.equal(nextRouteStep('luna_high'), 'luna_xhigh');
  assert.equal(nextRouteStep('luna_xhigh'), 'luna_max');
  assert.equal(nextRouteStep('luna_max'), 'sol_high');
  assert.equal(nextRouteStep('sol_high'), 'sol_xhigh');
  assert.equal(nextRouteStep('sol_xhigh'), 'sol_max');
  assert.equal(nextRouteStep('sol_max'), 'sol_max');
});

test('environment, tool, and policy failures do not spend more model reasoning', () => {
  for (const kind of ['environment', 'tool', 'policy']) {
    const envelope = buildFailureEnvelope({
      kind,
      stage: 'implementation',
      targetRole: 'implementer',
      attemptedRoute: 'luna_high',
      message: 'transient failure 42',
    });
    assert.equal(failureNeedsModelEscalation(envelope), false);
    assert.equal(
      resolveRoleRouting('implementer', { context: { failureEnvelope: envelope } }).routeLevel,
      'luna_high'
    );
  }
});

test('first model-format failure retries the same route', () => {
  const envelope = buildFailureEnvelope({
    kind: 'model-format',
    stage: 'planning',
    targetRole: 'planner',
    attemptedRoute: 'luna_high',
    sameFailureCount: 1,
  });
  assert.equal(envelope.recommendedAction, 'retry-same-route');
  assert.equal(
    resolveRoleRouting('planner', { context: { failureEnvelope: envelope } }).routeLevel,
    'luna_high'
  );
});

test('reasoning failure moves exactly one rung from the attempted route', () => {
  const cases = [
    ['luna_medium', 'luna_high'],
    ['luna_high', 'luna_xhigh'],
    ['luna_xhigh', 'luna_max'],
    ['luna_max', 'sol_high'],
    ['sol_high', 'sol_xhigh'],
    ['sol_xhigh', 'sol_max'],
  ];
  for (const [attemptedRoute, expected] of cases) {
    const envelope = buildFailureEnvelope({
      kind: 'verification',
      stage: 'verification',
      targetRole: 'verifier',
      attemptedRoute,
      sameFailureCount: 2,
      semanticProgress: 'none',
    });
    assert.equal(
      resolveRoleRouting('verifier', { context: { failureEnvelope: envelope } }).routeLevel,
      expected
    );
  }
});

test('new actionable evidence keeps the same model for a targeted retry', () => {
  const envelope = buildFailureEnvelope({
    kind: 'implementation',
    stage: 'repair',
    targetRole: 'implementer',
    attemptedRoute: 'luna_medium',
    semanticProgress: 'new-evidence',
  });
  assert.equal(envelope.recommendedAction, 'retry-targeted-same-route');
  assert.equal(
    resolveRoleRouting('implementer', { context: { failureEnvelope: envelope } }).routeLevel,
    'luna_medium'
  );
});

test('failure envelope only affects its target role', () => {
  const envelope = buildFailureEnvelope({
    kind: 'verification',
    stage: 'verification',
    targetRole: 'verifier',
    attemptedRoute: 'luna_max',
    sameFailureCount: 2,
  });
  assert.equal(
    resolveRoleRouting('verifier', { context: { failureEnvelope: envelope } }).routeLevel,
    'sol_high'
  );
  assert.equal(
    resolveRoleRouting('code-reviewer', { context: { failureEnvelope: envelope } }).routeLevel,
    'luna_high'
  );
});

test('legacy verifier failure count follows the same gradual ladder and stays role-local', () => {
  assert.equal(
    resolveRoleRouting('verifier', { context: { verificationFailures: 1 } }).routeLevel,
    'luna_high'
  );
  assert.equal(
    resolveRoleRouting('verifier', { context: { verificationFailures: 2 } }).routeLevel,
    'luna_xhigh'
  );
  assert.equal(
    resolveRoleRouting('verifier', { context: { verificationFailures: 3 } }).routeLevel,
    'luna_max'
  );
  assert.equal(
    resolveRoleRouting('verifier', { context: { verificationFailures: 4 } }).routeLevel,
    'sol_high'
  );
  assert.equal(
    resolveRoleRouting('code-reviewer', { context: { verificationFailures: 4 } }).routeLevel,
    'luna_high'
  );
});
