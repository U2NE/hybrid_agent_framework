import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCompletionGate,
  findProofGaps,
  resolveEvidencePolicy,
} from '../../core/verification/index.mjs';

const policy = resolveEvidencePolicy({ tier: 1, requiredKinds: ['cli'] });

function runtimeEvidence(snapshot) {
  return {
    kind: 'cli',
    source: 'node ./scripts/check-fixture.mjs',
    fresh: true,
    success: true,
    assessed: true,
    verified: true,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}

test('assessed runtime proof bound to the current snapshot closes its proof gap', () => {
  assert.deepEqual(findProofGaps({
    policy,
    evidence: [runtimeEvidence('snapshot-current')],
    snapshot: 'snapshot-current',
  }), []);
});

test('assessed runtime proof from a stale snapshot remains a proof gap', () => {
  const gaps = findProofGaps({
    policy,
    evidence: [runtimeEvidence('snapshot-old')],
    snapshot: 'snapshot-current',
  });

  assert.deepEqual(gaps.map((gap) => gap.requiredKind), ['cli']);
});

test('assessed runtime proof without a snapshot remains a proof gap when a current snapshot exists', () => {
  const gaps = findProofGaps({
    policy,
    evidence: [runtimeEvidence()],
    snapshot: 'snapshot-current',
  });

  assert.deepEqual(gaps.map((gap) => gap.requiredKind), ['cli']);
});

test('proof without a current snapshot preserves compatible snapshot-agnostic behavior', () => {
  assert.deepEqual(findProofGaps({
    policy,
    evidence: [runtimeEvidence('snapshot-old')],
    snapshot: null,
  }), []);
  assert.deepEqual(findProofGaps({
    policy,
    evidence: [runtimeEvidence()],
    snapshot: null,
  }), []);
});

test('criterion-bound runtime proof requires and accepts the current snapshot', () => {
  const input = {
    policy: resolveEvidencePolicy({ tier: 1 }),
    trace: [{ id: 'AC-001', criterion: 'fixture check passes' }],
    requiredProofByCriterion: { 'AC-001': 'cli' },
  };

  assert.deepEqual(findProofGaps({
    ...input,
    evidence: [{ ...runtimeEvidence('snapshot-current'), criterionId: 'AC-001' }],
    snapshot: 'snapshot-current',
  }), []);
  assert.deepEqual(findProofGaps({
    ...input,
    evidence: [{ ...runtimeEvidence('snapshot-old'), criterionId: 'AC-001' }],
    snapshot: 'snapshot-current',
  }).map((gap) => gap.requiredKind), ['cli']);
  assert.deepEqual(findProofGaps({
    ...input,
    evidence: [{ ...runtimeEvidence(), criterionId: 'AC-001' }],
    snapshot: 'snapshot-current',
  }).map((gap) => gap.requiredKind), ['cli']);
});

test('criterion-bound proof remains snapshot-agnostic without a current snapshot', () => {
  const input = {
    policy: resolveEvidencePolicy({ tier: 1 }),
    trace: [{ id: 'AC-001', criterion: 'fixture check passes' }],
    requiredProofByCriterion: { 'AC-001': 'cli' },
    snapshot: null,
  };

  assert.deepEqual(findProofGaps({
    ...input,
    evidence: [{ ...runtimeEvidence('snapshot-old'), criterionId: 'AC-001' }],
  }), []);
  assert.deepEqual(findProofGaps({
    ...input,
    evidence: [{ ...runtimeEvidence(), criterionId: 'AC-001' }],
  }), []);
});

test('Tier 0 lightweight completion remains independent of runtime snapshot binding', () => {
  const result = evaluateCompletionGate({
    tier: 0,
    snapshot: 'snapshot-current',
    evidence: [runtimeEvidence('snapshot-old')],
    report: {
      lightweightVerificationEvidence: {
        kind: 'test',
        source: 'node --test tests/fixture.test.mjs',
        fresh: true,
        success: true,
      },
    },
  });

  assert.equal(result.pass, true);
  assert.equal(result.evidencePolicy.depth, 'minimal');
});
