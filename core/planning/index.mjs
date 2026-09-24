import { buildExecutionWaves } from '../scheduler/index.mjs';

const PLAN_OPEN = '<!-- hybrid-plan:v1';
const PLAN_CLOSE = '-->';

export class PlanError extends Error {
  constructor(message, code = 'INVALID_PLAN') {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new PlanError('plan must be an object');
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new PlanError('plan.tasks must be a non-empty array');
  }

  const normalized = plan.tasks.map((task, index) => normalizePlanTask(task, index));
  buildExecutionWaves(normalized);

  return {
    ...plan,
    tasks: normalized,
  };
}

export function compilePlan(plan) {
  const validated = validatePlan(plan);
  const waves = buildExecutionWaves(validated.tasks);
  return {
    plan: validated,
    waves,
    waveSummary: waves.map((wave, index) => ({
      wave: index + 1,
      tasks: wave.map((task) => task.id),
      files: [...new Set(wave.flatMap((task) => task.files_modified))].sort(),
    })),
  };
}

export function renderPlanDocument(plan) {
  const compiled = compilePlan(plan);
  const json = JSON.stringify(compiled.plan, null, 2);
  const lines = [
    '# PLAN',
    '',
    PLAN_OPEN,
    json,
    PLAN_CLOSE,
    '',
    '## Execution Waves',
    '',
  ];

  for (const wave of compiled.waveSummary) {
    lines.push('### Wave ' + wave.wave);
    lines.push('');
    for (const taskId of wave.tasks) lines.push('- ' + taskId);
    lines.push('');
  }

  lines.push('## Tasks', '');
  for (const task of compiled.plan.tasks) {
    lines.push('### ' + task.id, '');
    lines.push(task.goal, '');
    lines.push('- Owner: ' + task.owner);
    lines.push('- Depends on: ' + (task.depends_on.length ? task.depends_on.join(', ') : '(none)'));
    lines.push('- Files: ' + task.files_modified.join(', '));
    lines.push('- Verify: `' + task.verify.replace(/`/g, '\\`') + '`');
    lines.push('- Acceptance:');
    for (const criterion of task.acceptance_criteria) lines.push('  - ' + criterion);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function parsePlanDocument(text) {
  const source = String(text || '');
  const start = source.indexOf(PLAN_OPEN);
  if (start < 0) throw new PlanError('PLAN.md has no hybrid-plan marker', 'CORRUPT_PLAN');
  const payloadStart = start + PLAN_OPEN.length;
  const end = source.indexOf(PLAN_CLOSE, payloadStart);
  if (end < 0) throw new PlanError('PLAN.md plan block is unterminated', 'CORRUPT_PLAN');

  let parsed;
  try {
    parsed = JSON.parse(source.slice(payloadStart, end).trim());
  } catch (error) {
    throw new PlanError('PLAN.md contains invalid plan JSON: ' + error.message, 'CORRUPT_PLAN');
  }
  return validatePlan(parsed);
}

function normalizePlanTask(task, index) {
  if (!task || typeof task !== 'object') {
    throw new PlanError('task at index ' + index + ' must be an object');
  }

  const id = String(task.id || '').trim();
  if (!id) throw new PlanError('task at index ' + index + ' requires id');

  const goal = String(task.goal || '').trim();
  if (!goal) throw new PlanError('task ' + id + ' requires goal');

  const files = Array.isArray(task.files_modified)
    ? [...new Set(task.files_modified.map(String).map((x) => x.trim()).filter(Boolean))]
    : [];
  if (files.length === 0) throw new PlanError('task ' + id + ' requires exact files_modified');

  const acceptance = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria.map(String).map((x) => x.trim()).filter(Boolean)
    : [];
  if (acceptance.length === 0) throw new PlanError('task ' + id + ' requires acceptance_criteria');

  const verify = String(task.verify || '').trim();
  if (!verify) throw new PlanError('task ' + id + ' requires automated verify command');

  return {
    id,
    goal,
    files_modified: files,
    depends_on: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [],
    acceptance_criteria: acceptance,
    verify,
    owner: String(task.owner || 'implementer'),
    security_relevant: task.security_relevant === true,
  };
}


export function consensusPolicy(options = {}) {
  const tier = Number(options.tier ?? 2);
  const highRisk =
    options.highRisk === true ||
    options.deliberate === true ||
    tier >= 3;

  if (tier <= 1) {
    return { enabled: false, maxIterations: 0, deliberate: false };
  }

  return {
    enabled: options.enabled !== false,
    maxIterations: highRisk ? 5 : 3,
    deliberate: highRisk,
  };
}

export function createConsensusState(options = {}) {
  const policy = consensusPolicy(options);
  return {
    policy,
    iteration: 0,
    status: policy.enabled ? 'planning' : 'not-required',
    approved: false,
    executionApproved: false,
    history: [],
    bestPlan: options.plan || null,
    remainingObjections: [],
  };
}

export function recordConsensusReview(state, input = {}) {
  if (!state || typeof state !== 'object') throw new PlanError('consensus state is required');
  if (!state.policy?.enabled) {
    return { ...structuredClone(state), status: 'not-required' };
  }
  if (state.status === 'pending-user-approval' || state.status === 'consensus-not-reached') {
    throw new PlanError('consensus review is already terminal');
  }

  const auditorVerdict = normalizeReviewVerdict(input.auditor?.verdict || input.verdict);
  const architectVerdict = input.architect?.verdict
    ? normalizeReviewVerdict(input.architect.verdict)
    : null;
  const councilApproved =
    auditorVerdict === 'APPROVE' &&
    (architectVerdict == null || architectVerdict === 'APPROVE');
  const next = structuredClone(state);
  next.iteration += 1;
  next.bestPlan = input.plan || next.bestPlan;
  next.history.push({
    iteration: next.iteration,
    planRevision: input.planRevision || next.iteration,
    architect: normalizeReview(input.architect),
    auditor: normalizeReview(input.auditor || { verdict: auditorVerdict }),
  });

  const objections = [
    ...(input.architect?.objections || []),
    ...(input.architect?.findings || []),
    ...(input.auditor?.objections || []),
    ...(input.auditor?.findings || []),
  ].map(String).filter(Boolean);
  next.remainingObjections = [...new Set(objections)];

  if (councilApproved) {
    next.status = 'pending-user-approval';
    next.approved = true;
    next.executionApproved = false;
    next.remainingObjections = [];
    return next;
  }

  if (next.iteration >= next.policy.maxIterations) {
    next.status = 'consensus-not-reached';
    next.approved = false;
    next.executionApproved = false;
    return next;
  }

  next.status = 'revision-required';
  next.approved = false;
  next.executionApproved = false;
  return next;
}

export function approveConsensusExecution(state) {
  if (!state || state.status !== 'pending-user-approval' || state.approved !== true) {
    throw new PlanError('execution approval requires an approved consensus plan pending user approval');
  }
  return {
    ...structuredClone(state),
    status: 'execution-approved',
    executionApproved: true,
  };
}

export function validateDeliberation(plan, options = {}) {
  const deliberate = options.deliberate === true;
  const missing = [];

  if (!Array.isArray(plan?.principles) || plan.principles.length < 3) missing.push('principles');
  if (!Array.isArray(plan?.decisionDrivers) || plan.decisionDrivers.length < 1) missing.push('decisionDrivers');

  const optionsList = Array.isArray(plan?.viableOptions) ? plan.viableOptions : [];
  if (optionsList.length < 2 && !hasText(plan?.alternativeInvalidationRationale)) {
    missing.push('viableOptions');
  }

  if (deliberate) {
    if (!Array.isArray(plan?.preMortem) || plan.preMortem.length < 3) missing.push('preMortem');
    const strategy = plan?.testStrategy || {};
    for (const lane of ['unit', 'integration', 'e2e', 'observability']) {
      if (!hasText(strategy[lane]) && !(Array.isArray(strategy[lane]) && strategy[lane].length)) {
        missing.push('testStrategy.' + lane);
      }
    }
  }

  const adr = plan?.adr || {};
  for (const field of ['decision', 'drivers', 'alternatives', 'whyChosen', 'consequences', 'followUps']) {
    if (!hasValue(adr[field])) missing.push('adr.' + field);
  }

  return {
    deliberate,
    pass: missing.length === 0,
    missing,
  };
}

export function buildPlanAcceptanceCoverage(plan, acceptanceCriteria = []) {
  const criteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];

  const coverage = criteria.map((criterion, index) => {
    const taskIds = tasks
      .filter((task) =>
        (task.acceptance_criteria || task.acceptanceCriteria || [])
          .map(String)
          .some((value) => value.trim() === criterion)
      )
      .map((task) => task.id);

    return {
      id: 'AC-' + String(index + 1).padStart(3, '0'),
      criterion,
      taskIds,
      planned: taskIds.length > 0,
    };
  });

  return {
    pass: coverage.every((item) => item.planned),
    coverage,
    missing: coverage.filter((item) => !item.planned),
  };
}

function normalizeReviewVerdict(value) {
  const verdict = String(value || '').trim().toUpperCase();
  if (!['APPROVE', 'ITERATE', 'REJECT'].includes(verdict)) {
    throw new PlanError('review verdict must be APPROVE, ITERATE, or REJECT');
  }
  return verdict;
}

function normalizeReview(value = {}) {
  return {
    verdict: value.verdict ? String(value.verdict).toUpperCase() : null,
    findings: Array.isArray(value.findings) ? value.findings : [],
    objections: Array.isArray(value.objections) ? value.objections : [],
  };
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValue(value) {
  if (hasText(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  return value != null && typeof value === 'object' && Object.keys(value).length > 0;
}
