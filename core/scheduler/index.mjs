export class SchedulerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}

const EFFECT_POLICIES = new Set([
  'side_effect_free',
  'idempotent',
  'at_most_once',
  'reconcile_required',
]);

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
      throw new SchedulerError(
        'dependency cycle or unsatisfied dependency among: ' + remaining.join(', '),
        'CYCLE'
      );
    }

    const wave = [];

    for (const task of ready) {
      if (wave.some((scheduledTask) => tasksConflict(task, scheduledTask))) continue;
      wave.push(task);
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
    const normalized = normalizeTask(task);
    if (!EFFECT_POLICIES.has(normalized.effect_policy)) {
      throw new SchedulerError(
        'invalid effect policy for ' + task.id + ': ' + normalized.effect_policy,
        'INVALID_EFFECT_POLICY'
      );
    }
    for (const dep of normalized.depends_on) {
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

export function findResourceConflicts(tasks) {
  const normalized = (Array.isArray(tasks) ? tasks : []).map(normalizeTask);
  const conflicts = [];

  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex++) {
      const left = normalized[leftIndex];
      const right = normalized[rightIndex];

      for (const leftResource of left.resources) {
        for (const rightResource of right.resources) {
          if (!resourcesConflict(leftResource, rightResource)) continue;
          conflicts.push({
            resource: overlappingResourceLabel(leftResource.key, rightResource.key),
            tasks: [left.id, right.id],
            modes: [leftResource.mode, rightResource.mode],
          });
        }
      }
    }
  }

  return conflicts;
}

export function normalizeTask(task) {
  const filesModified = uniquePaths(task.files_modified || task.filesModified || []);
  const reads = uniquePaths(task.reads || task.files_read || task.filesRead || []);
  const writes = uniquePaths([
    ...filesModified,
    ...(task.writes || task.files_written || task.filesWritten || []),
  ]);
  const resources = normalizeResources(task.resources || []);
  const mutating =
    writes.length > 0 ||
    resources.some((resource) => resource.mode === 'exclusive');

  return {
    ...task,
    depends_on: [...new Set(task.depends_on || [])],
    files_modified: filesModified,
    reads,
    writes,
    resources,
    effect_policy:
      task.effect_policy ||
      task.effectPolicy ||
      (mutating ? 'reconcile_required' : 'side_effect_free'),
    acceptance_criteria: task.acceptance_criteria || [],
    verify: task.verify || null,
    owner: task.owner || 'implementer',
  };
}

export function tasksConflict(leftTask, rightTask) {
  const left = normalizeTask(leftTask);
  const right = normalizeTask(rightTask);

  if (fileAccessConflict(left, right)) return true;
  return left.resources.some((leftResource) =>
    right.resources.some((rightResource) =>
      resourcesConflict(leftResource, rightResource)
    )
  );
}

export function isMutatingTask(task) {
  const normalized = normalizeTask(task);
  return (
    normalized.writes.length > 0 ||
    normalized.resources.some((resource) => resource.mode === 'exclusive') ||
    normalized.effect_policy !== 'side_effect_free'
  );
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
      reason: 'parallel-work-has-no-mutating-conflict',
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
  if (normalized.filter(isMutatingTask).length > 1) reasons.add('parallel-mutators');

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

function fileAccessConflict(left, right) {
  const leftReads = new Set(left.reads);
  const leftWrites = new Set(left.writes);
  const rightReads = new Set(right.reads);
  const rightWrites = new Set(right.writes);

  for (const file of leftWrites) {
    if (rightWrites.has(file) || rightReads.has(file)) return true;
  }
  for (const file of rightWrites) {
    if (leftReads.has(file)) return true;
  }
  return false;
}

function normalizeResources(resources) {
  if (!Array.isArray(resources)) {
    throw new SchedulerError('resources must be an array', 'INVALID_RESOURCE');
  }

  const byIdentity = new Map();
  for (const raw of resources) {
    const object = typeof raw === 'string' ? { key: raw } : raw;
    const key = String(object?.key || '').trim();
    if (!key) throw new SchedulerError('resource key must be non-empty', 'INVALID_RESOURCE');

    const requestedMode = String(object?.mode || 'exclusive').trim().toLowerCase();
    const mode = ['read', 'shared', 'shared-read'].includes(requestedMode)
      ? 'shared'
      : requestedMode === 'write'
        ? 'exclusive'
        : requestedMode;

    if (!['shared', 'exclusive'].includes(mode)) {
      throw new SchedulerError(
        'invalid resource mode for ' + key + ': ' + requestedMode,
        'INVALID_RESOURCE'
      );
    }

    const identity = key + '\0' + mode;
    byIdentity.set(identity, { key, mode });
  }

  return [...byIdentity.values()].sort((a, b) =>
    a.key.localeCompare(b.key) || a.mode.localeCompare(b.mode)
  );
}

function resourcesConflict(left, right) {
  if (left.mode === 'shared' && right.mode === 'shared') return false;
  return resourcePatternsOverlap(left.key, right.key);
}

function resourcePatternsOverlap(left, right) {
  if (left === right) return true;
  const leftPrefix = wildcardPrefix(left);
  const rightPrefix = wildcardPrefix(right);

  if (leftPrefix === null && rightPrefix === null) return false;
  if (leftPrefix !== null && rightPrefix !== null) {
    return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
  }
  if (leftPrefix !== null) return right.startsWith(leftPrefix);
  return left.startsWith(rightPrefix);
}

function wildcardPrefix(value) {
  if (!value.endsWith('*')) return null;
  return value.slice(0, -1);
}

function overlappingResourceLabel(left, right) {
  if (left === right) return left;
  return [left, right].sort().join(' <> ');
}

function uniquePaths(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
      .filter(Boolean)
  )].sort();
}
