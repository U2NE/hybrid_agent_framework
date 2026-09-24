import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approveConsensusExecution,
  buildPlanAcceptanceCoverage,
  consensusPolicy,
  createConsensusState,
  recordConsensusReview,
  validateDeliberation,
} from '../../core/planning/index.mjs';

test('Tier 0/1 do not run consensus planning', () => {
  assert.deepEqual(consensusPolicy({ tier: 0 }), {
    enabled: false,
    maxIterations: 0,
    deliberate: false,
    requiredReviewers: [],
  });
  assert.equal(consensusPolicy({ tier: 1 }).enabled, false);
});

test('ordinary complex consensus is bounded at 3 and reject requires revision', () => {
  let state = createConsensusState({ tier: 2, enabled: true, plan: { revision: 1 } });
  assert.equal(state.policy.maxIterations, 3);

  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    architect: { objections: ['dependency boundary unclear'] },
    auditor: { verdict: 'REJECT', findings: ['missing rollback'] },
  });
  assert.equal(state.status, 'revision-required');
  assert.equal(state.approved, false);
  assert.equal(state.executionApproved, false);

  state = recordConsensusReview(state, {
    plan: { revision: 2 },
    architect: { objections: [] },
    auditor: { verdict: 'ITERATE', findings: ['verification still weak'] },
  });
  assert.equal(state.status, 'revision-required');

  state = recordConsensusReview(state, {
    plan: { revision: 3 },
    architect: { objections: ['tradeoff remains'] },
    auditor: { verdict: 'REJECT', findings: ['acceptance incomplete'] },
  });
  assert.equal(state.status, 'consensus-not-reached');
  assert.equal(state.approved, false);
  assert.equal(state.executionApproved, false);
  assert.deepEqual(state.bestPlan, { revision: 3 });
  assert.ok(state.remainingObjections.length > 0);
});

test('high-risk consensus is bounded at 5 and approval remains pending user approval', () => {
  let state = createConsensusState({ tier: 3, highRisk: true, plan: { revision: 1 } });
  assert.equal(state.policy.maxIterations, 5);
  assert.equal(state.policy.deliberate, true);

  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    planRevision: 1,
    architect: { verdict: 'APPROVE', revision: 1, objections: [] },
    auditor: { verdict: 'APPROVE', revision: 1 },
  });

  assert.equal(state.status, 'pending-user-approval');
  assert.equal(state.approved, true);
  assert.equal(state.executionApproved, false);

  const approved = approveConsensusExecution(state);
  assert.equal(approved.status, 'execution-approved');
  assert.equal(approved.executionApproved, true);
});

test('enabled council records Architect and Plan Auditor as required reviewers', () => {
  const state = createConsensusState({ tier: 2, enabled: true });
  assert.deepEqual(state.policy.requiredReviewers, ['architect', 'plan-auditor']);
});

test('council requires both Architect and Plan Auditor APPROVE', () => {
  let state = createConsensusState({ tier: 2, enabled: true });

  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    planRevision: 1,
    architect: { verdict: 'APPROVE', revision: 1 },
    auditor: { verdict: 'APPROVE', revision: 1 },
  });

  assert.equal(state.status, 'pending-user-approval');
  assert.equal(state.approved, true);
  assert.equal(state.executionApproved, false);
});

test('missing Architect cannot approve a council plan', () => {
  const state = createConsensusState({ tier: 2, enabled: true });

  assert.throws(
    () =>
      recordConsensusReview(state, {
        plan: { revision: 1 },
        planRevision: 1,
        auditor: { verdict: 'APPROVE', revision: 1 },
      }),
    /required consensus reviewer missing: architect/
  );
});

test('missing Plan Auditor cannot approve a council plan', () => {
  const state = createConsensusState({ tier: 2, enabled: true });

  assert.throws(
    () =>
      recordConsensusReview(state, {
        plan: { revision: 1 },
        planRevision: 1,
        architect: { verdict: 'APPROVE', revision: 1 },
      }),
    /required consensus reviewer missing: plan-auditor/
  );
});

test('review revision metadata must match the current plan revision when provided', () => {
  const state = createConsensusState({ tier: 2, enabled: true });

  assert.throws(
    () =>
      recordConsensusReview(state, {
        plan: { revision: 2 },
        planRevision: 2,
        architect: { verdict: 'APPROVE', revision: 1 },
        auditor: { verdict: 'APPROVE', revision: 2 },
      }),
    /architect review revision mismatch/
  );
});

test('explicit Plan Auditor-only consensus can approve without Architect', () => {
  let state = createConsensusState({
    tier: 2,
    enabled: true,
    requiredReviewers: ['plan-auditor'],
  });

  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    planRevision: 1,
    auditor: { verdict: 'APPROVE', revision: 1 },
  });

  assert.deepEqual(state.policy.requiredReviewers, ['plan-auditor']);
  assert.equal(state.status, 'pending-user-approval');
  assert.equal(state.approved, true);
});

test('architect ITERATE blocks approval when council review is active', () => {
  let state = createConsensusState({ tier: 2, enabled: true });

  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    planRevision: 1,
    architect: {
      verdict: 'ITERATE',
      revision: 1,
      findings: ['rollback isolation still incomplete'],
      objections: ['rollback verification mutates final state'],
    },
    auditor: {
      verdict: 'APPROVE',
      revision: 1,
      findings: [],
      objections: [],
    },
  });

  assert.equal(state.status, 'revision-required');
  assert.equal(state.approved, false);
  assert.equal(state.executionApproved, false);
  assert.ok(state.remainingObjections.some((item) => /rollback isolation/i.test(item)));
});

test('cannot mark rejected or capped consensus as execution approved', () => {
  let state = createConsensusState({ tier: 2, enabled: true });
  state = recordConsensusReview(state, {
    plan: { revision: 1 },
    auditor: { verdict: 'REJECT', findings: ['bad plan'] },
  });
  assert.throws(() => approveConsensusExecution(state), /requires an approved consensus plan/);
});

test('high-risk deliberation requires principles drivers options premortem test strategy and ADR', () => {
  const incomplete = validateDeliberation({
    principles: ['P1', 'P2', 'P3'],
    decisionDrivers: ['D1'],
    viableOptions: [{ name: 'A' }, { name: 'B' }],
    adr: {
      decision: 'A',
      drivers: ['D1'],
      alternatives: ['B'],
      whyChosen: 'because',
      consequences: ['cost'],
      followUps: ['measure'],
    },
  }, { deliberate: true });
  assert.equal(incomplete.pass, false);
  assert.ok(incomplete.missing.includes('preMortem'));
  assert.ok(incomplete.missing.includes('testStrategy.unit'));

  const complete = validateDeliberation({
    principles: ['P1', 'P2', 'P3'],
    decisionDrivers: ['D1', 'D2', 'D3'],
    viableOptions: [{ name: 'A' }, { name: 'B' }],
    preMortem: ['failure 1', 'failure 2', 'failure 3'],
    testStrategy: {
      unit: 'unit tests',
      integration: 'integration tests',
      e2e: 'e2e test',
      observability: 'metrics/logging',
    },
    adr: {
      decision: 'A',
      drivers: ['D1', 'D2'],
      alternatives: ['B'],
      whyChosen: 'best tradeoff',
      consequences: ['more setup'],
      followUps: ['review metrics'],
    },
  }, { deliberate: true });
  assert.equal(complete.pass, true);
  assert.deepEqual(complete.missing, []);
});

test('plan acceptance coverage fails when any SPEC criterion has no PLAN task', () => {
  const plan = {
    tasks: [
      { id: 'A', acceptance_criteria: ['login succeeds'] },
    ],
  };
  const result = buildPlanAcceptanceCoverage(plan, ['login succeeds', 'expired session redirects']);
  assert.equal(result.pass, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].criterion, 'expired session redirects');
});
