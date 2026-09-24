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
