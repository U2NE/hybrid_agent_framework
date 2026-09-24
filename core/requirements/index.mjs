export const DEFAULT_AMBIGUITY_THRESHOLD = 0.20;

export const DEEP_INTERVIEW_POLICY = Object.freeze({
  maxRounds: 20,
  softWarningRound: 10,
  minRoundsBeforeExit: 3,
  stallWindow: 3,
  stallTolerance: 0.05,
  ontologyAmbiguityThreshold: 0.30,
  componentRotationTolerance: 0.05,
});

export const EDGE_PROBE_AXES = Object.freeze([
  'boundary',
  'empty state',
  'ordering',
  'precision',
  'idempotency',
  'concurrency',
  'error behavior',
]);

const CHALLENGE_MODES = Object.freeze({
  contrarian: {
    minRound: 4,
    strategy: 'Challenge the core assumption: ask what changes if the opposite is true or an assumed constraint does not exist.',
  },
  simplifier: {
    minRound: 6,
    strategy: 'Probe removable complexity: ask for the simplest version that still provides value.',
  },
  ontologist: {
    minRound: 8,
    strategy: 'Reframe the ontology: ask what the thing fundamentally is and which concepts are core versus supporting.',
  },
});

export function computeAmbiguity(scores, type = 'greenfield') {
  const s = normalizeScores(scores, type);
  const weighted = type === 'brownfield'
    ? s.goal * 0.35 + s.constraints * 0.25 + s.criteria * 0.25 + s.context * 0.15
    : s.goal * 0.40 + s.constraints * 0.30 + s.criteria * 0.30;

  return roundScore(clamp(1 - weighted));
}

export function resolveAmbiguityThreshold(options = {}) {
  const project = validThreshold(options.projectThreshold);
  if (project !== null) {
    return { threshold: project, source: options.projectSource || 'project-policy' };
  }

  const user = validThreshold(options.userThreshold);
  if (user !== null) {
    return { threshold: user, source: options.userSource || 'user-policy' };
  }

  const fallback = validThreshold(options.defaultThreshold) ?? DEFAULT_AMBIGUITY_THRESHOLD;
  return { threshold: fallback, source: options.defaultSource || 'default' };
}

export function evaluateRequirements(spec, options = {}) {
  const type = options.type || spec.type || 'greenfield';
  const threshold = options.threshold ?? DEFAULT_AMBIGUITY_THRESHOLD;
  const topology = Array.isArray(spec.topology)
    ? spec.topology.filter((x) => x && x.status !== 'deferred')
    : [];
  const components = topology.length ? topology : [spec];

  const componentResults = components.map((component, index) => {
    const scores = component.clarity || component.clarity_scores || component.scores || {};
    return {
      id: component.id || 'component-' + (index + 1),
      scores: normalizeScores(scores, type),
      ambiguity: computeAmbiguity(scores, type),
    };
  });

  const ambiguity = componentResults.length
    ? Math.max(...componentResults.map((x) => x.ambiguity))
    : 1;

  const missing = [];
  if (!topology.length && options.requireTopology) missing.push('topology');
  if (!hasText(spec.goal) && !components.some((x) => hasText(x.goal))) missing.push('goal');
  if (!hasAcceptance(spec, components)) missing.push('acceptanceCriteria');

  const edgeProbeGate = options.requireEdgeProbes
    ? evaluateEdgeProbeGate(spec, {
        resolved: options.resolvedEdgeProbes || spec.resolvedEdgeProbes || [],
        request: options.request || spec.goal || '',
      })
    : { applicable: [], missing: [], pass: true };

  if (!edgeProbeGate.pass) missing.push('edgeProbes');

  return {
    type,
    threshold,
    ambiguity,
    pass: ambiguity <= threshold && missing.length === 0,
    missing,
    edgeProbeGate,
    components: componentResults,
    weakest: chooseWeakestComponentDimension(
      componentResults,
      options.lastTargetedComponentId,
      options.rotationTolerance
    ),
  };
}

export function chooseWeakestComponentDimension(
  componentResults,
  lastTargetedComponentId = null,
  rotationTolerance = DEEP_INTERVIEW_POLICY.componentRotationTolerance
) {
  const candidates = [];

  for (const component of componentResults) {
    for (const [dimension, score] of Object.entries(component.scores)) {
      if (dimension === 'context' && score === null) continue;
      candidates.push({ componentId: component.id, dimension, score });
    }
  }

  candidates.sort((a, b) =>
    a.score - b.score ||
    a.componentId.localeCompare(b.componentId) ||
    a.dimension.localeCompare(b.dimension)
  );

  if (!candidates.length) return null;
  const minimum = candidates[0].score;
  const nearWeakest = candidates.filter((candidate) => candidate.score <= minimum + rotationTolerance);

  if (lastTargetedComponentId && nearWeakest.length > 1) {
    const rotated = nearWeakest.find((candidate) => candidate.componentId !== lastTargetedComponentId);
    if (rotated) return rotated;
  }

  return candidates[0];
}

export function nextRequirementQuestion(spec, options = {}) {
  const requireTopology = options.requireTopology === true;
  const topology = Array.isArray(spec.topology) ? spec.topology.filter(Boolean) : [];

  if (requireTopology && topology.length === 0) {
    return {
      kind: 'topology',
      componentId: null,
      dimension: 'topology',
      question: 'What are the top-level components of this request, and is that topology correct?',
    };
  }

  const evaluation = evaluateRequirements(spec, {
    type: options.type || spec.type,
    threshold: options.threshold,
    requireTopology,
    lastTargetedComponentId: options.lastTargetedComponentId,
    rotationTolerance: options.rotationTolerance,
  });

  if (evaluation.missing.includes('acceptanceCriteria')) {
    return {
      kind: 'clarity',
      componentId: evaluation.weakest?.componentId || null,
      dimension: 'criteria',
      question: 'What observable outcomes must be true for this work to be accepted?',
    };
  }

  const weakest = evaluation.weakest;
  if (!weakest || evaluation.pass) return null;

  return {
    kind: 'clarity',
    componentId: weakest.componentId,
    dimension: weakest.dimension,
    score: weakest.score,
    question: questionForDimension(weakest.dimension),
  };
}

export function createInterviewState(input = {}) {
  const resolved = resolveAmbiguityThreshold({
    projectThreshold: input.projectThreshold,
    projectSource: input.projectThresholdSource,
    userThreshold: input.userThreshold,
    userSource: input.userThresholdSource,
    defaultThreshold: input.threshold,
    defaultSource: input.thresholdSource,
  });
  const type = input.type === 'brownfield' ? 'brownfield' : 'greenfield';
  const codebaseContext = input.codebaseContext || null;

  return {
    active: true,
    status: 'interview-active',
    type,
    initialIdea: String(input.initialIdea || ''),
    threshold: resolved.threshold,
    thresholdSource: resolved.source,
    rounds: [],
    roundCount: 0,
    currentAmbiguity: 1,
    currentScores: {},
    codebaseContext,
    topology: {
      status: 'pending',
      confirmedAt: null,
      components: [],
      deferrals: [],
      lastTargetedComponentId: null,
    },
    challengeModesUsed: [],
    ontologySnapshots: [],
    softWarningShown: false,
    exit: null,
    nextExpectedAction: type === 'brownfield' && !codebaseContext
      ? 'scout-repository'
      : 'round-0-topology',
  };
}

export function applyScoutEvidence(state, codebaseContext) {
  const next = clone(state);
  next.codebaseContext = codebaseContext || null;
  if (next.type === 'brownfield' && !next.codebaseContext) {
    next.nextExpectedAction = 'scout-repository';
  } else if (next.topology?.status !== 'confirmed') {
    next.nextExpectedAction = 'round-0-topology';
  }
  return next;
}

export function buildTopologyConfirmationQuestion(state, candidates = []) {
  if (state.topology?.status === 'confirmed') return null;
  const normalized = normalizeTopologyCandidates(candidates);
  const numbered = normalized
    .map((component, index) => (index + 1) + '. ' + component.name + ': ' + component.description)
    .join('\n');

  return {
    kind: 'topology',
    round: 0,
    ambiguity: null,
    candidates: normalized,
    question: [
      'Round 0 | Topology confirmation | Ambiguity: not scored yet',
      '',
      "I'm reading this as " + normalized.length + ' top-level component(s):',
      numbered,
      '',
      'Is that topology right? Should any component be added, removed, merged, split, or explicitly deferred?',
    ].join('\n'),
  };
}

export function confirmInterviewTopology(state, input = {}) {
  const next = clone(state);
  if (next.topology?.status === 'confirmed') {
    throw new Error('interview topology is already confirmed');
  }

  const components = normalizeTopologyCandidates(input.components || []);
  const deferredIds = new Set((input.deferredComponentIds || []).map(String));
  const confirmedAt = input.confirmedAt || new Date().toISOString();

  next.topology = {
    status: 'confirmed',
    confirmedAt,
    components: components.map((component) => ({
      ...component,
      status: deferredIds.has(component.id) || component.status === 'deferred' ? 'deferred' : 'active',
      evidence: Array.isArray(component.evidence) ? component.evidence : [],
      clarity_scores: normalizeNullableScores(component.clarity_scores || component.clarity || {}, next.type),
      weakest_dimension: null,
    })),
    deferrals: components
      .filter((component) => deferredIds.has(component.id) || component.status === 'deferred')
      .map((component) => ({
        component_id: component.id,
        reason: input.deferralReasons?.[component.id] || component.deferralReason || 'user-confirmed deferral',
        confirmed_at: confirmedAt,
      })),
    lastTargetedComponentId: null,
  };
  next.nextExpectedAction = 'score-and-question';
  return next;
}

export function nextInterviewQuestion(state, spec, options = {}) {
  if (!state?.active) return null;

  if (state.type === 'brownfield' && !state.codebaseContext && !options.scoutEvidence) {
    return {
      kind: 'scout-required',
      round: 0,
      question: null,
      reason: 'Brownfield repository facts must be gathered by Scout before asking the user.',
    };
  }

  if (state.topology?.status !== 'confirmed') {
    return buildTopologyConfirmationQuestion(state, options.topologyCandidates || []);
  }

  const evaluation = evaluateRequirements(spec, {
    type: state.type,
    threshold: state.threshold,
    requireTopology: true,
    lastTargetedComponentId: state.topology.lastTargetedComponentId,
    rotationTolerance: options.rotationTolerance,
  });

  const progress = interviewProgress(state, evaluation, options.userIntent);
  if (progress.kind !== 'continue') return progress;

  const weakest = evaluation.weakest;
  if (!weakest) return null;

  const ontologyStrategy = ontologyNeedsStabilization(state, options);
  const challengeMode = selectChallengeMode(state, evaluation.ambiguity);
  const evidence = scoutEvidenceFor(state, options.scoutEvidence, weakest.componentId);

  if (state.type === 'brownfield' && weakest.dimension === 'context' && !evidence) {
    return {
      kind: 'scout-required',
      round: state.roundCount + 1,
      componentId: weakest.componentId,
      dimension: weakest.dimension,
      ambiguityBefore: evaluation.ambiguity,
      question: null,
      reason: 'Repository context is the weakest dimension; gather repo evidence rather than asking the user for facts.',
    };
  }

  return {
    kind: 'clarity',
    round: state.roundCount + 1,
    componentId: weakest.componentId,
    dimension: weakest.dimension,
    score: weakest.score,
    ambiguityBefore: evaluation.ambiguity,
    why: ontologyStrategy
      ? 'The domain entities are still unstable, so stabilizing the core ontology has higher leverage than adding feature detail.'
      : weakest.componentId + ' × ' + weakest.dimension + ' is the lowest active clarity pair.',
    challengeMode,
    questionStrategy: ontologyStrategy ? 'ontology-stabilization' : 'weakest-dimension',
    question: ontologyStrategy
      ? buildOntologyStabilizationQuestion(state)
      : buildInterviewQuestion({
          componentId: weakest.componentId,
          dimension: weakest.dimension,
          challengeMode,
          evidence,
        }),
  };
}

export function recordInterviewRound(state, input = {}) {
  if (!input.question || input.question.kind !== 'clarity') {
    throw new Error('recordInterviewRound requires one clarity question');
  }

  const evaluation = evaluateRequirements(input.spec || {}, {
    type: state.type,
    threshold: state.threshold,
    requireTopology: true,
    lastTargetedComponentId: input.question.componentId,
  });

  const next = clone(state);
  const beforeScores = input.scoresBefore || state.currentScores || {};
  const afterScores = Object.fromEntries(
    evaluation.components.map((component) => [component.id, component.scores])
  );

  const round = {
    round: input.question.round,
    targetComponent: input.question.componentId,
    targetDimension: input.question.dimension,
    why: input.question.why || '',
    challengeMode: input.question.challengeMode || null,
    question: input.question.question,
    answer: String(input.answer || ''),
    scoresBefore: beforeScores,
    scoresAfter: afterScores,
    ambiguityBefore: input.question.ambiguityBefore ?? state.currentAmbiguity,
    ambiguityAfter: evaluation.ambiguity,
  };

  next.rounds = [...(next.rounds || []), round];
  next.roundCount = next.rounds.length;
  next.currentAmbiguity = evaluation.ambiguity;
  next.currentScores = afterScores;

  if (Array.isArray(input.ontologyEntities)) {
    const priorEntities = next.ontologySnapshots?.length
      ? next.ontologySnapshots[next.ontologySnapshots.length - 1].entities
      : null;
    const snapshot = computeOntologySnapshot(priorEntities, input.ontologyEntities);
    next.ontologySnapshots = [...(next.ontologySnapshots || []), snapshot];
    round.ontology = snapshot;
  }

  next.topology.lastTargetedComponentId = input.question.componentId;
  next.topology.components = next.topology.components.map((component) => {
    const result = evaluation.components.find((candidate) => candidate.id === component.id);
    if (!result || component.status === 'deferred') return component;
    return {
      ...component,
      clarity_scores: result.scores,
      weakest_dimension: weakestDimensionForScores(result.scores),
    };
  });

  if (input.question.challengeMode && !next.challengeModesUsed.includes(input.question.challengeMode)) {
    next.challengeModesUsed.push(input.question.challengeMode);
  }

  const progress = interviewProgress(next, evaluation, input.userIntent);
  next.status = progress.status || next.status;
  next.softWarningShown = next.softWarningShown || progress.kind === 'soft-warning';
  next.exit = progress.exit || next.exit;
  next.nextExpectedAction = nextExpectedActionFor(progress);

  return { state: next, evaluation, progress, round };
}

export function interviewProgress(state, evaluationOrSpec, userIntent = null) {
  const evaluation = isEvaluation(evaluationOrSpec)
    ? evaluationOrSpec
    : evaluateRequirements(evaluationOrSpec || {}, {
        type: state.type,
        threshold: state.threshold,
        requireTopology: true,
        lastTargetedComponentId: state.topology?.lastTargetedComponentId,
      });

  const intent = String(userIntent || '').trim().toLowerCase();
  const immediateStop = /^(stop|cancel|abort|중지|취소)$/.test(intent);
  if (immediateStop) {
    return {
      kind: 'paused',
      status: 'interview-paused',
      pass: false,
      specReady: false,
      approvalRequired: false,
      ambiguity: evaluation.ambiguity,
      remaining: remainingGaps(evaluation),
      exit: { type: 'pause', reason: intent },
    };
  }

  if (evaluation.pass) {
    return {
      kind: 'spec-ready',
      status: 'clarity-passed-pending-approval',
      pass: true,
      specReady: true,
      normalCompletion: true,
      approvalRequired: true,
      ambiguity: evaluation.ambiguity,
      remaining: [],
    };
  }

  const earlyIntent = /^(enough|let'?s go|build it|proceed|충분|진행|만들어)$/.test(intent);
  if (earlyIntent && state.roundCount >= DEEP_INTERVIEW_POLICY.minRoundsBeforeExit) {
    return {
      kind: 'early-exit',
      status: 'clarification-early-exit',
      pass: false,
      specReady: true,
      normalCompletion: false,
      approvalRequired: true,
      ambiguity: evaluation.ambiguity,
      remaining: remainingGaps(evaluation),
      riskWarning: 'Ambiguity remains above the configured threshold.',
      exit: { type: 'early-exit', reason: intent },
    };
  }

  if (state.roundCount >= DEEP_INTERVIEW_POLICY.maxRounds) {
    return {
      kind: 'hard-cap',
      status: 'clarification-hard-cap',
      pass: false,
      specReady: true,
      normalCompletion: false,
      approvalRequired: true,
      ambiguity: evaluation.ambiguity,
      remaining: remainingGaps(evaluation),
      riskWarning: 'Maximum interview rounds reached while ambiguity is still above threshold.',
      exit: { type: 'hard-cap', reason: 'max-rounds' },
    };
  }

  if (state.roundCount === DEEP_INTERVIEW_POLICY.softWarningRound && !state.softWarningShown) {
    return {
      kind: 'soft-warning',
      status: 'interview-active',
      pass: false,
      specReady: false,
      approvalRequired: false,
      ambiguity: evaluation.ambiguity,
      remaining: remainingGaps(evaluation),
      warning: 'Round 10 reached; continue interviewing or explicitly early-exit with current risk.',
    };
  }

  return {
    kind: 'continue',
    status: 'interview-active',
    pass: false,
    specReady: false,
    approvalRequired: false,
    ambiguity: evaluation.ambiguity,
    remaining: remainingGaps(evaluation),
  };
}

export function selectChallengeMode(state, ambiguity = state.currentAmbiguity) {
  const used = new Set(state.challengeModesUsed || []);
  const nextRound = (state.roundCount || 0) + 1;

  if (ambiguityStalled(state.rounds || []) && !used.has('ontologist')) {
    return 'ontologist';
  }

  if (nextRound >= CHALLENGE_MODES.contrarian.minRound && !used.has('contrarian')) {
    return 'contrarian';
  }

  if (nextRound >= CHALLENGE_MODES.simplifier.minRound && !used.has('simplifier')) {
    return 'simplifier';
  }

  if (
    nextRound >= CHALLENGE_MODES.ontologist.minRound &&
    ambiguity > DEEP_INTERVIEW_POLICY.ontologyAmbiguityThreshold &&
    !used.has('ontologist')
  ) {
    return 'ontologist';
  }

  return null;
}

export function ambiguityStalled(rounds = []) {
  if (rounds.length < DEEP_INTERVIEW_POLICY.stallWindow) return false;
  const window = rounds.slice(-DEEP_INTERVIEW_POLICY.stallWindow);
  const anchor = Number(window[0].ambiguityAfter);
  if (!Number.isFinite(anchor)) return false;
  return window.every((round) =>
    Number.isFinite(Number(round.ambiguityAfter)) &&
    Math.abs(Number(round.ambiguityAfter) - anchor) <= DEEP_INTERVIEW_POLICY.stallTolerance
  );
}

export function crystallizeInterviewSpec(state, spec, progress = null) {
  const evaluation = evaluateRequirements(spec, {
    type: state.type,
    threshold: state.threshold,
    requireTopology: true,
    lastTargetedComponentId: state.topology?.lastTargetedComponentId,
  });
  const finalProgress = progress || interviewProgress(state, evaluation);

  return {
    ...spec,
    topology: clone(state.topology?.components || spec.topology || []),
    clarification: {
      finalAmbiguity: evaluation.ambiguity,
      threshold: state.threshold,
      thresholdSource: state.thresholdSource,
      clarityScores: Object.fromEntries(
        evaluation.components.map((component) => [component.id, component.scores])
      ),
      roundCount: state.roundCount || 0,
      confirmedTopology: (state.topology?.components || []).map((component) => ({
        id: component.id,
        name: component.name,
        status: component.status,
      })),
      deferredComponents: clone(state.topology?.deferrals || []),
      completion: finalProgress.kind,
      pass: finalProgress.pass === true,
      approvalStatus: 'pending',
    },
  };
}

export function inferApplicableEdgeProbes(spec = {}, options = {}) {
  const text = [
    options.request || '',
    spec.goal || '',
    ...(spec.acceptanceCriteria || []),
    ...(spec.constraints || []),
    ...(spec.edgeCases || []),
  ].join(' ').toLowerCase();

  const applicable = new Set();

  // Error behavior is relevant to nearly every non-trivial behavior contract.
  if (text.trim()) applicable.add('error behavior');

  if (/empty|null|undefined|missing|없음|빈\s*(?:값|상태|목록)/i.test(text)) {
    applicable.add('empty state');
  }
  if (/sort|order|rank|queue|sequence|priority|정렬|순서|우선순위/i.test(text)) {
    applicable.add('ordering');
  }
  if (/float|decimal|round|precision|money|currency|percent|ratio|numeric|숫자|정밀|반올림|금액/i.test(text)) {
    applicable.add('precision');
  }
  if (/retry|repeat|duplicate|idempot|request id|dedup|재시도|중복/i.test(text)) {
    applicable.add('idempotency');
  }
  if (/concurr|parallel|race|lock|transaction|atomic|simultaneous|동시|병렬|경쟁/i.test(text)) {
    applicable.add('concurrency');
  }
  if (/limit|boundary|range|minimum|maximum|min|max|offset|index|page|size|length|경계|최대|최소|범위/i.test(text)) {
    applicable.add('boundary');
  }

  for (const explicit of spec.applicableEdgeProbes || []) {
    const axis = String(explicit).toLowerCase();
    if (EDGE_PROBE_AXES.includes(axis)) applicable.add(axis);
  }

  return EDGE_PROBE_AXES.filter((axis) => applicable.has(axis));
}

export function evaluateEdgeProbeGate(spec = {}, options = {}) {
  const applicable = inferApplicableEdgeProbes(spec, options);
  const resolved = new Set(
    (Array.isArray(options.resolved) ? options.resolved : [])
      .map(String)
      .map((value) => value.toLowerCase())
  );
  const missing = applicable.filter((axis) => !resolved.has(axis));

  return {
    applicable,
    resolved: applicable.filter((axis) => resolved.has(axis)),
    missing,
    pass: missing.length === 0,
  };
}

export function buildEdgeProbeChecklist(resolved = [], applicable = EDGE_PROBE_AXES) {
  const covered = new Set((Array.isArray(resolved) ? resolved : []).map(String).map((x) => x.toLowerCase()));
  const active = new Set((Array.isArray(applicable) ? applicable : EDGE_PROBE_AXES).map(String).map((x) => x.toLowerCase()));
  return EDGE_PROBE_AXES.map((axis) => ({
    axis,
    applicable: active.has(axis),
    covered: covered.has(axis),
  }));
}

export function buildSpecSkeleton(input = {}) {
  return {
    goal: input.goal || '',
    topology: input.topology || [],
    constraints: input.constraints || [],
    nonGoals: input.nonGoals || [],
    acceptanceCriteria: input.acceptanceCriteria || [],
    resolvedAssumptions: input.resolvedAssumptions || [],
    technicalContext: input.technicalContext || [],
    relevantCode: input.relevantCode || [],
    edgeCases: input.edgeCases || [],
    clarification: input.clarification || null,
  };
}

function buildOntologyStabilizationQuestion(state) {
  const latest = state.ontologySnapshots?.[state.ontologySnapshots.length - 1];
  const names = latest?.entities?.map((entity) => entity.name).filter(Boolean) || [];
  const summary = names.length ? names.join(', ') : 'the concepts named so far';
  return 'The domain model is still shifting (' + summary + '). What is the core thing here, and which named concepts are supporting entities, views, or containers?';
}

function buildInterviewQuestion({ componentId, dimension, challengeMode, evidence }) {
  if (challengeMode === 'contrarian') {
    return 'For ' + componentId + ', what would change if the opposite of the current ' + dimension + ' assumption were true?';
  }
  if (challengeMode === 'simplifier') {
    return 'For ' + componentId + ', what is the simplest version that still satisfies the essential ' + dimension + ' requirement?';
  }
  if (challengeMode === 'ontologist') {
    return 'For ' + componentId + ', what is this fundamentally, and which surrounding concepts are core versus supporting?';
  }

  if (dimension === 'context' && evidence) {
    return 'Repository evidence: ' + evidence + '. Given that existing structure, should ' + componentId + ' extend it or intentionally diverge from it?';
  }

  return questionForDimension(dimension, componentId);
}

function questionForDimension(dimension, componentId = 'this component') {
  const templates = {
    goal: 'What exact outcome should ' + componentId + ' produce?',
    constraints: 'What constraints or hard limits must ' + componentId + ' obey?',
    criteria: 'What observable outcomes prove ' + componentId + ' is complete?',
    context: 'Given the discovered repository context, what integration decision should ' + componentId + ' follow?',
  };
  return templates[dimension] || 'What is still unclear about ' + componentId + '?';
}

function normalizeScores(scores, type) {
  return {
    goal: clampNumber(scores.goal),
    constraints: clampNumber(scores.constraints),
    criteria: clampNumber(scores.criteria ?? scores.acceptanceCriteria),
    context: type === 'brownfield' ? clampNumber(scores.context) : null,
  };
}

function normalizeNullableScores(scores, type) {
  return {
    goal: nullableScore(scores.goal),
    constraints: nullableScore(scores.constraints),
    criteria: nullableScore(scores.criteria ?? scores.acceptanceCriteria),
    context: type === 'brownfield' ? nullableScore(scores.context) : null,
  };
}

function normalizeTopologyCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length < 1) throw new Error('Round 0 requires at least one topology component');
  if (list.length > 6) {
    throw new Error('Round 0 supports 1-6 top-level components; group sibling outcomes before confirmation');
  }

  return list.map((component, index) => ({
    id: String(component.id || slugify(component.name) || 'component-' + (index + 1)),
    name: String(component.name || component.id || 'Component ' + (index + 1)),
    description: String(component.description || 'Top-level outcome'),
    status: component.status === 'deferred' ? 'deferred' : 'active',
    evidence: Array.isArray(component.evidence) ? component.evidence : [],
    clarity_scores: component.clarity_scores || component.clarity || {},
    deferralReason: component.deferralReason || null,
  }));
}

function scoutEvidenceFor(state, optionEvidence, componentId) {
  if (typeof optionEvidence === 'string' && optionEvidence.trim()) return optionEvidence.trim();
  if (optionEvidence && typeof optionEvidence === 'object') {
    const value = optionEvidence[componentId] ?? optionEvidence.default;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const context = state.codebaseContext;
  if (typeof context === 'string' && context.trim()) return context.trim();
  if (context && typeof context === 'object') {
    const value = context[componentId] ?? context.default;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function weakestDimensionForScores(scores) {
  return Object.entries(scores)
    .filter(([, score]) => score !== null)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

function remainingGaps(evaluation) {
  const gaps = [];
  if (evaluation.missing?.length) gaps.push(...evaluation.missing.map((field) => 'missing:' + field));
  for (const component of evaluation.components || []) {
    if (component.ambiguity > evaluation.threshold) {
      const weakest = weakestDimensionForScores(component.scores);
      gaps.push(component.id + ':' + weakest);
    }
  }
  return [...new Set(gaps)];
}

function nextExpectedActionFor(progress) {
  if (progress.kind === 'spec-ready') return 'crystallize-spec-and-request-approval';
  if (progress.kind === 'early-exit' || progress.kind === 'hard-cap') {
    return 'crystallize-warning-spec-and-request-approval';
  }
  if (progress.kind === 'paused') return 'resume-interview';
  if (progress.kind === 'soft-warning') return 'ask-continue-or-early-exit';
  return 'ask-next-question';
}

function isEvaluation(value) {
  return value && typeof value === 'object' && Array.isArray(value.components) && 'ambiguity' in value;
}

function validThreshold(value) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) return null;
  return value;
}

function nullableScore(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return clampNumber(value);
}

function clampNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return clamp(value);
}

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function roundScore(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAcceptance(spec, components) {
  if (Array.isArray(spec.acceptanceCriteria) && spec.acceptanceCriteria.some(hasText)) return true;
  return components.some((c) => Array.isArray(c.acceptanceCriteria) && c.acceptanceCriteria.some(hasText));
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}


export function computeOntologySnapshot(previousEntities = null, currentEntities = []) {
  const current = normalizeEntities(currentEntities);
  const previous = Array.isArray(previousEntities) ? normalizeEntities(previousEntities) : null;

  if (!previous || current.length === 0) {
    return {
      entities: current,
      stableEntities: [],
      changedEntities: [],
      newEntities: current.map((entity) => entity.name),
      removedEntities: previous ? previous.map((entity) => entity.name) : [],
      stabilityRatio: null,
      matchingReasoning: previous
        ? 'No current entities; stability is N/A.'
        : 'First ontology round; all entities are new and stability is N/A.',
    };
  }

  const usedPrevious = new Set();
  const stableEntities = [];
  const changedEntities = [];
  const newEntities = [];
  const reasoning = [];

  for (const entity of current) {
    const exactIndex = previous.findIndex((candidate, index) =>
      !usedPrevious.has(index) &&
      candidate.name.toLowerCase() === entity.name.toLowerCase()
    );

    if (exactIndex >= 0) {
      usedPrevious.add(exactIndex);
      stableEntities.push(entity.name);
      reasoning.push(entity.name + ' matched previous entity by name');
      continue;
    }

    let best = null;
    for (let index = 0; index < previous.length; index++) {
      if (usedPrevious.has(index)) continue;
      const candidate = previous[index];
      if (candidate.type.toLowerCase() !== entity.type.toLowerCase()) continue;
      const overlap = fieldOverlap(candidate.fields, entity.fields);
      if (overlap > 0.5 && (!best || overlap > best.overlap)) {
        best = { index, candidate, overlap };
      }
    }

    if (best) {
      usedPrevious.add(best.index);
      changedEntities.push({
        from: best.candidate.name,
        to: entity.name,
        fieldOverlap: roundScore(best.overlap),
      });
      reasoning.push(
        best.candidate.name + ' -> ' + entity.name +
        ' matched as renamed (' + Math.round(best.overlap * 100) + '% field overlap)'
      );
      continue;
    }

    newEntities.push(entity.name);
    reasoning.push(entity.name + ' is new');
  }

  const removedEntities = previous
    .filter((_, index) => !usedPrevious.has(index))
    .map((entity) => entity.name);

  for (const name of removedEntities) reasoning.push(name + ' was removed');

  return {
    entities: current,
    stableEntities,
    changedEntities,
    newEntities,
    removedEntities,
    stabilityRatio: current.length
      ? roundScore((stableEntities.length + changedEntities.length) / current.length)
      : null,
    matchingReasoning: reasoning.join('; '),
  };
}

export function appendOntologySnapshot(state, entities) {
  const next = clone(state);
  const prior = next.ontologySnapshots?.length
    ? next.ontologySnapshots[next.ontologySnapshots.length - 1].entities
    : null;
  const snapshot = computeOntologySnapshot(prior, entities);
  next.ontologySnapshots = [...(next.ontologySnapshots || []), snapshot];
  return { state: next, snapshot };
}

export function ontologyNeedsStabilization(state, options = {}) {
  if (options.scopeFuzzy === true) return true;
  const snapshots = state?.ontologySnapshots || [];
  if (!snapshots.length) return false;
  const latest = snapshots[snapshots.length - 1];
  if (latest.stabilityRatio === null) return false;
  const threshold = Number(options.stabilityThreshold ?? 0.75);
  return latest.stabilityRatio < threshold ||
    latest.newEntities.length > 0 ||
    latest.changedEntities.length > 0;
}

function normalizeEntities(entities) {
  return (Array.isArray(entities) ? entities : [])
    .filter(Boolean)
    .map((entity) => ({
      name: String(entity.name || '').trim(),
      type: String(entity.type || '').trim(),
      fields: uniqueStrings(entity.fields),
      relationships: uniqueStrings(entity.relationships),
    }))
    .filter((entity) => entity.name);
}

function fieldOverlap(a, b) {
  const left = new Set(uniqueStrings(a).map((value) => value.toLowerCase()));
  const right = new Set(uniqueStrings(b).map((value) => value.toLowerCase()));
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / Math.max(left.size, right.size, 1);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((value) => value.trim()).filter(Boolean))];
}
