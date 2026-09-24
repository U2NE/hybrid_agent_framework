import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCompletionGate,
  findProofGaps,
  normalizeEvidence,
  resolveEvidencePolicy,
} from '../../core/verification/index.mjs';
import {
  buildRepairPacket,
  findingFingerprint,
  runRepairConvergence,
  shouldTriggerRepair,
} from '../../core/repair/index.mjs';

function targetedReport() {
  return {
    criteria: ['parser returns normalized value'],
    planTasks: [
      {
        id: 'parser',
        acceptance_criteria: ['parser returns normalized value'],
      },
    ],
    implementationEvidence: {
      'AC-001': { evidence: 'src/parser.js normalize()' },
    },
    verificationEvidence: {
      'AC-001': {
        status: 'VERIFIED',
        evidence: 'node --test tests/parser.test.mjs PASS',
      },
    },
    freshTestOutput: true,
    buildApplicable: false,
    typecheckApplicable: false,
    lintApplicable: false,
    specGoalAligned: true,
  };
}

test('Tier 0 minimal completion needs only fresh successful lightweight evidence', () => {
  const pass = evaluateCompletionGate({
    tier: 0,
    report: {
      lightweightVerificationEvidence: {
        kind: 'lint',
        source: 'git diff --check',
        fresh: true,
        success: true,
      },
    },
  });
  assert.equal(pass.pass, true);
  assert.equal(pass.evidencePolicy.depth, 'minimal');

  const missing = evaluateCompletionGate({ tier: 0, report: {} });
  assert.equal(missing.pass, false);
  assert.equal(missing.reason, 'PROOF_GAP');
});

test('Tier 1 targeted evidence preserves acceptance trace and supports structured evidence', () => {
  const report = targetedReport();
  const result = evaluateCompletionGate({
    tier: 1,
    report,
    evidence: [
      {
        kind: 'test',
        source: 'node --test tests/parser.test.mjs',
        fresh: true,
        success: true,
        criterionId: 'AC-001',
      },
    ],
  });
  assert.equal(result.pass, true);
  assert.equal(result.evidencePolicy.depth, 'targeted');
});

test('Tier 2/3 completion requires independent evidence and implementer self-claim is insufficient', () => {
  const report = targetedReport();
  const failed = evaluateCompletionGate({
    tier: 2,
    report,
    evidence: [
      {
        kind: 'review',
        source: 'implementer says done',
        fresh: true,
        success: true,
        independent: false,
      },
    ],
  });
  assert.equal(failed.pass, false);
  assert.ok(failed.proofGaps.some((gap) => /independent verification/.test(gap.reason)));

  const passed = evaluateCompletionGate({
    tier: 2,
    report: { ...report, independentVerification: true },
  });
  assert.equal(passed.pass, true);
  assert.equal(passed.evidencePolicy.depth, 'full');
});

test('required runtime proof remains a proof gap until matching fresh evidence exists', () => {
  const report = targetedReport();
  const first = evaluateCompletionGate({
    tier: 1,
    report,
    requiredProofByCriterion: { 'AC-001': 'cli' },
    evidence: [],
  });
  assert.equal(first.pass, false);
  assert.equal(first.reason, 'PROOF_GAP');
  assert.deepEqual(first.proofGaps.map((gap) => gap.requiredKind), ['cli']);

  const second = evaluateCompletionGate({
    tier: 1,
    report,
    requiredProofByCriterion: { 'AC-001': 'cli' },
    evidence: [
      {
        kind: 'cli',
        source: 'node ./bin/example.mjs',
        fresh: true,
        success: true,
        exitCode: 0,
        criterionId: 'AC-001',
      },
    ],
  });
  assert.equal(second.pass, true);
});

test('evidence catalog rejects unbounded custom kinds', () => {
  assert.equal(normalizeEvidence({ kind: 'mystery', success: true }), null);
  const policy = resolveEvidencePolicy({ tier: 1, requiredKinds: ['cli', 'mystery'] });
  assert.deepEqual(policy.requiredKinds, ['cli']);
  assert.deepEqual(
    findProofGaps({ policy, evidence: [] }).map((gap) => gap.requiredKind),
    ['cli']
  );
});

test('blocking or acceptance-impacting findings trigger repair while style nits do not', () => {
  assert.equal(shouldTriggerRepair({ severity: 'high', category: 'correctness' }), true);
  assert.equal(
    shouldTriggerRepair({
      severity: 'medium',
      criterionId: 'AC-002',
      evidence: 'returns wrong value',
    }),
    true
  );
  assert.equal(
    shouldTriggerRepair({ severity: 'low', category: 'style', evidence: 'rename local variable' }),
    false
  );
});

test('finding fingerprint is deterministic across volatile numbers', () => {
  const a = findingFingerprint({
    category: 'null-handling',
    criterionId: 'AC-001',
    file: 'src/user.js',
    symbol: 'normalizeUser',
    evidence: 'TypeError at line 17 attempt 1',
  });
  const b = findingFingerprint({
    category: 'null-handling',
    criterionId: 'AC-001',
    file: 'src/user.js',
    symbol: 'normalizeUser',
    evidence: 'TypeError at line 42 attempt 9',
  });
  assert.equal(a, b);
});

test('repair packet is targeted and excludes unrelated conversation history', () => {
  const packet = buildRepairPacket(
    {
      severity: 'high',
      category: 'null-handling',
      criterionId: 'AC-001',
      criterion: 'normalizeUser(null) returns null',
      file: 'src/user.js',
      symbol: 'normalizeUser',
      evidence: 'null path throws',
      expectedBehavior: 'Return null for null input.',
      requiredVerification: 'node --test tests/user.test.mjs',
    },
    {
      goal: 'Normalize user input.',
      files_modified: ['src/user.js'],
      owner: 'implementer',
    },
    {
      dependencyOutputs: {
        prior: {
          summary: 'Only relevant implementation result',
          privateReasoning: 'must never be copied',
        },
      },
      excludeKeys: ['privateReasoning'],
    }
  );

  assert.equal(packet.owner, 'implementer');
  assert.deepEqual(packet.context.relevantFiles, ['src/user.js']);
  assert.ok(packet.context.acceptanceCriteria.includes('normalizeUser(null) returns null'));
  assert.equal(JSON.stringify(packet).includes('full conversation'), false);
  assert.equal(JSON.stringify(packet).includes('must never be copied'), false);
});

test('repair convergence redispatches implementation only for actual defects and rechecks afterward', async () => {
  let snapshot = 'R1';
  let repairs = 0;
  let reviews = 0;
  let verifies = 0;

  const result = await runRepairConvergence({
    snapshot,
    task: {
      goal: 'normalize user',
      files_modified: ['src/user.js'],
      acceptance_criteria: ['normalizeUser(null) returns null'],
      verify: 'node --test tests/user.test.mjs',
      owner: 'implementer',
    },
    reviewSnapshot: async ({ snapshot: current }) => {
      reviews += 1;
      if (current === 'R1') {
        return {
          ok: false,
          findings: [{
            severity: 'high',
            category: 'null-handling',
            criterionId: 'AC-001',
            criterion: 'normalizeUser(null) returns null',
            file: 'src/user.js',
            symbol: 'normalizeUser',
            evidence: 'null path throws TypeError',
            expectedBehavior: 'return null',
          }],
        };
      }
      return { ok: true, findings: [] };
    },
    verifySnapshot: async ({ snapshot: current }) => {
      verifies += 1;
      return { ok: current === 'R2', findings: [] };
    },
    repairImplementation: async ({ owner, packet, route }) => {
      repairs += 1;
      assert.equal(owner, 'implementer');
      assert.equal(packet.finding.criterionId, 'AC-001');
      assert.equal(route.modelTier, 'luna');
      snapshot = 'R2';
      return { changed: true, snapshot };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot, 'R2');
  assert.equal(repairs, 1);
  assert.equal(reviews, 2);
  assert.equal(verifies, 1);
  assert.equal(result.repairs.length, 1);
});

test('repair convergence stops after three failed repair cycles and uses existing routing escalation', async () => {
  const routes = [];
  const result = await runRepairConvergence({
    maxIterations: 3,
    snapshot: 'R1',
    task: {
      goal: 'fix persistent bug',
      files_modified: ['src/a.js'],
      acceptance_criteria: ['A works'],
      owner: 'implementer',
    },
    reviewSnapshot: async () => ({
      ok: false,
      findings: [{
        severity: 'high',
        category: 'persistent',
        criterionId: 'AC-001',
        criterion: 'A works',
        file: 'src/a.js',
        symbol: 'a',
        evidence: 'same failure 17',
      }],
    }),
    verifySnapshot: async () => ({ ok: false, findings: [] }),
    repairImplementation: async ({ attempt, route }) => {
      routes.push(route.routeLevel);
      return { changed: true, snapshot: 'R' + (attempt + 1) };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.repairs.length, 3);
  assert.deepEqual(routes.slice(0, 2), ['luna_high', 'luna_max']);
  assert.match(routes[2], /^sol_/);
});
