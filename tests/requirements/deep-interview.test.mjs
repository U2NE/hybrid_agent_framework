import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AMBIGUITY_THRESHOLD,
  ambiguityStalled,
  appendOntologySnapshot,
  buildTopologyConfirmationQuestion,
  computeOntologySnapshot,
  confirmInterviewTopology,
  createInterviewState,
  evaluateRequirements,
  interviewProgress,
  nextInterviewQuestion,
  ontologyNeedsStabilization,
  recordInterviewRound,
  resolveAmbiguityThreshold,
  selectChallengeMode,
} from '../../core/requirements/index.mjs';

function activeComponent(id, clarity) {
  return {
    id,
    name: id,
    description: id + ' outcome',
    status: 'active',
    clarity,
  };
}

function baseSpec(topology) {
  return {
    type: 'greenfield',
    goal: 'Build login',
    topology,
    acceptanceCriteria: ['User can log in with the approved flow'],
  };
}

test('default ambiguity threshold is OMC-compatible 0.20 and policy-overridable', () => {
  assert.equal(DEFAULT_AMBIGUITY_THRESHOLD, 0.20);
  assert.deepEqual(resolveAmbiguityThreshold(), { threshold: 0.20, source: 'default' });
  assert.equal(resolveAmbiguityThreshold({ userThreshold: 0.15 }).threshold, 0.15);
  assert.equal(resolveAmbiguityThreshold({ userThreshold: 0.15, projectThreshold: 0.12 }).threshold, 0.12);
});

test('ambiguity above threshold blocks requirements pass without dimension hard floors', () => {
  const result = evaluateRequirements(baseSpec([
    activeComponent('auth', { goal: 0.8, constraints: 0.7, criteria: 0.7 }),
  ]), { threshold: 0.20, requireTopology: true });

  assert.ok(result.ambiguity > 0.20);
  assert.equal(result.pass, false);
});

test('ambiguity at or below threshold plus required fields passes even with a lower individual dimension', () => {
  const result = evaluateRequirements(baseSpec([
    activeComponent('auth', { goal: 1.0, constraints: 0.65, criteria: 1.0 }),
  ]), { threshold: 0.20, requireTopology: true });

  assert.equal(result.ambiguity, 0.105);
  assert.equal(result.pass, true);
});

test('unconfirmed topology produces Round 0 before any ambiguity question', () => {
  const state = createInterviewState({ initialIdea: '알아서 로그인 기능 좋게 만들어줘' });
  const question = nextInterviewQuestion(state, {}, {
    topologyCandidates: [
      { id: 'auth-flow', name: 'Auth Flow', description: 'Login and session behavior' },
      { id: 'account-recovery', name: 'Account Recovery', description: 'Recovery behavior' },
    ],
  });

  assert.equal(question.kind, 'topology');
  assert.equal(question.round, 0);
  assert.equal(question.ambiguity, null);
  assert.match(question.question, /add|removed|merged|split|deferred/i);
});

test('topology confirmation locks once and next question targets weakest component × dimension', () => {
  const initial = createInterviewState({ initialIdea: 'login' });
  const locked = confirmInterviewTopology(initial, {
    components: [
      activeComponent('auth', { goal: 0.9, constraints: 0.8, criteria: 0.9 }),
      activeComponent('audit', { goal: 0.85, constraints: 0.35, criteria: 0.7 }),
    ],
  });

  const spec = baseSpec([
    activeComponent('auth', { goal: 0.9, constraints: 0.8, criteria: 0.9 }),
    activeComponent('audit', { goal: 0.85, constraints: 0.35, criteria: 0.7 }),
  ]);
  const question = nextInterviewQuestion(locked, spec);

  assert.equal(locked.topology.status, 'confirmed');
  assert.equal(question.componentId, 'audit');
  assert.equal(question.dimension, 'constraints');
  assert.throws(() => confirmInterviewTopology(locked, { components: spec.topology }), /already confirmed/);
});

test('clear sibling cannot mask an unclear component because overall ambiguity is max component ambiguity', () => {
  const result = evaluateRequirements(baseSpec([
    activeComponent('auth', { goal: 0.95, constraints: 0.95, criteria: 0.95 }),
    activeComponent('audit', { goal: 0.85, constraints: 0.30, criteria: 0.70 }),
  ]), { threshold: 0.20, requireTopology: true });

  const audit = result.components.find((component) => component.id === 'audit');
  assert.equal(result.ambiguity, audit.ambiguity);
  assert.equal(result.pass, false);
  assert.equal(result.weakest.componentId, 'audit');
  assert.equal(result.weakest.dimension, 'constraints');
});

test('recording an answer recomputes scores and ambiguity instead of reusing the prior result', () => {
  let state = confirmInterviewTopology(createInterviewState({ initialIdea: 'login' }), {
    components: [activeComponent('auth', {})],
  });

  const beforeSpec = baseSpec([activeComponent('auth', { goal: 0.5, constraints: 0.4, criteria: 0.5 })]);
  const question = nextInterviewQuestion(state, beforeSpec);
  assert.equal(question.dimension, 'constraints');

  const afterSpec = baseSpec([activeComponent('auth', { goal: 0.8, constraints: 0.85, criteria: 0.7 })]);
  const recorded = recordInterviewRound(state, {
    question,
    answer: 'Use the existing session boundary and no social login.',
    spec: afterSpec,
  });

  assert.notEqual(recorded.round.ambiguityAfter, recorded.round.ambiguityBefore);
  assert.equal(recorded.state.currentAmbiguity, recorded.evaluation.ambiguity);
  assert.deepEqual(recorded.state.currentScores.auth, recorded.evaluation.components[0].scores);
});

test('weakest target is recomputed every round and rotates across similarly weak siblings', () => {
  let state = confirmInterviewTopology(createInterviewState({ initialIdea: 'multi' }), {
    components: [activeComponent('a', {}), activeComponent('b', {})],
  });

  let spec = baseSpec([
    activeComponent('a', { goal: 0.4, constraints: 0.8, criteria: 0.8 }),
    activeComponent('b', { goal: 0.42, constraints: 0.8, criteria: 0.8 }),
  ]);

  const q1 = nextInterviewQuestion(state, spec);
  assert.equal(q1.componentId, 'a');

  spec = baseSpec([
    activeComponent('a', { goal: 0.9, constraints: 0.8, criteria: 0.8 }),
    activeComponent('b', { goal: 0.42, constraints: 0.8, criteria: 0.8 }),
  ]);
  state = recordInterviewRound(state, { question: q1, answer: 'A clarified', spec }).state;
  const q2 = nextInterviewQuestion(state, spec);

  assert.equal(q2.componentId, 'b');
  assert.equal(q2.dimension, 'goal');
});

test('brownfield repo facts trigger scout requirement; evidence converts the question into a decision', () => {
  let state = createInterviewState({ type: 'brownfield', initialIdea: 'extend login' });
  let action = nextInterviewQuestion(state, {});
  assert.equal(action.kind, 'scout-required');
  assert.equal(action.question, null);

  state.codebaseContext = { auth: 'src/auth uses passport + JWT middleware' };
  state = confirmInterviewTopology(state, {
    components: [{ id: 'auth', name: 'Auth', description: 'Authentication extension' }],
  });

  const spec = {
    type: 'brownfield',
    goal: 'Extend authentication',
    acceptanceCriteria: ['new auth path is testable'],
    topology: [activeComponent('auth', { goal: 0.9, constraints: 0.9, criteria: 0.9, context: 0.2 })],
  };
  action = nextInterviewQuestion(state, spec);

  assert.equal(action.dimension, 'context');
  assert.match(action.question, /src\/auth uses passport \+ JWT/);
  assert.match(action.question, /extend it or intentionally diverge/i);
});

test('challenge modes match pinned OMC thresholds and are one-shot', () => {
  const state = createInterviewState({ initialIdea: 'x' });
  state.topology.status = 'confirmed';

  state.roundCount = 3;
  assert.equal(selectChallengeMode(state, 0.5), 'contrarian');
  state.challengeModesUsed.push('contrarian');

  state.roundCount = 5;
  assert.equal(selectChallengeMode(state, 0.5), 'simplifier');
  state.challengeModesUsed.push('simplifier');

  state.roundCount = 7;
  assert.equal(selectChallengeMode(state, 0.31), 'ontologist');
  state.challengeModesUsed.push('ontologist');
  assert.equal(selectChallengeMode(state, 0.9), null);
});

test('three stalled ambiguity rounds activate Ontologist early and only once', () => {
  const state = createInterviewState({ initialIdea: 'x' });
  state.topology.status = 'confirmed';
  state.roundCount = 3;
  state.rounds = [
    { ambiguityAfter: 0.42 },
    { ambiguityAfter: 0.45 },
    { ambiguityAfter: 0.39 },
  ];

  assert.equal(ambiguityStalled(state.rounds), true);
  assert.equal(selectChallengeMode(state, 0.39), 'ontologist');
  state.challengeModesUsed.push('ontologist');
  assert.notEqual(selectChallengeMode(state, 0.39), 'ontologist');
});

test('early exit, hard cap, and pause never become normal clarification success', () => {
  const state = createInterviewState({ initialIdea: 'x' });
  state.topology.status = 'confirmed';
  state.roundCount = 3;
  const evaluation = evaluateRequirements(baseSpec([
    activeComponent('auth', { goal: 0.4, constraints: 0.4, criteria: 0.4 }),
  ]), { threshold: state.threshold, requireTopology: true });

  const early = interviewProgress(state, evaluation, 'build it');
  assert.equal(early.kind, 'early-exit');
  assert.equal(early.pass, false);
  assert.equal(early.normalCompletion, false);
  assert.ok(early.remaining.length);

  state.roundCount = 20;
  const capped = interviewProgress(state, evaluation);
  assert.equal(capped.kind, 'hard-cap');
  assert.equal(capped.pass, false);

  const paused = interviewProgress(state, evaluation, 'stop');
  assert.equal(paused.kind, 'paused');
  assert.equal(paused.pass, false);
});

test('normal completion occurs only after the ambiguity threshold and required fields pass', () => {
  const state = createInterviewState({ initialIdea: 'x' });
  state.topology.status = 'confirmed';
  const clear = evaluateRequirements(baseSpec([
    activeComponent('auth', { goal: 0.9, constraints: 0.9, criteria: 0.9 }),
  ]), { threshold: state.threshold, requireTopology: true });
  const result = interviewProgress(state, clear);

  assert.ok(clear.ambiguity <= state.threshold);
  assert.equal(result.kind, 'spec-ready');
  assert.equal(result.pass, true);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.status, 'clarity-passed-pending-approval');
});


test('ontology convergence matches pinned OMC stable changed new removed semantics', () => {
  const first = computeOntologySnapshot(null, [
    { name: 'User', type: 'core domain', fields: ['id', 'email'], relationships: ['User owns Project'] },
    { name: 'Project', type: 'core domain', fields: ['id', 'name', 'ownerId'], relationships: [] },
  ]);
  assert.equal(first.stabilityRatio, null);
  assert.deepEqual(first.newEntities, ['User', 'Project']);

  const second = computeOntologySnapshot(first.entities, [
    { name: 'User', type: 'core domain', fields: ['id', 'email'], relationships: ['User owns Workspace'] },
    { name: 'Workspace', type: 'core domain', fields: ['id', 'name', 'ownerId', 'slug'], relationships: [] },
    { name: 'Tag', type: 'supporting', fields: ['id', 'label'], relationships: [] },
  ]);

  assert.deepEqual(second.stableEntities, ['User']);
  assert.equal(second.changedEntities.length, 1);
  assert.equal(second.changedEntities[0].from, 'Project');
  assert.equal(second.changedEntities[0].to, 'Workspace');
  assert.deepEqual(second.newEntities, ['Tag']);
  assert.deepEqual(second.removedEntities, []);
  assert.equal(second.stabilityRatio, 0.666667);

  const third = computeOntologySnapshot(second.entities, second.entities);
  assert.equal(third.stabilityRatio, 1);
  assert.equal(third.stableEntities.length, 3);
  assert.deepEqual(third.newEntities, []);
  assert.deepEqual(third.changedEntities, []);
});

test('ontology convergence is opt-in by state instability and does not tax ordinary bounded flows', () => {
  let state = createInterviewState({ initialIdea: 'scope fuzzy task' });
  assert.equal(ontologyNeedsStabilization(state), false);

  ({ state } = appendOntologySnapshot(state, [
    { name: 'Task', type: 'core domain', fields: ['id', 'name'] },
  ]));
  assert.equal(ontologyNeedsStabilization(state), false);

  ({ state } = appendOntologySnapshot(state, [
    { name: 'Task', type: 'core domain', fields: ['id', 'name'] },
    { name: 'Workspace', type: 'core domain', fields: ['id', 'name'] },
  ]));
  assert.equal(ontologyNeedsStabilization(state), true);

  ({ state } = appendOntologySnapshot(state, [
    { name: 'Task', type: 'core domain', fields: ['id', 'name'] },
    { name: 'Workspace', type: 'core domain', fields: ['id', 'name'] },
  ]));
  assert.equal(ontologyNeedsStabilization(state), false);
});

test('unstable ontology changes question strategy without consuming Ontologist challenge mode', () => {
  let state = confirmInterviewTopology(createInterviewState({ initialIdea: 'design task model' }), {
    components: [{ id: 'core', name: 'Core', description: 'Core domain' }],
  });
  ({ state } = appendOntologySnapshot(state, [
    { name: 'Task', type: 'core domain', fields: ['id'] },
  ]));
  ({ state } = appendOntologySnapshot(state, [
    { name: 'Workspace', type: 'core domain', fields: ['id'] },
    { name: 'Project', type: 'core domain', fields: ['id'] },
  ]));

  const spec = {
    type: 'greenfield',
    goal: 'Design the task domain',
    acceptanceCriteria: ['domain is defined'],
    topology: [{
      id: 'core',
      name: 'Core',
      status: 'active',
      clarity: { goal: 0.4, constraints: 0.5, criteria: 0.5 },
    }],
  };

  const question = nextInterviewQuestion(state, spec);
  assert.equal(question.questionStrategy, 'ontology-stabilization');
  assert.match(question.question, /core thing/i);
  assert.equal(state.challengeModesUsed.includes('ontologist'), false);
});
