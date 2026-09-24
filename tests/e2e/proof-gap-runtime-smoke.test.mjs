import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightProofGapSmoke,
  validateProofGapSmokeReport,
} from '../../scripts/proof-gap-runtime-smoke.mjs';

test('Case H preflight starts from a real CLI proof gap without QE agent or browser', () => {
  const result = preflightProofGapSmoke();
  assert.equal(result.initialReason, 'PROOF_GAP');
  assert.equal(result.requiredKind, 'cli');
  assert.equal(result.qeAgentRequired, false);
  assert.equal(result.browserRequired, false);
});

test('Case H semantic validator rejects exit-zero style fake success without acquired proof', () => {
  const result = validateProofGapSmokeReport({
    firstGate: {
      pass: false,
      reason: 'PROOF_GAP',
      proofGaps: [{ requiredKind: 'cli' }],
    },
    firstVerifier: {
      output: { verdict: 'FAIL', reason: 'PROOF_GAP' },
      commandExecutionCount: 0,
      delegationObserved: false,
      endedAt: 1,
    },
    acquisition: {
      acquired: false,
      available: false,
      evidence: null,
    },
    secondGate: { pass: true, reason: null },
    secondVerifier: {
      output: { verdict: 'PASS' },
      delegationObserved: false,
      startedAt: 2,
    },
    qeAgentsSpawned: 0,
    browserUsed: false,
    directCli: { exitCode: 0, stdout: 'hello Alice' },
    finalGitStatus: [],
    runtimeError: null,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /actual proof acquisition/.test(error)));
  assert.ok(result.errors.some((error) => /CLI process evidence/.test(error)));
});
