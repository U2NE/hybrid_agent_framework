export class SchedulerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

export function buildExecutionWaves(tasks) {
  validateTasks(tasks);

  const byId = new Map(tasks.map((task) => [task.id, normalizeTask(task)]));
  const completed = new Set();
  const scheduled = new Set();
  const waves = [];

  while (scheduled.size < byId.size) {
    const ready = [...byId.values()]
      .filter((task) =>
        !scheduled.has(task.id) &&
        task.depends_on.every((dep) => completed.has(dep))
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    if (!ready.length) {
      const remaining = [...byId.keys()].filter((id) => !scheduled.has(id));
      throw new SchedulerError('dependency cycle or unsatisfied dependency among: ' + remaining.join(', '), 'CYCLE');
    }

    const wave = [];
    const writtenFiles = new Set();

    for (const task of ready) {
      const conflict = task.files_modified.some((file) => writtenFiles.has(file));
      if (conflict) continue;

      wave.push(task);
      for (const file of task.files_modified) writtenFiles.add(file);
    }

    if (!wave.length) {
      throw new SchedulerError('unable to make scheduling progress', 'NO_PROGRESS');
    }

    waves.push(wave);
    for (const task of wave) {
      scheduled.add(task.id);
      completed.add(task.id);
    }
  }

  return waves;
}

export function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new SchedulerError('tasks must be an array', 'INVALID');
  const ids = new Set();

  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id.trim()) {
      throw new SchedulerError('every task requires a non-empty id', 'INVALID');
    }
    if (ids.has(task.id)) throw new SchedulerError('duplicate task id: ' + task.id, 'DUPLICATE_ID');
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dep of task.depends_on || []) {
      if (!ids.has(dep)) throw new SchedulerError('unknown dependency ' + dep + ' for ' + task.id, 'UNKNOWN_DEP');
      if (dep === task.id) throw new SchedulerError('task cannot depend on itself: ' + task.id, 'CYCLE');
    }
  }

  return true;
}

export function findFileConflicts(tasks) {
  const owners = new Map();
  const conflicts = [];

  for (const task of tasks.map(normalizeTask)) {
    for (const file of task.files_modified) {
      const prior = owners.get(file);
      if (prior) conflicts.push({ file, tasks: [prior, task.id] });
      else owners.set(file, task.id);
    }
  }

  return conflicts;
}

function normalizeTask(task) {
  return {
    ...task,
    depends_on: [...new Set(task.depends_on || [])],
    files_modified: [...new Set(task.files_modified || [])],
    acceptance_criteria: task.acceptance_criteria || [],
    verify: task.verify || null,
    owner: task.owner || 'implementer',
  };
}


export function planExecutionIsolation(waves, options = {}) {
  if (!Array.isArray(waves)) throw new SchedulerError('waves must be an array', 'INVALID');
  const worktreeAvailable = options.worktreeAvailable !== false;
  const plannedWaves = [];
  const isolation = [];

  for (const wave of waves) {
    const assessment = assessWaveIsolation(wave, {
      ...options,
      worktreeAvailable,
    });

    if (assessment.mode === 'safe-serialization') {
      for (const task of wave) {
        plannedWaves.push([task]);
        isolation.push({
          wave: plannedWaves.length,
          taskIds: [task.id],
          mode: 'current-workspace',
          reason: 'worktree-unavailable-safe-serialization',
        });
      }
      continue;
    }

    plannedWaves.push(wave);
    isolation.push({
      wave: plannedWaves.length,
      taskIds: wave.map((task) => task.id),
      mode: assessment.mode,
      reason: assessment.reason,
    });
  }

  return {
    waves: plannedWaves,
    isolation,
    worktreeAvailable,
  };
}

export function assessWaveIsolation(wave, options = {}) {
  const tasks = Array.isArray(wave) ? wave.map(normalizeTask) : [];
  if (tasks.length <= 1) {
    return { mode: 'current-workspace', reason: 'single-writer' };
  }

  const riskReasons = isolationRiskReasons(tasks, options);

  if (!riskReasons.length) {
    return {
      mode: 'current-workspace',
      reason: 'parallel-writers-have-precise-independent-ownership',
    };
  }

  if (options.worktreeAvailable === false) {
    return {
      mode: 'safe-serialization',
      reason: 'worktree-required-but-unavailable:' + riskReasons.join(','),
      risks: riskReasons,
    };
  }

  return {
    mode: 'worktree',
    reason: 'parallel-writer-isolation:' + riskReasons.join(','),
    risks: riskReasons,
  };
}

export function isolationRiskReasons(tasks, options = {}) {
  const reasons = new Set();
  const normalized = (Array.isArray(tasks) ? tasks : []).map(normalizeTask);

  if (options.forceWorktree === true) reasons.add('explicit');
  if (options.fileOwnershipConfidence === 'low') reasons.add('low-file-ownership-confidence');

  for (const task of normalized) {
    if (task.generated_files === true || task.generatedFiles === true) reasons.add('generated-files');
    if (task.codegen === true) reasons.add('codegen');
    if (task.formatter === true || task.formatter_wide === true) reasons.add('formatter');
    if (task.migration === true) reasons.add('migration');
    if (task.fileOwnershipConfidence === 'low') reasons.add('low-file-ownership-confidence');

    for (const file of task.files_modified) {
      const lower = String(file).toLowerCase();
      if (
        /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|poetry\.lock|cargo\.lock)$/.test(lower)
      ) {
        reasons.add('lockfile');
      }
      if (/(^|\/)(migrations?|generated|dist|build)(\/|$)/.test(lower)) {
        reasons.add('generated-or-migration-path');
      }
    }
  }

  return [...reasons].sort();
}
