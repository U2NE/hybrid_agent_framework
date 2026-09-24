import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIndependentVerification,
  buildAcceptanceTrace,
  evaluateAcceptanceTrace,
  evaluateVerificationReport,
  requiresSecurityReview,
  runFixLoop,
} from '../../core/verification/index.mjs';

test('implementation cannot mark itself verified', () => {
  assert.throws(
    () => assertIndependentVerification('worker-a', 'worker-a'),
    (error) => error.code === 'SELF_VERIFICATION'
  );
  assert.equal(assertIndependentVerification('worker-a', 'verifier-a'), true);
});

test('fix loop stops at configured maximum', async () => {
  let fixes = 0;
  const result = await runFixLoop({
    maxIterations: 3,
    verify: async () => ({ ok: false, evidence: 'still failing' }),
    fix: async () => ({ changed: ++fixes }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(fixes, 3);
  assert.equal(result.attempts, 3);
});

test('strong security surfaces activate security review', () => {
  const cases = [
    { description: 'change authentication flow' },
    { description: 'change authorization policy' },
    { description: 'change JWT session validation' },
    { description: 'replace crypto primitive' },
    { description: 'change secret storage handling' },
    { description: 'update payment webhook' },
    { description: 'add file upload endpoint' },
    { description: 'change SQL query builder' },
    { description: 'change permission checks' },
    { description: 'change network trust boundary' },
    { description: 'prevent SSRF in outbound requests' },
    { description: 'fix XSS output escaping' },
  ];

  for (const input of cases) {
    assert.equal(requiresSecurityReview(input), true, JSON.stringify(input));
  }
  assert.equal(requiresSecurityReview({ files: ['src/auth/login.ts'] }), true);
});

test('weak security words in documentation or labels do not trigger review by themselves', () => {
  const cases = [
    { description: 'update network docs', files: ['docs/network.md'] },
    { description: 'rename permission label', files: ['src/ui/labels.ts'] },
    { description: 'mention secret in documentation', files: ['README.md'] },
    { description: 'update token wording in locale', files: ['locales/en.json'] },
  ];
  for (const input of cases) {
    assert.equal(requiresSecurityReview(input), false, JSON.stringify(input));
  }
});

test('weak security hint becomes relevant when coupled to enforcement code context', () => {
  assert.equal(
    requiresSecurityReview({
      description: 'validate network access control request handling',
      files: ['src/gateway.ts'],
    }),
    true
  );
  assert.equal(
    requiresSecurityReview({
      description: 'permission docs refresh',
      files: ['src/gateway.ts'],
    }),
    false
  );
});

test('acceptance trace links criterion to plan implementation and verification evidence', () => {
  const trace = buildAcceptanceTrace({
    criteria: ['login succeeds', 'expired session redirects'],
    planTasks: [
      { id: 'auth', acceptance_criteria: ['login succeeds'] },
      { id: 'session', acceptance_criteria: ['expired session redirects'] },
    ],
    implementationEvidence: {
      'AC-001': { evidence: 'src/auth.js login()' },
      'AC-002': { evidence: 'src/session.js expiry branch' },
    },
    verificationEvidence: {
      'AC-001': { status: 'VERIFIED', evidence: 'auth test passed' },
      'AC-002': { status: 'VERIFIED', evidence: 'session expiry test passed' },
    },
  });

  assert.deepEqual(trace.map((item) => item.status), ['VERIFIED', 'VERIFIED']);
  assert.deepEqual(trace[0].planTasks, ['auth']);
  assert.equal(evaluateAcceptanceTrace(trace).pass, true);
});

test('missing plan coverage or verification evidence prevents PASS', () => {
  const trace = buildAcceptanceTrace({
    criteria: ['login succeeds', 'expired session redirects'],
    planTasks: [
      { id: 'auth', acceptance_criteria: ['login succeeds'] },
    ],
    implementationEvidence: {
      'AC-001': { evidence: 'src/auth.js' },
      'AC-002': { evidence: 'src/session.js' },
    },
    verificationEvidence: {
      'AC-001': { status: 'VERIFIED', evidence: 'auth test passed' },
    },
  });

  const result = evaluateAcceptanceTrace(trace);
  assert.equal(result.pass, false);
  assert.equal(trace[1].status, 'MISSING');
});

test('final verification requires fresh tests applicable quality checks goal alignment and all criteria VERIFIED', () => {
  const base = {
    criteria: ['login succeeds'],
    planTasks: [{ id: 'auth', acceptance_criteria: ['login succeeds'] }],
    implementationEvidence: { 'AC-001': { evidence: 'src/auth.js:10' } },
    verificationEvidence: { 'AC-001': { status: 'VERIFIED', evidence: 'auth.test.js PASS' } },
    freshTestOutput: true,
    buildApplicable: true,
    buildPassed: true,
    typecheckApplicable: true,
    typecheckPassed: true,
    lintApplicable: true,
    lintPassed: true,
    specGoalAligned: true,
  };

  assert.equal(evaluateVerificationReport(base).pass, true);

  assert.equal(
    evaluateVerificationReport({ ...base, freshTestOutput: false }).pass,
    false
  );
  assert.equal(
    evaluateVerificationReport({ ...base, verificationEvidence: {} }).pass,
    false
  );
  assert.equal(
    evaluateVerificationReport({ ...base, specGoalAligned: false }).pass,
    false
  );
});
