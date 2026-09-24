import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightRepairSmoke,
  validateRepairSmokeReport,
} from '../../scripts/repair-runtime-smoke.mjs';

test('Case G preflight keeps repair bounded and implementation-owned', () => {
  const result = preflightRepairSmoke();
  assert.equal(result.maxRepairCycles, 3);
  assert.equal(result.repairOwner, 'implementer');
  assert.equal(result.reviewerWriteAccess, false);
});

test('Case G semantic validator rejects exit-zero style fake success', () => {
  const result = validateRepairSmokeReport({
    initial: {
      snapshot: 'R1',
      test: { exitCode: 0 },
      defectReproduced: false,
    },
    qaCycles: [],
    repairRuns: [],
    verifierRuns: [{
      output: { verdict: 'PASS' },
      testCommandPassed: false,
      delegationObserved: false,
    }],
    convergence: { ok: true, repairCount: 0 },
    final: {
      snapshot: 'R1',
      test: { exitCode: 0 },
      behavior: { nullResult: null, validName: 'alice' },
      gitStatus: [],
    },
    runtimeError: null,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /initial defect/.test(error)));
  assert.ok(result.errors.some((error) => /initial independent QA/.test(error)));
  assert.ok(result.errors.some((error) => /repair count/.test(error)));
  assert.ok(result.errors.some((error) => /passing command evidence/.test(error)));
});
