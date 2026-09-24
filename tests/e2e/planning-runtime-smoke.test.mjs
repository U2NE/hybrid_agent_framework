import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERGENCE_CRITERIA,
  preflightPlanningConvergence,
  validatePlanningConvergenceReport,
} from '../../scripts/planning-convergence-smoke.mjs';

test('planning convergence preflight contains a real rollback acceptance gap', () => {
  const report = preflightPlanningConvergence();
  assert.equal(report.initialCoverage.pass, false);
  assert.equal(report.initialCoverage.missing.length, 1);
  assert.equal(report.initialCoverage.missing[0].criterion, CONVERGENCE_CRITERIA[2]);
  assert.equal(report.consensusPolicy.maxIterations, 3);
});

test('planning convergence semantic validator refuses exit-zero style fake success', () => {
  const result = validatePlanningConvergenceReport({
    preflight: { consensusPolicy: { maxIterations: 3 } },
    revisions: [
      {
        revision: 1,
        planHash: 'v1',
        coverage: {
          pass: false,
          missing: [{ criterion: CONVERGENCE_CRITERIA[2] }],
        },
      },
      {
        revision: 2,
        planHash: 'v2',
        coverage: { pass: true, missing: [] },
        addressed: ['rollback acceptance gap'],
        sourceReviewHashes: ['a', 'b'],
      },
    ],
    reviewRounds: [],
    consensusTransitions: [],
    finalState: {
      status: 'pending-user-approval',
      approved: true,
      executionApproved: false,
    },
    finalGitStatus: '',
    runtimeError: null,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /review round 1 missing/.test(error)));
  assert.ok(result.errors.some((error) => /review round 2 missing/.test(error)));
});

test('planning convergence semantic validator accepts a real three-revision closed loop', () => {
  const runtime = { exitCode: 0, timedOut: false };
  const round = (revision, hash, architectVerdict, auditorVerdict, findings = []) => ({
    revision,
    planHash: hash,
    sameSnapshot: true,
    independent: true,
    overlapObserved: true,
    repositoryStatusBefore: '',
    repositoryStatusAfter: '',
    materialFindings: findings,
    architect: {
      role: 'architect',
      revision,
      planHash: hash,
      verdict: architectVerdict,
      planModified: false,
      runtime,
    },
    auditor: {
      role: 'plan-auditor',
      revision,
      planHash: hash,
      verdict: auditorVerdict,
      planModified: false,
      runtime,
    },
  });

  const report = {
    preflight: { consensusPolicy: { maxIterations: 3 } },
    revisions: [
      {
        revision: 1,
        planHash: 'hash-v1',
        coverage: {
          pass: false,
          missing: [{ criterion: CONVERGENCE_CRITERIA[2] }],
        },
        addressed: [],
        sourceReviewHashes: [],
      },
      {
        revision: 2,
        planHash: 'hash-v2',
        coverage: { pass: true, missing: [] },
        addressed: ['Added rollback implementation and isolated verification'],
        sourceReviewHashes: ['review-a-v1', 'review-b-v1'],
      },
      {
        revision: 3,
        planHash: 'hash-v3',
        coverage: { pass: true, missing: [] },
        addressed: ['Closed exact-file and rollback side-effect objections'],
        sourceReviewHashes: ['review-a-v2', 'review-b-v2'],
      },
    ],
    reviewRounds: [
      round(
        1,
        'hash-v1',
        'ITERATE',
        'ITERATE',
        ['major: rollback acceptance criterion is missing']
      ),
      round(
        2,
        'hash-v2',
        'ITERATE',
        'ITERATE',
        ['major: rollback verification side effects remain']
      ),
      round(3, 'hash-v3', 'APPROVE', 'APPROVE', []),
    ],
    consensusTransitions: [
      { iteration: 1, status: 'revision-required' },
      { iteration: 2, status: 'revision-required' },
      { iteration: 3, status: 'pending-user-approval' },
    ],
    finalState: {
      status: 'pending-user-approval',
      approved: true,
      executionApproved: false,
    },
    finalGitStatus: '',
    runtimeError: null,
  };

  assert.deepEqual(validatePlanningConvergenceReport(report), { ok: true, errors: [] });

  report.reviewRounds[2].auditor.planHash = 'wrong';
  assert.equal(validatePlanningConvergenceReport(report).ok, false);
});
