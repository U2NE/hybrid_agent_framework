import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateSealedExecutionGraph } from '../execution-graph/index.mjs';

export const TRANSITION_SCHEMA = 'hybrid-transition/v1';

export class TransitionError extends Error {
  constructor(message, code = 'TRANSITION_ERROR', details = {}) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.details = details;
  }
}

export class ExecutionRunStore {
  constructor(projectRoot, runId) {
    this.projectRoot = path.resolve(String(projectRoot || '.'));
    this.runId = safeSegment(runId, 'runId');
    this.runDir = path.join(this.projectRoot, '.planning', 'runs', this.runId);
    this.graphPath = path.join(this.runDir, 'GRAPH.json');
    this.graphsDir = path.join(this.runDir, 'graphs');
    this.transitionsPath = path.join(this.runDir, 'TRANSITIONS.jsonl');
    this._queue = Promise.resolve();
  }

  async initializeGraph(graph) {
    validateSealedExecutionGraph(graph);
    if (graph.runId !== this.runId) {
      throw new TransitionError(
        'graph runId does not match run store',
        'RUN_ID_MISMATCH',
        { expected: this.runId, actual: graph.runId }
      );
    }

    await fs.mkdir(this.runDir, { recursive: true });
    const existing = await this.loadGraph({ missingOk: true });
    if (existing) {
      if (existing.descriptorHash !== graph.descriptorHash) {
        throw new TransitionError(
          'run graph is already bound to a different descriptor',
          'GRAPH_FENCED',
          {
            expectedDescriptorHash: existing.descriptorHash,
            attemptedDescriptorHash: graph.descriptorHash,
          }
        );
      }
      return { status: 'replayed', graph: existing, path: this.graphPath };
    }

    await this.#persistGraphRevision(graph);
    await atomicJsonWrite(this.graphPath, graph);
    return { status: 'committed', graph, path: this.graphPath };
  }

  async advanceGraph(graph) {
    validateSealedExecutionGraph(graph);
    if (graph.runId !== this.runId) {
      throw new TransitionError(
        'graph runId does not match run store',
        'RUN_ID_MISMATCH',
        { expected: this.runId, actual: graph.runId }
      );
    }

    const current = await this.loadGraph();
    if (current.descriptorHash === graph.descriptorHash) {
      return { status: 'replayed', graph: current, path: this.graphPath };
    }
    if (graph.parentDescriptorHash !== current.descriptorHash) {
      throw new TransitionError(
        'graph revision does not extend the current descriptor',
        'GRAPH_FENCED',
        {
          currentDescriptorHash: current.descriptorHash,
          parentDescriptorHash: graph.parentDescriptorHash,
          attemptedDescriptorHash: graph.descriptorHash,
        }
      );
    }

    await this.#persistGraphRevision(graph);
    await atomicJsonWrite(this.graphPath, graph);
    return { status: 'advanced', graph, path: this.graphPath };
  }

  async loadGraphRevision(descriptorHash) {
    const hash = String(descriptorHash || '').trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new TransitionError(
        'descriptorHash must be a sha256 hex digest',
        'INVALID_DESCRIPTOR_HASH'
      );
    }
    const target = path.join(this.graphsDir, hash + '.json');
    let raw;
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new TransitionError(
          'graph revision is missing: ' + hash,
          'GRAPH_REVISION_MISSING'
        );
      }
      throw error;
    }
    let graph;
    try {
      graph = JSON.parse(raw);
      validateSealedExecutionGraph(graph);
    } catch (error) {
      throw new TransitionError(
        'stored graph revision is corrupt: ' + hash,
        'GRAPH_CORRUPT',
        { cause: error.message }
      );
    }
    if (graph.descriptorHash !== hash || graph.runId !== this.runId) {
      throw new TransitionError(
        'stored graph revision identity mismatch',
        'GRAPH_CORRUPT',
        { descriptorHash: hash }
      );
    }
    return graph;
  }

  async loadGraph(options = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.graphPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' && options.missingOk === true) return null;
      if (error?.code === 'ENOENT') {
        throw new TransitionError('run graph is missing', 'GRAPH_MISSING');
      }
      throw error;
    }

    let graph;
    try {
      graph = JSON.parse(raw);
    } catch (error) {
      throw new TransitionError(
        'run graph contains invalid JSON',
        'GRAPH_CORRUPT',
        { cause: error.message }
      );
    }
    try {
      validateSealedExecutionGraph(graph);
    } catch (error) {
      throw new TransitionError(
        'run graph failed sealed descriptor validation',
        'GRAPH_CORRUPT',
        { cause: error.message }
      );
    }
    if (graph.runId !== this.runId) {
      throw new TransitionError(
        'stored graph belongs to a different run',
        'RUN_ID_MISMATCH',
        { expected: this.runId, actual: graph.runId }
      );
    }
    return graph;
  }

  async loadTransitions() {
    let raw;
    try {
      raw = await fs.readFile(this.transitionsPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const records = [];
    const seen = new Map();
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    for (let index = 0; index < lines.length; index++) {
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch (error) {
        throw new TransitionError(
          'transition ledger contains invalid JSON at line ' + (index + 1),
          'TRANSITION_LEDGER_CORRUPT',
          { line: index + 1 }
        );
      }
      validateTransitionRecord(record, this.runId);
      const prior = seen.get(record.transitionId);
      if (prior && prior.requestFingerprint !== record.requestFingerprint) {
        throw new TransitionError(
          'transition ledger contains a fenced transition id',
          'TRANSITION_LEDGER_CORRUPT',
          { transitionId: record.transitionId }
        );
      }
      if (!prior) {
        seen.set(record.transitionId, record);
        records.push(record);
      }
    }
    return records;
  }

  async #persistGraphRevision(graph) {
    await fs.mkdir(this.graphsDir, { recursive: true });
    const target = path.join(this.graphsDir, graph.descriptorHash + '.json');
    try {
      const existing = JSON.parse(await fs.readFile(target, 'utf8'));
      if (canonical(existing) !== canonical(graph)) {
        throw new TransitionError(
          'descriptor hash collision or graph revision mismatch',
          'GRAPH_FENCED',
          { descriptorHash: graph.descriptorHash }
        );
      }
      return target;
    } catch (error) {
      if (error instanceof TransitionError) throw error;
      if (error?.code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          throw new TransitionError(
            'stored graph revision contains invalid JSON',
            'GRAPH_CORRUPT',
            { descriptorHash: graph.descriptorHash }
          );
        }
        throw error;
      }
    }
    await atomicJsonWrite(target, graph);
    return target;
  }

  commitTransition(input) {
    const operation = this._queue.then(() => this.#commitTransition(input));
    this._queue = operation.catch(() => {});
    return operation;
  }

  async #commitTransition(input) {
    const record = buildTransitionRecord(this.runId, input);
    await fs.mkdir(this.runDir, { recursive: true });
    const existing = await this.loadTransitions();
    const prior = existing.find((item) => item.transitionId === record.transitionId);

    if (prior) {
      if (prior.requestFingerprint !== record.requestFingerprint) {
        throw new TransitionError(
          'transition id was reused with a different request fingerprint',
          'TRANSITION_FENCED',
          {
            transitionId: record.transitionId,
            existingFingerprint: prior.requestFingerprint,
            attemptedFingerprint: record.requestFingerprint,
          }
        );
      }
      return {
        status: 'replayed',
        record: prior,
        path: this.transitionsPath,
      };
    }

    const handle = await fs.open(this.transitionsPath, 'a', 0o644);
    try {
      await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    return {
      status: 'committed',
      record,
      path: this.transitionsPath,
    };
  }
}

export function buildTransitionRecord(runId, input = {}) {
  const transitionId = safeSegment(input.transitionId, 'transitionId');
  const graphRevision = requiredString(input.graphRevision, 'graphRevision');
  const nodeId = requiredString(input.nodeId, 'nodeId');
  const attemptId = safeSegment(input.attemptId ?? 'attempt-1', 'attemptId');
  const kind = requiredString(input.kind, 'kind');
  const evidenceRefs = normalizeStrings(input.evidenceRefs || []);
  const requestFingerprint =
    input.requestFingerprint ||
    transitionRequestFingerprint({
      graphRevision,
      nodeId,
      attemptId,
      kind,
      request: input.request ?? null,
      effectPolicy: input.effectPolicy ?? null,
    });

  const record = {
    schema: TRANSITION_SCHEMA,
    runId: safeSegment(runId, 'runId'),
    transitionId,
    graphRevision,
    nodeId,
    attemptId,
    kind,
    effectPolicy: input.effectPolicy ?? null,
    requestFingerprint,
    evidenceRefs,
    result: boundedValue(input.result ?? null),
    timestamp: input.timestamp || new Date().toISOString(),
  };
  validateTransitionRecord(record, record.runId);
  return record;
}

export function transitionRequestFingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function reconcileActivityEvidence({
  graph,
  taskId,
  worktreeOwner = null,
  worktreeResult = null,
  transitions = [],
} = {}) {
  validateSealedExecutionGraph(graph);
  const node = graph.nodes.find((item) => item.id === taskId && item.kind === 'agent');
  if (!node) {
    throw new TransitionError(
      'recovery target is not an executable graph node: ' + taskId,
      'UNKNOWN_RECOVERY_NODE'
    );
  }

  const completed = transitions.find(
    (record) =>
      record?.runId === graph.runId &&
      record?.nodeId === taskId &&
      ['task_completed', 'recovered_task_completed'].includes(record?.kind)
  );
  if (completed) {
    return {
      status: 'already-completed',
      shouldRedispatch: false,
      effectPolicy: node.effectPolicy,
      evidence: completed,
    };
  }

  const observed = validateObservedWorktreeEvidence(
    graph,
    node,
    worktreeOwner,
    worktreeResult
  );
  if (observed.ok) {
    const transitionId =
      'recover-' +
      safeDigestSegment(taskId) +
      '-' +
      worktreeResult.patchHash.slice(0, 16);
    return {
      status: 'recover-completed-activity',
      shouldRedispatch: false,
      effectPolicy: node.effectPolicy,
      evidence: observed.evidence,
      suggestedTransition: {
        transitionId,
        graphRevision: graph.revisionId,
        nodeId: taskId,
        attemptId: 'recovery-1',
        kind: 'recovered_task_completed',
        effectPolicy: node.effectPolicy,
        request: {
          descriptorHash: graph.descriptorHash,
          patchHash: worktreeResult.patchHash,
          baseCommit: worktreeResult.baseCommit,
        },
        evidenceRefs: [
          'patch:' + worktreeResult.patchHash,
          ...worktreeResult.changedFiles.map((file) => 'file:' + file),
        ],
        result: {
          patchHash: worktreeResult.patchHash,
          baseCommit: worktreeResult.baseCommit,
          changedFiles: worktreeResult.changedFiles,
          attribution: 'observed',
        },
      },
    };
  }

  if (['side_effect_free', 'idempotent'].includes(node.effectPolicy)) {
    return {
      status: 'retry-safe',
      shouldRedispatch: true,
      effectPolicy: node.effectPolicy,
      reason: observed.reason,
    };
  }

  return {
    status: 'reconcile-required',
    shouldRedispatch: false,
    effectPolicy: node.effectPolicy,
    reason: observed.reason,
  };
}

function validateObservedWorktreeEvidence(graph, node, owner, result) {
  if (!owner || !result) return { ok: false, reason: 'observed-worktree-evidence-missing' };
  if (owner.schema !== 'hybrid-worktree-owner/v1') {
    return { ok: false, reason: 'worktree-owner-schema-invalid' };
  }
  if (owner.runId !== graph.runId) {
    return { ok: false, reason: 'worktree-owner-run-mismatch' };
  }
  if (owner.revisionId !== graph.revisionId) {
    return { ok: false, reason: 'worktree-owner-revision-mismatch' };
  }
  if (owner.graphHash !== graph.descriptorHash) {
    return { ok: false, reason: 'worktree-owner-graph-mismatch' };
  }
  if (owner.taskId !== node.id || result.taskId !== node.id) {
    return { ok: false, reason: 'worktree-task-mismatch' };
  }
  if (
    result.attribution !== 'observed' ||
    typeof result.patchHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.patchHash) ||
    typeof result.baseCommit !== 'string' ||
    !result.baseCommit ||
    result.baseCommit !== owner.baseCommit ||
    !Array.isArray(result.changedFiles)
  ) {
    return { ok: false, reason: 'worktree-result-evidence-invalid' };
  }

  const allowed = new Set(node.filesModified || []);
  const outside = result.changedFiles.filter((file) => !allowed.has(file));
  if (outside.length) {
    return { ok: false, reason: 'worktree-result-outside-ownership', outside };
  }

  return {
    ok: true,
    evidence: {
      patchHash: result.patchHash,
      baseCommit: result.baseCommit,
      changedFiles: [...result.changedFiles],
      attribution: 'observed',
    },
  };
}

function validateTransitionRecord(record, expectedRunId) {
  const errors = [];
  if (record?.schema !== TRANSITION_SCHEMA) errors.push('invalid schema');
  for (const field of [
    'runId',
    'transitionId',
    'graphRevision',
    'nodeId',
    'attemptId',
    'kind',
    'requestFingerprint',
    'timestamp',
  ]) {
    if (typeof record?.[field] !== 'string' || !record[field]) errors.push('missing ' + field);
  }
  if (record?.runId !== expectedRunId) errors.push('runId mismatch');
  if (!Array.isArray(record?.evidenceRefs)) errors.push('invalid evidenceRefs');
  if (
    typeof record?.requestFingerprint === 'string' &&
    !/^[0-9a-f]{64}$/.test(record.requestFingerprint)
  ) {
    errors.push('invalid requestFingerprint');
  }
  if (
    typeof record?.timestamp === 'string' &&
    !Number.isFinite(Date.parse(record.timestamp))
  ) {
    errors.push('invalid timestamp');
  }
  if (errors.length) {
    throw new TransitionError(
      'invalid transition record: ' + errors.join('; '),
      'INVALID_TRANSITION',
      { errors }
    );
  }
  return true;
}

async function atomicJsonWrite(target, value) {
  const temp =
    target +
    '.tmp-' +
    process.pid +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(16).slice(2);
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o644,
  });
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function safeSegment(value, field) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new TransitionError(field + ' contains an unsafe identifier', 'INVALID_IDENTIFIER');
  }
  return text;
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TransitionError(field + ' is required', 'MISSING_TRANSITION_FIELD');
  return text;
}

function normalizeStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
  )].sort();
}

function boundedValue(value, depth = 0) {
  if (depth > 8) return '[OMITTED]';
  if (typeof value === 'string') return value.slice(0, 4096);
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => boundedValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 128)
      .map(([key, item]) => [key, boundedValue(item, depth + 1)])
  );
}

function safeDigestSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + canonical(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
