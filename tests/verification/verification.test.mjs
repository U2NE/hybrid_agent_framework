import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIndependentVerification,
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

test('security review activates for every configured trust-boundary trigger', () => {
  const cases = [
    { description: 'change auth session handling' },
    { description: 'change authentication flow' },
    { description: 'change authorization policy' },
    { description: 'replace crypto primitive' },
    { description: 'rotate secret storage' },
    { description: 'update payment webhook' },
    { description: 'add file upload endpoint' },
    { description: 'change SQL query builder' },
    { description: 'change network trust boundary' },
    { description: 'change permission checks' },
  ];

  for (const input of cases) {
    assert.equal(requiresSecurityReview(input), true, JSON.stringify(input));
  }

  assert.equal(requiresSecurityReview({ files: ['src/auth/login.ts'] }), true);
  assert.equal(requiresSecurityReview({ files: ['src/ui/button.ts'] }), false);
});
