import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, TaskTier } from '../../core/classifier/index.mjs';
import { buildEdgeProbeChecklist, computeAmbiguity, evaluateRequirements, nextRequirementQuestion } from '../../core/requirements/index.mjs';

test('ambiguous task triggers interview tier', () => {
  const result = classifyTask({ request: '알아서 좋게 만들어줘', ambiguous: true });
  assert.equal(result.tier, TaskTier.AMBIGUOUS);
  assert.equal(result.requiresInterview, true);
});

test('clear trivial task bypasses interview without an explicit flag', () => {
  const result = classifyTask({ request: '오타 한 줄 수정' });
  assert.equal(result.tier, TaskTier.TRIVIAL);
  assert.equal(result.requiresInterview, false);
  assert.equal(result.requiresSpec, false);
});

test('topology is captured and acceptance criteria are required', () => {
  const result = evaluateRequirements({
    type: 'greenfield',
    goal: 'Build intake flow',
    topology: [{
      id: 'ingestion',
      status: 'active',
      clarity: { goal: 0.95, constraints: 0.95, criteria: 0.95 },
    }],
    acceptanceCriteria: [],
  }, { requireTopology: true });

  assert.equal(result.components[0].id, 'ingestion');
  assert.ok(result.missing.includes('acceptanceCriteria'));
  assert.equal(result.pass, false);
});

test('ambiguity formula matches greenfield weights', () => {
  const ambiguity = computeAmbiguity({ goal: 1, constraints: 1, criteria: 0.5 }, 'greenfield');
  assert.equal(ambiguity, 0.15);
});

test('requirements gate asks topology first and then targets the weakest dimension', () => {
  const topologyQuestion = nextRequirementQuestion({ topology: [] }, { requireTopology: true });
  assert.equal(topologyQuestion.dimension, 'topology');

  const weakQuestion = nextRequirementQuestion({
    goal: 'Build flow',
    acceptanceCriteria: ['works'],
    topology: [{
      id: 'api',
      status: 'active',
      clarity: { goal: 0.9, constraints: 0.2, criteria: 0.9 },
    }],
  });
  assert.equal(weakQuestion.componentId, 'api');
  assert.equal(weakQuestion.dimension, 'constraints');
});

test('edge probe checklist covers the required probe axes', () => {
  const checklist = buildEdgeProbeChecklist(['boundary', 'concurrency']);
  assert.ok(checklist.some((item) => item.axis === 'boundary' && item.covered));
  assert.ok(checklist.some((item) => item.axis === 'error behavior' && !item.covered));
});
