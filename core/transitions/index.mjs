import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  requestLeaseExtension,
  validateSealedExecutionGraph,
} from '../execution-graph/index.mjs';
import {
  LEASE_RELEASE_PROOF_SCHEMA,
  ResourceLeaseStore,
} from '../leases/index.mjs';

export const TRANSITION_SCHEMA = 'hybrid-transition/v1';

const TERMINAL_TRANSITION_KINDS = new Set([
  'task_completed',
  'recovered_task_completed',
  'task_aborted_reconciled',
]);
const TRANSITION_LOCK_RETRY_MS = 25;
const DEFAULT_TRANSITION_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_TRANSITION_STALE_LOCK_MS = 30000;

export class TransitionError extends Error {
  constructor(message, code = 'TRANSITION_ERROR', details = {}) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
    this.details = details;
  }
}

export class ExecutionRunStore {
  constructor(projectRoot, runId, options = {}) {
    this.projectRoot = path.resolve(String(projectRoot || '.'));
    this.runId = safeSegment(runId, 'runId');
    this.runDir = path.join(this.projectRoot, '.planning', 'runs', this.runId);
    this.graphPath = path.join(this.runDir, 'GRAPH.json');
    this.graphsDir = path.join(this.runDir, 'graphs');
    this.transitionsPath = path.join(this.runDir, 'TRANSITIONS.jsonl');
    this.transitionLockPath = path.join(this.runDir, '.transitions.lock');
    this.transitionLockTimeoutMs = positiveInt(
      options.transitionLockTimeoutMs,
      DEFAULT_TRANSITION_LOCK_TIMEOUT_MS
    );
    this.transitionStaleLockMs = positiveInt(
      options.transitionStaleLockMs,
      DEFAULT_TRANSITION_STALE_LOCK_MS
    );
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
    const leaseStore = new ResourceLeaseStore(this.projectRoot, this.runId);
    return leaseStore.withGraphRevisionFence(async () => {
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
    });
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

    const leaseStore = new ResourceLeaseStore(this.projectRoot, this.runId);
    return leaseStore.withGraphRevisionFence(async ({ activeLeases, leaseStorePath }) => {
      const current = await this.loadGraph();
      if (current.descriptorHash === graph.descriptorHash) {
        return { status: 'replayed', graph: current, path: this.graphPath };
      }
      if (activeLeases.length) {
        throw new TransitionError(
          'graph revision cannot advance while task leases are active',
          'GRAPH_ADVANCE_ACTIVE_LEASES',
          {
            currentDescriptorHash: current.descriptorHash,
            attemptedDescriptorHash: graph.descriptorHash,
            activeLeases: activeLeases.map((lease) => ({
              leaseId: lease.leaseId,
              taskId: lease.taskId,
              attemptId: lease.attemptId,
              descriptorHash: lease.descriptorHash,
            })),
            leaseStorePath,
          }
        );
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
    });
  }

  async extendTaskResources(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TransitionError(
        'lease extension input must be an object',
        'INVALID_LEASE_EXTENSION'
      );
    }

    const forbiddenFields = [
      'revisionId',
      'plan',
      'spec',
      'files_modified',
      'filesModified',
      'writes',
      'reads',
    ].filter((field) => Object.prototype.hasOwnProperty.call(input, field));

    if (forbiddenFields.length) {
      throw new TransitionError(
        'runtime lease extension may add semantic resources only; contract changes require a material revision',
        'LEASE_EXTENSION_CONTRACT_CHANGE_FORBIDDEN',
        { forbiddenFields }
      );
    }

    const current = await this.loadGraph();
    const proposal = requestLeaseExtension(current, input);

    if (!proposal.applied) {
      return {
        status: proposal.status,
        applied: false,
        reasons: [...(proposal.reasons || [])],
        materialRevisionRequired: proposal.status === 'user-approval-required',
        graph: current,
      };
    }

    try {
      const advanced = await this.advanceGraph(proposal.graph);
      return {
        status: advanced.status === 'advanced' ? 'extended' : 'replayed',
        applied: advanced.status === 'advanced',
        requiresReschedule: proposal.requiresReschedule,
        conflicts: [...proposal.conflicts],
        parentDescriptorHash: current.descriptorHash,
        graph: advanced.graph,
      };
    } catch (error) {
      if (
        error instanceof TransitionError &&
        error.code === 'GRAPH_ADVANCE_ACTIVE_LEASES'
      ) {
        return {
          status: 'drain-required',
          applied: false,
          requiresReschedule: true,
          conflicts: [...proposal.conflicts],
          currentDescriptorHash: current.descriptorHash,
          proposedDescriptorHash: proposal.graph.descriptorHash,
          proposedRevisionId: proposal.graph.revisionId,
          activeLeases: structuredClone(error.details.activeLeases || []),
          graph: current,
        };
      }

      if (
        error instanceof TransitionError &&
        error.code === 'GRAPH_FENCED'
      ) {
        const latest = await this.loadGraph();
        return {
          status: 'retry-required',
          applied: false,
          currentDescriptorHash: latest.descriptorHash,
          attemptedParentDescriptorHash: current.descriptorHash,
          graph: latest,
        };
      }

      throw error;
    }
  }

  async releaseTaskLease(authorization, transitionId) {
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
      throw new TransitionError(
        'dispatch authorization is required for evidence-bound lease release',
        'LEASE_RELEASE_AUTHORIZATION_REQUIRED'
      );
    }
    const id = safeSegment(transitionId, 'transitionId');
    const graph = await this.loadGraphRevision(authorization.descriptorHash);
    const leaseStore = new ResourceLeaseStore(this.projectRoot, this.runId);
    await leaseStore.assertAuthorization(graph, authorization, { allowReleased: true });

    const transitions = await this.loadTransitions();
    const transition = transitions.find((item) => item.transitionId === id);
    if (!transition) {
      throw new TransitionError(
        'lease release transition is not present in the durable transition ledger',
        'LEASE_RELEASE_TRANSITION_NOT_FOUND',
        { transitionId: id }
      );
    }

    validateTransitionForLeaseRelease(transition, authorization);
    const proof = buildLeaseReleaseProof(authorization, transition);
    const released = await leaseStore.release(
      authorization.leaseId,
      authorization.leaseToken,
      proof
    );

    return {
      ...released,
      proof,
      transition: structuredClone(transition),
    };
  }

  async abortTaskLease(authorization, input = {}) {
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
      throw new TransitionError(
        'dispatch authorization is required for reconciled abort',
        'LEASE_RELEASE_AUTHORIZATION_REQUIRED'
      );
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TransitionError(
        'reconciled abort input must be an object',
        'INVALID_RECONCILED_ABORT'
      );
    }

    const reasonCode = safeSegment(input.reasonCode, 'reasonCode');
    const evidenceRefs = normalizeStrings(input.evidenceRefs || []);
    if (!evidenceRefs.length) {
      throw new TransitionError(
        'reconciled abort requires at least one durable evidence reference',
        'RECONCILED_ABORT_EVIDENCE_REQUIRED'
      );
    }

    const graph = await this.loadGraphRevision(authorization.descriptorHash);
    const leaseStore = new ResourceLeaseStore(this.projectRoot, this.runId);
    await leaseStore.assertAuthorization(graph, authorization, { allowReleased: true });

    const node = graph.nodes.find(
      (item) => item.id === authorization.taskId && item.kind === 'agent'
    );
    if (!node) {
      throw new TransitionError(
        'reconciled abort target is not an executable graph node',
        'UNKNOWN_RECOVERY_NODE',
        { taskId: authorization.taskId }
      );
    }

    const transitionId =
      'abort-' +
      safeDigestSegment(authorization.taskId) +
      '-' +
      safeDigestSegment(authorization.attemptId) +
      '-' +
      authorization.leaseId.slice(-12);

    const leaseSnapshot = (await leaseStore.list()).leases.find(
      (item) => item.leaseId === authorization.leaseId
    );
    if (leaseSnapshot?.status === 'released') {
      const priorProof = leaseSnapshot.releaseResult;
      if (
        priorProof?.transitionKind !== 'task_aborted_reconciled' ||
        priorProof?.transitionId !== transitionId
      ) {
        throw new TransitionError(
          'released task attempt already has a different terminal outcome',
          'LEASE_TERMINAL_OUTCOME_FENCED',
          {
            leaseId: authorization.leaseId,
            priorTransitionId: priorProof?.transitionId ?? null,
            priorTransitionKind: priorProof?.transitionKind ?? null,
            attemptedTransitionId: transitionId,
            attemptedTransitionKind: 'task_aborted_reconciled',
          }
        );
      }
    }

    const committed = await this.commitTransition({
      transitionId,
      graphRevision: authorization.graphRevision,
      nodeId: authorization.taskId,
      attemptId: authorization.attemptId,
      kind: 'task_aborted_reconciled',
      effectPolicy: authorization.effectPolicy ?? node.effectPolicy ?? null,
      request: {
        descriptorHash: authorization.descriptorHash,
        leaseId: authorization.leaseId,
        reasonCode,
      },
      evidenceRefs,
      result: {
        outcome: 'aborted-reconciled',
        reasonCode,
        ...(input.result !== undefined
          ? { details: boundedValue(input.result) }
          : {}),
      },
    });

    const released = await this.releaseTaskLease(
      authorization,
      committed.record.transitionId
    );
    return {
      status: released.status === 'released' ? 'aborted-released' : 'replayed',
      transition: committed.record,
      proof: released.proof,
      lease: released.lease,
      path: released.path,
    };
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
    const terminalByAttempt = new Map();
    for (const record of records) {
      if (!isTerminalTransition(record)) continue;
      const key = JSON.stringify([
        record.descriptorHash,
        record.graphRevision,
        record.nodeId,
        record.attemptId,
      ]);
      const priorTerminal = terminalByAttempt.get(key);
      if (
        priorTerminal &&
        priorTerminal.transitionId !== record.transitionId
      ) {
        throw new TransitionError(
          'transition ledger contains multiple terminal outcomes for one task attempt',
          'TRANSITION_LEDGER_CORRUPT',
          {
            graphRevision: record.graphRevision,
            nodeId: record.nodeId,
            attemptId: record.attemptId,
            transitionIds: [
              priorTerminal.transitionId,
              record.transitionId,
            ],
          }
        );
      }
      if (!priorTerminal) terminalByAttempt.set(key, record);
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
    if (isTerminalTransition(record) && !record.evidenceRefs.length) {
      throw new TransitionError(
        'terminal transition requires at least one durable evidence reference',
        'TERMINAL_TRANSITION_EVIDENCE_REQUIRED',
        {
          transitionId: record.transitionId,
          kind: record.kind,
        }
      );
    }

    await fs.mkdir(this.runDir, { recursive: true });

    if (isTerminalTransition(record)) {
      const leaseStore = new ResourceLeaseStore(this.projectRoot, this.runId);
      return leaseStore.withGraphRevisionFence(async () => {
        const graph = await this.loadGraph();
        if (
          record.descriptorHash !== graph.descriptorHash ||
          record.graphRevision !== graph.revisionId
        ) {
          const existing = await this.loadTransitions();
          const prior = existing.find(
            (item) => item.transitionId === record.transitionId
          );
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
        }

        validateTerminalTransitionAgainstGraph(record, graph);
        return this.#commitRecord(record);
      });
    }

    return this.#commitRecord(record);
  }

  async #commitRecord(record) {
    return this.#withTransitionLock(async () => {
      const existing = await this.loadTransitions();
      const prior = existing.find(
        (item) => item.transitionId === record.transitionId
      );

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

      if (isTerminalTransition(record)) {
        const priorTerminal = existing.find(
          (item) =>
            isTerminalTransition(item) &&
            item.descriptorHash === record.descriptorHash &&
            item.graphRevision === record.graphRevision &&
            item.nodeId === record.nodeId &&
            item.attemptId === record.attemptId
        );
        if (priorTerminal) {
          throw new TransitionError(
            'task attempt already has a different terminal transition',
            'TERMINAL_TRANSITION_FENCED',
            {
              descriptorHash: record.descriptorHash,
              graphRevision: record.graphRevision,
              nodeId: record.nodeId,
              attemptId: record.attemptId,
              existingTransitionId: priorTerminal.transitionId,
              existingKind: priorTerminal.kind,
              attemptedTransitionId: record.transitionId,
              attemptedKind: record.kind,
            }
          );
        }
      }

      await atomicTextWrite(
        this.transitionsPath,
        [...existing, record]
          .map((item) => JSON.stringify(item))
          .join('\n') + '\n'
      );

      return {
        status: 'committed',
        record,
        path: this.transitionsPath,
      };
    });
  }

  async #withTransitionLock(fn) {
    await fs.mkdir(this.runDir, { recursive: true });
    const startedAt = Date.now();
    let handle = null;

    while (!handle) {
      try {
        handle = await fs.open(this.transitionLockPath, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            acquiredAt: new Date().toISOString(),
          }) + '\n',
          'utf8'
        );
        await handle.sync();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.#removeStaleTransitionLockIfSafe();
        if (Date.now() - startedAt >= this.transitionLockTimeoutMs) {
          throw new TransitionError(
            'timed out acquiring durable transition ledger lock',
            'TRANSITION_LOCK_TIMEOUT',
            { lockPath: this.transitionLockPath }
          );
        }
        await sleep(TRANSITION_LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await releaseOwnedLock(this.transitionLockPath, process.pid);
    }
  }

  async #removeStaleTransitionLockIfSafe() {
    try {
      const stat = await fs.stat(this.transitionLockPath);
      if (Date.now() - stat.mtimeMs <= this.transitionStaleLockMs) return;

      let ownerPid = null;
      try {
        const parsed = JSON.parse(
          await fs.readFile(this.transitionLockPath, 'utf8')
        );
        if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
          ownerPid = parsed.pid;
        }
      } catch {
        // Malformed lock metadata is reclaimable after the stale-age bound.
      }

      if (ownerPid && processIsAlive(ownerPid)) return;
      await fs.rm(this.transitionLockPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

}

export function buildTransitionRecord(runId, input = {}) {
  const transitionId = safeSegment(input.transitionId, 'transitionId');
  const graphRevision = requiredString(input.graphRevision, 'graphRevision');
  const nodeId = requiredString(input.nodeId, 'nodeId');
  const attemptId = safeSegment(input.attemptId ?? 'attempt-1', 'attemptId');
  const kind = requiredString(input.kind, 'kind');
  const evidenceRefs = normalizeStrings(input.evidenceRefs || []);
  const descriptorHash =
    input.descriptorHash ??
    input.request?.descriptorHash ??
    null;
  const requestFingerprint =
    input.requestFingerprint ||
    transitionRequestFingerprint({
      descriptorHash,
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
    descriptorHash,
    effectPolicy: input.effectPolicy ?? null,
    requestFingerprint,
    evidenceRefs,
    result: boundedValue(input.result ?? null),
    timestamp: input.timestamp || new Date().toISOString(),
  };
  validateTransitionRecord(record, record.runId);
  return record;
}

export function buildLeaseReleaseProof(authorization, transition) {
  validateTransitionForLeaseRelease(transition, authorization);
  return {
    schema: LEASE_RELEASE_PROOF_SCHEMA,
    source: 'transition',
    transitionId: transition.transitionId,
    transitionKind: transition.kind,
    transitionFingerprint: createHash('sha256')
      .update(canonical(transition))
      .digest('hex'),
    runId: authorization.runId,
    descriptorHash: authorization.descriptorHash,
    graphRevision: authorization.graphRevision,
    taskId: authorization.taskId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    outcome:
      transition.kind === 'task_aborted_reconciled'
        ? 'aborted-reconciled'
        : 'completed',
  };
}

function validateTransitionForLeaseRelease(transition, authorization) {
  validateTransitionRecord(transition, authorization.runId);
  const errors = [];

  if (
    !['task_completed', 'recovered_task_completed', 'task_aborted_reconciled']
      .includes(transition.kind)
  ) {
    errors.push('transition kind is not terminal for lease release');
  }
  if (transition.descriptorHash !== authorization.descriptorHash) {
    errors.push('descriptorHash mismatch');
  }
  if (transition.graphRevision !== authorization.graphRevision) {
    errors.push('graphRevision mismatch');
  }
  if (transition.nodeId !== authorization.taskId) {
    errors.push('task mismatch');
  }
  if (transition.attemptId !== authorization.attemptId) {
    errors.push('attempt mismatch');
  }
  if (
    transition.effectPolicy != null &&
    authorization.effectPolicy != null &&
    transition.effectPolicy !== authorization.effectPolicy
  ) {
    errors.push('effectPolicy mismatch');
  }
  if (!Array.isArray(transition.evidenceRefs) || !transition.evidenceRefs.length) {
    errors.push('terminal transition has no evidence');
  }
  if (
    transition.kind === 'task_aborted_reconciled' &&
    transition.result?.outcome !== 'aborted-reconciled'
  ) {
    errors.push('reconciled abort outcome mismatch');
  }

  if (errors.length) {
    throw new TransitionError(
      'transition cannot authorize lease release: ' + errors.join('; '),
      'LEASE_RELEASE_TRANSITION_INVALID',
      {
        transitionId: transition.transitionId,
        errors,
      }
    );
  }
  return true;
}

function validateTerminalTransitionAgainstGraph(record, graph) {
  validateSealedExecutionGraph(graph);
  const errors = [];

  if (record.descriptorHash !== graph.descriptorHash) {
    errors.push('descriptorHash mismatch');
  }
  if (record.graphRevision !== graph.revisionId) {
    errors.push('graphRevision mismatch');
  }

  const node = graph.nodes.find(
    (item) => item.id === record.nodeId && item.kind === 'agent'
  );
  if (!node) {
    errors.push('terminal target is not an executable agent node');
  } else if (record.effectPolicy !== node.effectPolicy) {
    errors.push('effectPolicy mismatch');
  }

  if (
    record.kind === 'task_aborted_reconciled' &&
    record.result?.outcome !== 'aborted-reconciled'
  ) {
    errors.push('reconciled abort outcome mismatch');
  }

  if (errors.length) {
    throw new TransitionError(
      'terminal transition does not match the current sealed graph: ' +
        errors.join('; '),
      'TERMINAL_TRANSITION_GRAPH_MISMATCH',
      {
        transitionId: record.transitionId,
        descriptorHash: record.descriptorHash,
        graphRevision: record.graphRevision,
        nodeId: record.nodeId,
        errors,
      }
    );
  }
  return true;
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
      record?.descriptorHash === graph.descriptorHash &&
      record?.graphRevision === graph.revisionId &&
      record?.nodeId === taskId &&
      record?.effectPolicy === node.effectPolicy &&
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
    record?.descriptorHash != null &&
    (
      typeof record.descriptorHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.descriptorHash)
    )
  ) {
    errors.push('invalid descriptorHash');
  }
  if (
    isTerminalTransition(record) &&
    (
      typeof record?.descriptorHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.descriptorHash)
    )
  ) {
    errors.push('terminal transition missing descriptorHash');
  }
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

function isTerminalTransition(record) {
  return TERMINAL_TRANSITION_KINDS.has(record?.kind);
}

async function atomicTextWrite(target, text) {
  const temp =
    target +
    '.tmp-' +
    process.pid +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(16).slice(2);
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx', 0o644);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
    await fs.chmod(target, 0o644);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function releaseOwnedLock(lockPath, expectedPid) {
  let ownerPid = null;
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
      ownerPid = parsed.pid;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  if (ownerPid !== expectedPid) {
    throw new TransitionError(
      'durable transition lock ownership changed',
      'TRANSITION_LOCK_FENCED',
      {
        lockPath,
        expectedPid,
        observedPid: ownerPid,
      }
    );
  }
  await fs.rm(lockPath, { force: true });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
