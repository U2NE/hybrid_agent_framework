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


test('runtime smoke Case D preflight proves iterative clarification report semantics', () => {
  const report = preflightSmokeCase('D');

  assert.equal(report.round0.kind, 'topology');
  assert.equal(report.threshold, 0.20);
  assert.ok(report.roundCount >= 2);
  assert.equal(report.rounds.length, report.roundCount);
  assert.ok(report.rounds.every((round) => round.question.length > 0));
  assert.ok(report.rounds.every((round) => round.component && round.dimension));
  assert.ok(report.rounds.every((round) => round.ambiguityBefore !== round.ambiguityAfter));

  const targets = report.rounds.map((round) => round.component + ':' + round.dimension);
  assert.ok(new Set(targets).size >= 2);
  assert.ok(report.final.ambiguity <= report.threshold);
  assert.equal(report.final.pass, true);
  assert.equal(report.final.specReady, true);
  assert.equal(report.final.approvalRequired, true);
  assert.equal(report.final.approvalStatus, 'pending');
});
