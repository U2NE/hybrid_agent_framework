import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightSmokeCase } from '../../scripts/runtime-smoke.mjs';

test('runtime smoke Case A preflight proves sibling parallel eligibility', () => {
  const result = preflightSmokeCase('A');
  assert.deepEqual(result.waves, [['alpha', 'beta']]);
  assert.equal(result.securityReview, false);
});

test('runtime smoke Case B preflight proves same-file serialization', () => {
  const result = preflightSmokeCase('B');
  assert.deepEqual(result.waves, [['first'], ['second']]);
});

test('runtime smoke Case C preflight proves security quality-lane activation and Sol reviewer route', () => {
  const result = preflightSmokeCase('C');
  assert.equal(result.securityReview, true);
  for (const stage of ['tester', 'code-reviewer', 'security-reviewer', 'verifier']) {
    assert.ok(result.pipeline.includes(stage));
  }
  const security = result.modelRouting.stages.find((entry) => entry.stage === 'security-reviewer');
  assert.equal(security.model, 'gpt-6-sol');
});
