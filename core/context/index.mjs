export function buildWorkerContext(task, options = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');

  const context = {
    goal: task.goal || '',
    relevantFiles: unique(task.relevantFiles || task.files_modified || []),
    relevantInterfaces: unique(task.relevantInterfaces || []),
    acceptanceCriteria: unique(task.acceptance_criteria || task.acceptanceCriteria || []),
    constraints: unique(task.constraints || options.constraints || []),
    dependencyOutputs: sanitizeDependencyOutputs(task.dependencyOutputs || options.dependencyOutputs || {}),
  };

  if (options.specPath) context.specPath = options.specPath;
  if (options.planPath) context.planPath = options.planPath;
  if (options.phasePath) context.phasePath = options.phasePath;

  return context;
}

export function renderWorkerContext(context) {
  return [
    '# Worker Context',
    '',
    '## Goal',
    context.goal || '(missing)',
    '',
    '## Relevant files',
    bullets(context.relevantFiles),
    '',
    '## Relevant interfaces',
    bullets(context.relevantInterfaces),
    '',
    '## Acceptance criteria',
    bullets(context.acceptanceCriteria),
    '',
    '## Constraints',
    bullets(context.constraints),
    '',
    '## Dependency outputs',
    renderDependencyOutputs(context.dependencyOutputs),
    '',
    context.specPath ? 'SPEC: ' + context.specPath : '',
    context.planPath ? 'PLAN: ' + context.planPath : '',
    context.phasePath ? 'Phase: ' + context.phasePath : '',
    '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

function sanitizeDependencyOutputs(outputs) {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return {};
  return Object.fromEntries(
    Object.entries(outputs)
      .filter(([key]) => key && key !== 'conversation' && key !== 'fullTranscript')
      .map(([key, value]) => [key, limitValue(value)])
  );
}

function limitValue(value) {
  if (typeof value === 'string') return value.slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 50).map(limitValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([k, v]) => [k, limitValue(v)]));
  }
  return value;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((x) => x.trim()).filter(Boolean))];
}

function bullets(values) {
  return values && values.length ? values.map((x) => '- ' + x).join('\n') : '- (none)';
}

function renderDependencyOutputs(outputs) {
  const entries = Object.entries(outputs || {});
  if (!entries.length) return '- (none)';
  return entries.map(([key, value]) => '- ' + key + ': ' + JSON.stringify(value)).join('\n');
}
