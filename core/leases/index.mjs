import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { tasksConflict } from '../scheduler/index.mjs';
import { validateSealedExecutionGraph } from '../execution-graph/index.mjs';

export const RESOURCE_LEASE_SCHEMA = 'hybrid-resource-leases/v1';
export const DISPATCH_AUTHORIZATION_SCHEMA = 'hybrid-dispatch-authorization/v1';
export const LEASE_RELEASE_PROOF_SCHEMA = 'hybrid-lease-release-proof/v1';

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 20;

export class ResourceLeaseError extends Error {
  constructor(message, code = 'RESOURCE_LEASE_ERROR', details = {}) {
    super(message);
    this.name = 'ResourceLeaseError';
    this.code = code;
    this.details = details;
  }
}

export class ResourceLeaseStore {
  constructor(projectRoot, runId, options = {}) {
    this.projectRoot = path.resolve(String(projectRoot || '.'));
    this.runId = safeSegment(runId, 'runId');
    this.runDir = path.join(this.projectRoot, '.planning', 'runs', this.runId);
    this.storePath = path.join(this.runDir, 'LEASES.json');
    this.lockPath = path.join(this.runDir, '.leases.lock');
    this.lockTimeoutMs = positiveInt(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = positiveInt(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  }

  async acquire(graph, taskId, attemptId = 'attempt-1') {
    validateGraphForStore(graph, this.runId);
    const request = buildTaskLeaseRequest(graph, taskId, attemptId);

    return this.#withStoreLock(async () => {
      const store = await this.#loadUnlocked();
      const sameAttempt = store.leases.find(
        (lease) =>
          lease.taskId === request.taskId &&
          lease.attemptId === request.attemptId
      );

      if (sameAttempt) {
        if (sameAttempt.requestFingerprint !== request.requestFingerprint) {
          throw new ResourceLeaseError(
            'task attempt is already fenced to a different lease request',
            'LEASE_FENCED',
            {
              taskId: request.taskId,
              attemptId: request.attemptId,
              existingLeaseId: sameAttempt.leaseId,
            }
          );
        }
        if (sameAttempt.status === 'released') {
          throw new ResourceLeaseError(
            'released task attempt cannot be acquired again',
            'LEASE_ALREADY_RELEASED',
            {
              leaseId: sameAttempt.leaseId,
              taskId: request.taskId,
              attemptId: request.attemptId,
            }
          );
        }
        return {
          status: 'replayed',
          lease: publicLease(sameAttempt),
          authorization: authorizationFromLease(sameAttempt),
          path: this.storePath,
        };
      }

      const conflicts = store.leases
        .filter((lease) => lease.status === 'active')
        .filter((lease) => leaseConflicts(request, lease))
        .map((lease) => ({
          leaseId: lease.leaseId,
          taskId: lease.taskId,
          attemptId: lease.attemptId,
          descriptorHash: lease.descriptorHash,
        }))
        .sort((a, b) => a.leaseId.localeCompare(b.leaseId));

      if (conflicts.length) {
        throw new ResourceLeaseError(
          'resource lease conflicts with active task execution',
          'LEASE_CONFLICT',
          {
            taskId: request.taskId,
            attemptId: request.attemptId,
            conflicts,
          }
        );
      }

      const lease = {
        schema: RESOURCE_LEASE_SCHEMA,
        leaseId: leaseIdFor(request),
        leaseToken: randomBytes(24).toString('hex'),
        requestFingerprint: request.requestFingerprint,
        runId: this.runId,
        descriptorHash: request.descriptorHash,
        graphRevision: request.graphRevision,
        taskId: request.taskId,
        attemptId: request.attemptId,
        role: request.role,
        effectPolicy: request.effectPolicy,
        capabilityGrant: request.capabilityGrant,
        taskContract: request.taskContract,
        status: 'active',
        acquiredAt: new Date().toISOString(),
        releasedAt: null,
        releaseFingerprint: null,
        releaseResult: null,
      };

      store.leases.push(lease);
      store.leases.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
      await this.#writeUnlocked(store);

      return {
        status: 'acquired',
        lease: publicLease(lease),
        authorization: authorizationFromLease(lease),
        path: this.storePath,
      };
    });
  }

  async release(leaseId, leaseToken, proof) {
    const id = safeSegment(leaseId, 'leaseId');
    const token = requiredString(leaseToken, 'leaseToken');

    return this.#withStoreLock(async () => {
      const store = await this.#loadUnlocked();
      const lease = store.leases.find((item) => item.leaseId === id);
      if (!lease) {
        throw new ResourceLeaseError(
          'resource lease does not exist: ' + id,
          'LEASE_NOT_FOUND'
        );
      }
      assertToken(lease.leaseToken, token);
      validateLeaseReleaseProof(proof, lease);
      const releaseResult = boundedValue(proof);
      const releaseFingerprint = stableHash(releaseResult);

      if (lease.status === 'released') {
        if (lease.releaseFingerprint !== releaseFingerprint) {
          throw new ResourceLeaseError(
            'released lease was replayed with a different release proof',
            'LEASE_RELEASE_FENCED',
            { leaseId: id }
          );
        }
        return {
          status: 'replayed',
          lease: publicLease(lease),
          path: this.storePath,
        };
      }

      if (lease.status !== 'active') {
        throw new ResourceLeaseError(
          'unsupported lease status: ' + lease.status,
          'LEASE_STORE_CORRUPT',
          { leaseId: id }
        );
      }

      await assertReleaseProofBackedByLedger(this.runDir, proof, lease);

      lease.status = 'released';
      lease.releasedAt = new Date().toISOString();
      lease.releaseFingerprint = releaseFingerprint;
      lease.releaseResult = releaseResult;
      await this.#writeUnlocked(store);

      return {
        status: 'released',
        lease: publicLease(lease),
        path: this.storePath,
      };
    });
  }

  async list(options = {}) {
    const store = await this.#loadUnlocked();
    const leases = store.leases
      .filter((lease) => options.activeOnly !== true || lease.status === 'active')
      .map(publicLease);
    return {
      schema: RESOURCE_LEASE_SCHEMA,
      runId: this.runId,
      leases,
      path: this.storePath,
    };
  }

  async withGraphRevisionFence(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('graph revision fence callback is required');
    }
    return this.#withStoreLock(async () => {
      const store = await this.#loadUnlocked();
      const activeLeases = store.leases
        .filter((lease) => lease.status === 'active')
        .map(publicLease)
        .sort((a, b) => a.leaseId.localeCompare(b.leaseId));
      return fn({
        activeLeases,
        leaseStorePath: this.storePath,
      });
    });
  }

  async assertAuthorization(graph, authorization, options = {}) {
    validateGraphForStore(graph, this.runId);
    validateDispatchAuthorizationShape(authorization);

    if (
      authorization.runId !== graph.runId ||
      authorization.descriptorHash !== graph.descriptorHash ||
      authorization.graphRevision !== graph.revisionId
    ) {
      throw new ResourceLeaseError(
        'dispatch authorization is bound to a different graph revision',
        'DISPATCH_AUTH_GRAPH_MISMATCH'
      );
    }

    const store = await this.#loadUnlocked();
    const lease = store.leases.find(
      (item) => item.leaseId === authorization.leaseId
    );
    if (
      !lease ||
      (lease.status !== 'active' &&
        !(options.allowReleased === true && lease.status === 'released'))
    ) {
      throw new ResourceLeaseError(
        'dispatch authorization has no active durable lease',
        'DISPATCH_AUTH_INACTIVE'
      );
    }
    assertToken(lease.leaseToken, authorization.leaseToken);

    const expected = authorizationFromLease(lease);
    if (canonical(expected) !== canonical(authorization)) {
      throw new ResourceLeaseError(
        'dispatch authorization does not match its durable lease',
        'DISPATCH_AUTH_TAMPERED'
      );
    }

    const expectedRequest = buildTaskLeaseRequest(
      graph,
      authorization.taskId,
      authorization.attemptId
    );
    if (expectedRequest.requestFingerprint !== lease.requestFingerprint) {
      throw new ResourceLeaseError(
        'durable lease no longer matches the sealed task contract',
        'DISPATCH_AUTH_TASK_MISMATCH'
      );
    }

    return true;
  }

  async #loadUnlocked() {
    let raw;
    try {
      raw = await fs.readFile(this.storePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          schema: RESOURCE_LEASE_SCHEMA,
          runId: this.runId,
          leases: [],
        };
      }
      throw error;
    }

    let store;
    try {
      store = JSON.parse(raw);
    } catch (error) {
      throw new ResourceLeaseError(
        'resource lease store contains invalid JSON',
        'LEASE_STORE_CORRUPT'
      );
    }
    validateStore(store, this.runId);
    for (const lease of store.leases) {
      if (lease.status === 'released') {
        await assertReleaseProofBackedByLedger(
          this.runDir,
          lease.releaseResult,
          lease
        );
      }
    }
    return store;
  }

  async #writeUnlocked(store) {
    validateStore(store, this.runId);
    await fs.mkdir(this.runDir, { recursive: true });
    const temp =
      this.storePath +
      '.tmp-' +
      process.pid +
      '-' +
      Date.now() +
      '-' +
      randomBytes(4).toString('hex');
    await fs.writeFile(temp, JSON.stringify(store, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fs.rename(temp, this.storePath);
      await fs.chmod(this.storePath, 0o600);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #withStoreLock(fn) {
    await fs.mkdir(this.runDir, { recursive: true });
    const start = Date.now();
    let handle = null;

    while (!handle) {
      try {
        handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) +
            '\n',
          'utf8'
        );
        await handle.sync();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.#removeStaleLockIfSafe();
        if (Date.now() - start >= this.lockTimeoutMs) {
          throw new ResourceLeaseError(
            'timed out acquiring resource lease store lock',
            'LEASE_STORE_LOCK_TIMEOUT',
            { lockPath: this.lockPath }
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  async #removeStaleLockIfSafe() {
    try {
      const stat = await fs.stat(this.lockPath);
      if (Date.now() - stat.mtimeMs <= this.staleLockMs) return;

      let ownerPid = null;
      try {
        const raw = await fs.readFile(this.lockPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Number.isInteger(parsed?.pid) && parsed.pid > 0) ownerPid = parsed.pid;
      } catch {
        // Malformed stale lock metadata is safe to reclaim after the age bound.
      }

      if (ownerPid && processIsAlive(ownerPid)) return;
      await fs.rm(this.lockPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function buildTaskLeaseRequest(graph, taskId, attemptId = 'attempt-1') {
  validateSealedExecutionGraph(graph);
  const id = requiredString(taskId, 'taskId');
  const attempt = safeSegment(attemptId, 'attemptId');
  const node = graph.nodes.find(
    (item) => item.id === id && item.kind === 'agent'
  );
  if (!node) {
    throw new ResourceLeaseError(
      'lease target is not an executable task node: ' + id,
      'LEASE_TASK_NOT_FOUND'
    );
  }

  const taskContract = {
    id: node.id,
    reads: [...(node.reads || [])].sort(),
    writes: [...(node.writes || [])].sort(),
    files_modified: [...(node.filesModified || [])].sort(),
    resources: [...(node.resources || [])]
      .map((resource) => ({ key: resource.key, mode: resource.mode }))
      .sort(compareResource),
    effect_policy: node.effectPolicy || 'side_effect_free',
  };
  const request = {
    runId: graph.runId,
    descriptorHash: graph.descriptorHash,
    graphRevision: graph.revisionId,
    taskId: node.id,
    attemptId: attempt,
    role: node.role,
    effectPolicy: node.effectPolicy || 'side_effect_free',
    capabilityGrant: structuredClone(node.capabilityGrant),
    taskContract,
  };

  return {
    ...request,
    requestFingerprint: stableHash(request),
  };
}

export function validateDispatchAuthorizationShape(value) {
  const errors = [];
  if (value?.schema !== DISPATCH_AUTHORIZATION_SCHEMA) errors.push('invalid schema');
  for (const field of [
    'leaseId',
    'leaseToken',
    'runId',
    'descriptorHash',
    'graphRevision',
    'taskId',
    'attemptId',
    'role',
    'requestFingerprint',
  ]) {
    if (typeof value?.[field] !== 'string' || !value[field]) {
      errors.push('missing ' + field);
    }
  }
  if (!value?.capabilityGrant || typeof value.capabilityGrant !== 'object') {
    errors.push('missing capabilityGrant');
  }
  if (!value?.taskContract || typeof value.taskContract !== 'object') {
    errors.push('missing taskContract');
  }
  if (errors.length) {
    throw new ResourceLeaseError(
      'invalid dispatch authorization: ' + errors.join('; '),
      'INVALID_DISPATCH_AUTHORIZATION',
      { errors }
    );
  }
  return true;
}

async function assertReleaseProofBackedByLedger(runDir, proof, lease) {
  const transitionsPath = path.join(runDir, 'TRANSITIONS.jsonl');
  let raw;
  try {
    raw = await fs.readFile(transitionsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ResourceLeaseError(
        'lease release transition is not present in the durable transition ledger',
        'LEASE_RELEASE_TRANSITION_NOT_FOUND',
        { transitionId: proof.transitionId, transitionsPath }
      );
    }
    throw error;
  }

  const seen = new Map();
  let matched = null;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  for (let index = 0; index < lines.length; index++) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      throw new ResourceLeaseError(
        'durable transition ledger contains invalid JSON',
        'LEASE_RELEASE_LEDGER_CORRUPT',
        { line: index + 1, transitionsPath }
      );
    }

    if (
      record?.schema !== 'hybrid-transition/v1' ||
      typeof record?.runId !== 'string' ||
      typeof record?.transitionId !== 'string' ||
      typeof record?.descriptorHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.descriptorHash) ||
      typeof record?.graphRevision !== 'string' ||
      typeof record?.nodeId !== 'string' ||
      typeof record?.attemptId !== 'string' ||
      typeof record?.kind !== 'string' ||
      typeof record?.requestFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.requestFingerprint) ||
      !Array.isArray(record?.evidenceRefs)
    ) {
      throw new ResourceLeaseError(
        'durable transition ledger contains an invalid transition record',
        'LEASE_RELEASE_LEDGER_CORRUPT',
        { line: index + 1, transitionsPath }
      );
    }

    const prior = seen.get(record.transitionId);
    if (prior && prior.requestFingerprint !== record.requestFingerprint) {
      throw new ResourceLeaseError(
        'durable transition ledger contains a fenced transition id',
        'LEASE_RELEASE_LEDGER_CORRUPT',
        { transitionId: record.transitionId, transitionsPath }
      );
    }
    if (!prior) seen.set(record.transitionId, record);
    if (record.transitionId === proof.transitionId) matched = record;
  }

  if (!matched) {
    throw new ResourceLeaseError(
      'lease release transition is not present in the durable transition ledger',
      'LEASE_RELEASE_TRANSITION_NOT_FOUND',
      { transitionId: proof.transitionId, transitionsPath }
    );
  }

  const errors = [];
  if (stableHash(matched) !== proof.transitionFingerprint) {
    errors.push('transition fingerprint mismatch');
  }
  if (matched.runId !== lease.runId) errors.push('runId mismatch');
  if (matched.descriptorHash !== lease.descriptorHash) {
    errors.push('descriptorHash mismatch');
  }
  if (matched.graphRevision !== lease.graphRevision) errors.push('graphRevision mismatch');
  if (matched.nodeId !== lease.taskId) errors.push('task mismatch');
  if (matched.attemptId !== lease.attemptId) errors.push('attempt mismatch');
  if (matched.kind !== proof.transitionKind) errors.push('transitionKind mismatch');
  if (
    matched.effectPolicy != null &&
    lease.effectPolicy != null &&
    matched.effectPolicy !== lease.effectPolicy
  ) {
    errors.push('effectPolicy mismatch');
  }
  if (!matched.evidenceRefs.length) errors.push('terminal transition has no evidence');
  if (
    !['task_completed', 'recovered_task_completed', 'task_aborted_reconciled']
      .includes(matched.kind)
  ) {
    errors.push('transition kind is not terminal for lease release');
  }
  if (
    matched.kind === 'task_aborted_reconciled' &&
    matched.result?.outcome !== 'aborted-reconciled'
  ) {
    errors.push('reconciled abort outcome mismatch');
  }

  if (errors.length) {
    throw new ResourceLeaseError(
      'lease release proof is not backed by the exact durable terminal transition: ' +
        errors.join('; '),
      'LEASE_RELEASE_LEDGER_MISMATCH',
      {
        transitionId: proof.transitionId,
        errors,
        transitionsPath,
      }
    );
  }

  return true;
}

export function validateLeaseReleaseProof(value, lease = null) {
  const errors = [];
  if (value?.schema !== LEASE_RELEASE_PROOF_SCHEMA) errors.push('invalid schema');
  if (value?.source !== 'transition') errors.push('invalid source');
  for (const field of [
    'transitionId',
    'transitionKind',
    'transitionFingerprint',
    'runId',
    'descriptorHash',
    'graphRevision',
    'taskId',
    'attemptId',
    'leaseId',
    'outcome',
  ]) {
    if (typeof value?.[field] !== 'string' || !value[field]) {
      errors.push('missing ' + field);
    }
  }
  if (
    typeof value?.transitionFingerprint === 'string' &&
    !/^[0-9a-f]{64}$/.test(value.transitionFingerprint)
  ) {
    errors.push('invalid transitionFingerprint');
  }
  if (
    !['task_completed', 'recovered_task_completed', 'task_aborted_reconciled']
      .includes(value?.transitionKind)
  ) {
    errors.push('invalid transitionKind');
  }
  const expectedOutcome = value?.transitionKind === 'task_aborted_reconciled'
    ? 'aborted-reconciled'
    : 'completed';
  if (value?.outcome !== expectedOutcome) errors.push('invalid outcome');

  if (lease) {
    const bindings = [
      ['runId', lease.runId],
      ['descriptorHash', lease.descriptorHash],
      ['graphRevision', lease.graphRevision],
      ['taskId', lease.taskId],
      ['attemptId', lease.attemptId],
      ['leaseId', lease.leaseId],
    ];
    for (const [field, expected] of bindings) {
      if (value?.[field] !== expected) errors.push(field + ' mismatch');
    }
  }

  if (errors.length) {
    throw new ResourceLeaseError(
      'lease release proof validation failed: ' + errors.join('; '),
      'INVALID_LEASE_RELEASE_PROOF',
      { errors }
    );
  }
  return true;
}

function validateGraphForStore(graph, runId) {
  validateSealedExecutionGraph(graph);
  if (graph.runId !== runId) {
    throw new ResourceLeaseError(
      'graph runId does not match lease store',
      'LEASE_RUN_MISMATCH',
      { expected: runId, actual: graph.runId }
    );
  }
}

function leaseConflicts(request, lease) {
  return tasksConflict(
    request.taskContract,
    lease.taskContract
  );
}

function leaseIdFor(request) {
  return 'lease-' + request.requestFingerprint.slice(0, 24);
}

function authorizationFromLease(lease) {
  return {
    schema: DISPATCH_AUTHORIZATION_SCHEMA,
    leaseId: lease.leaseId,
    leaseToken: lease.leaseToken,
    runId: lease.runId,
    descriptorHash: lease.descriptorHash,
    graphRevision: lease.graphRevision,
    taskId: lease.taskId,
    attemptId: lease.attemptId,
    role: lease.role,
    effectPolicy: lease.effectPolicy,
    capabilityGrant: structuredClone(lease.capabilityGrant),
    taskContract: structuredClone(lease.taskContract),
    requestFingerprint: lease.requestFingerprint,
    authorizedAt: lease.acquiredAt,
  };
}

function validateStore(store, runId) {
  const errors = [];
  if (store?.schema !== RESOURCE_LEASE_SCHEMA) errors.push('invalid schema');
  if (store?.runId !== runId) errors.push('runId mismatch');
  if (!Array.isArray(store?.leases)) errors.push('leases must be an array');

  if (Array.isArray(store?.leases)) {
    const ids = new Set();
    for (const lease of store.leases) {
      if (lease?.schema !== RESOURCE_LEASE_SCHEMA) errors.push('invalid lease schema');
      if (lease?.runId !== runId) errors.push('lease runId mismatch');
      if (typeof lease?.leaseId !== 'string' || !lease.leaseId) errors.push('missing leaseId');
      if (ids.has(lease?.leaseId)) errors.push('duplicate leaseId');
      ids.add(lease?.leaseId);
      if (!['active', 'released'].includes(lease?.status)) errors.push('invalid lease status');
      if (typeof lease?.leaseToken !== 'string' || !lease.leaseToken) errors.push('missing leaseToken');
      if (typeof lease?.requestFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(lease.requestFingerprint)) {
        errors.push('invalid requestFingerprint');
      }
      if (!lease?.taskContract || !lease?.capabilityGrant) errors.push('incomplete lease contract');
      if (lease?.status === 'released') {
        try {
          validateLeaseReleaseProof(lease.releaseResult, lease);
        } catch {
          errors.push('invalid release proof');
        }
        if (
          typeof lease?.releaseFingerprint !== 'string' ||
          !/^[0-9a-f]{64}$/.test(lease.releaseFingerprint) ||
          lease.releaseFingerprint !== stableHash(lease.releaseResult)
        ) {
          errors.push('invalid releaseFingerprint');
        }
      } else if (
        lease?.releaseResult !== null ||
        lease?.releaseFingerprint !== null ||
        lease?.releasedAt !== null
      ) {
        errors.push('active lease has release metadata');
      }
    }
  }

  if (errors.length) {
    throw new ResourceLeaseError(
      'resource lease store validation failed: ' + errors.join('; '),
      'LEASE_STORE_CORRUPT',
      { errors }
    );
  }
  return true;
}

function assertToken(expected, actual) {
  const left = Buffer.from(String(expected), 'utf8');
  const right = Buffer.from(String(actual), 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ResourceLeaseError(
      'resource lease token is invalid',
      'LEASE_TOKEN_INVALID'
    );
  }
}

function compareResource(left, right) {
  return left.key.localeCompare(right.key) || left.mode.localeCompare(right.mode);
}

function publicLease(lease) {
  const copy = structuredClone(lease);
  delete copy.leaseToken;
  return copy;
}

function stableHash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
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

function safeSegment(value, field) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new ResourceLeaseError(
      field + ' contains an unsafe identifier',
      'INVALID_LEASE_IDENTIFIER'
    );
  }
  return text;
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new ResourceLeaseError(
      field + ' is required',
      'MISSING_LEASE_FIELD'
    );
  }
  return text;
}

function positiveInt(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
