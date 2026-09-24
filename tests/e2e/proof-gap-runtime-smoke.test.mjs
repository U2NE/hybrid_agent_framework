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

function otherwisePassingProofReport(overrides = {}) {
  const evidence = {
    kind: 'cli',
    fresh: true,
    success: true,
    acquired: true,
    assessed: false,
    verified: false,
    evidenceId: 'proof-1',
    exitCode: 0,
    stdout: 'hello Alice',
  };
  const events = [
    { stage: 'verifier', lifecycle: 'end', phase: 'verification' },
    { stage: 'proof-acquisition', lifecycle: 'end' },
    { stage: 'verifier', lifecycle: 'start', phase: 'proof-reassessment' },
    { stage: 'completion', outcome: 'pass' },
  ];
  return {
    productionPrimitive: 'runQualityClosure',
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
    acquisition: { acquired: true, available: true, evidence },
    secondGate: { pass: true, reason: null },
    secondVerifier: {
      output: {
        verdict: 'PASS',
        reason: 'VERIFIED',
        consumedEvidenceIds: ['proof-1'],
      },
      delegationObserved: false,
      startedAt: 2,
    },
    assessedEvidence: {
      ...evidence,
      assessed: true,
      verified: true,
      verifier: 'verifier',
    },
    qualityClosure: {
      pass: true,
      completion: { pass: true },
      events,
    },
    qeAgentsSpawned: 0,
    browserUsed: false,
    directCli: { exitCode: 0, stdout: 'hello Alice' },
    finalGitStatus: [],
    runtimeError: null,
    ...overrides,
  };
}

test('Case H validator rejects completion PASS when second verifier is missing', () => {
  const report = otherwisePassingProofReport({ secondVerifier: null });
  const result = validateProofGapSmokeReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /second authenticated verifier is missing/.test(error)));
});

test('Case H validator rejects exit 0 proof with semantically wrong stdout', () => {
  const report = otherwisePassingProofReport({
    acquisition: {
      acquired: true,
      available: true,
      evidence: {
        ...otherwisePassingProofReport().acquisition.evidence,
        stdout: 'hello Bob',
      },
    },
  });
  const result = validateProofGapSmokeReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /semantically wrong/.test(error)));
});

test('Case H validator rejects verifier PASS that did not consume the acquired evidence id', () => {
  const report = otherwisePassingProofReport({
    secondVerifier: {
      output: {
        verdict: 'PASS',
        reason: 'VERIFIED',
        consumedEvidenceIds: ['other-proof'],
      },
      delegationObserved: false,
      startedAt: 2,
    },
  });
  const result = validateProofGapSmokeReport(report);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /exact acquired evidence id/.test(error)));
});
