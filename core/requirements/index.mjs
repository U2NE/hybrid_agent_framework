export const DEFAULT_AMBIGUITY_THRESHOLD = 0.20;

export const EDGE_PROBE_AXES = Object.freeze([
  'boundary',
  'empty state',
  'ordering',
  'precision',
  'idempotency',
  'concurrency',
  'error behavior',
]);

export function computeAmbiguity(scores, type = 'greenfield') {
  const s = normalizeScores(scores, type);
  const weighted = type === 'brownfield'
    ? s.goal * 0.35 + s.constraints * 0.25 + s.criteria * 0.25 + s.context * 0.15
    : s.goal * 0.40 + s.constraints * 0.30 + s.criteria * 0.30;

  return roundScore(clamp(1 - weighted));
}

export function evaluateRequirements(spec, options = {}) {
  const type = options.type || spec.type || 'greenfield';
  const threshold = options.threshold ?? DEFAULT_AMBIGUITY_THRESHOLD;
  const topology = Array.isArray(spec.topology) ? spec.topology.filter((x) => x && x.status !== 'deferred') : [];
  const components = topology.length ? topology : [spec];

  const componentResults = components.map((component, index) => {
    const scores = component.clarity || component.scores || {};
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

  return {
    type,
    threshold,
    ambiguity,
    pass: ambiguity <= threshold && missing.length === 0,
    missing,
    components: componentResults,
    weakest: chooseWeakestComponentDimension(componentResults, options.lastTargetedComponentId),
  };
}

export function chooseWeakestComponentDimension(componentResults, lastTargetedComponentId = null) {
  const candidates = [];

  for (const component of componentResults) {
    for (const [dimension, score] of Object.entries(component.scores)) {
      if (dimension === 'context' && score === null) continue;
      candidates.push({ componentId: component.id, dimension, score });
    }
  }

  candidates.sort((a, b) =>
    a.score - b.score ||
    Number(a.componentId === lastTargetedComponentId) - Number(b.componentId === lastTargetedComponentId) ||
    a.componentId.localeCompare(b.componentId) ||
    a.dimension.localeCompare(b.dimension)
  );

  return candidates[0] || null;
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

  const templates = {
    goal: 'What exact outcome should this component produce?',
    constraints: 'What constraints or hard limits must this component obey?',
    criteria: 'What observable outcomes prove this component is complete?',
    context: 'What repository or environment context is still missing for this component?',
  };

  return {
    kind: 'clarity',
    componentId: weakest.componentId,
    dimension: weakest.dimension,
    score: weakest.score,
    question: templates[weakest.dimension] || 'What is still unclear about this component?',
  };
}

export function buildEdgeProbeChecklist(resolved = []) {
  const covered = new Set((Array.isArray(resolved) ? resolved : []).map(String).map((x) => x.toLowerCase()));
  return EDGE_PROBE_AXES.map((axis) => ({
    axis,
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
  };
}

function normalizeScores(scores, type) {
  const normalized = {
    goal: clampNumber(scores.goal),
    constraints: clampNumber(scores.constraints),
    criteria: clampNumber(scores.criteria ?? scores.acceptanceCriteria),
    context: type === 'brownfield' ? clampNumber(scores.context) : null,
  };
  return normalized;
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
