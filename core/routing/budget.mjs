import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MODEL_ROUTING_POLICY,
  validateModelSelection,
} from './index.mjs';

export const MODEL_BUDGET_SCHEMA = 'hybrid-model-budget/v1';
export const MODEL_BUDGET_APPROVAL_SCHEMA = 'hybrid-user-model-budget-approval/v1';
export const MODEL_BUDGET_AUTHORIZATION_SCHEMA = 'hybrid-model-budget-authorization/v1';

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 20;

export class ModelBudgetError extends Error {
  constructor(message, code = 'MODEL_BUDGET_ERROR', details = {}) {
    super(message);
    this.name = 'ModelBudgetError';
    this.code = code;
    this.details = details;
  }
}

export class ModelBudgetStore {
  constructor(projectRoot, runId, options = {}) {
    this.projectRoot = path.resolve(String(projectRoot || '.'));
    this.runId = safeSegment(runId, 'runId');
    this.runDir = path.join(this.projectRoot, '.planning', 'runs', this.runId);
    this.storePath = path.join(this.runDir, 'MODEL-BUDGET.json');
    this.lockPath = path.join(this.runDir, '.model-budget.lock');
    const policyDefault = defaultMaxSolReservations();
    const requestedInitialLimit = options.maxSolReservations == null
      ? policyDefault
      : positiveInt(options.maxSolReservations, null);
    if (requestedInitialLimit > policyDefault) {
      throw new ModelBudgetError(
        'initial Sol budget cannot exceed policy default without explicit user approval',
        'MODEL_BUDGET_LIMIT_RAISE_REQUIRES_APPROVAL',
        {
          policyDefault,
          requestedInitialLimit,
        }
      );
    }
    this.defaultMaxSolReservations = requestedInitialLimit;
    this.lockTimeoutMs = positiveInt(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    this.staleLockMs = positiveInt(options.staleLockMs, DEFAULT_STALE_LOCK_MS);
  }

  async reserve(route, stageId, attemptId) {
    const normalizedRoute = validateBudgetRoute(route);
    const stage = safeSegment(stageId, 'stageId');
    const attempt = safeSegment(attemptId, 'attemptId');

    if (normalizedRoute.family !== 'sol') {
      return {
        status: 'not-required',
        runId: this.runId,
        stageId: stage,
        attemptId: attempt,
        route: normalizedRoute,
        consumed: false,
      };
    }

    const request = {
      runId: this.runId,
      stageId: stage,
      attemptId: attempt,
      role: normalizedRoute.role,
      routeLevel: normalizedRoute.routeLevel,
      model: normalizedRoute.model,
      reasoningEffort: normalizedRoute.reasoningEffort,
      escalationReasons: normalizedRoute.escalationReasons,
    };
    const requestFingerprint = stableHash(request);

    return this.#withStoreLock(async () => {
      const store = await this.#loadUnlocked({ createIfMissing: true });
      const sameAttempt = store.reservations.find(
        (item) => item.stageId === stage && item.attemptId === attempt
      );

      if (sameAttempt) {
        if (sameAttempt.requestFingerprint !== requestFingerprint) {
          throw new ModelBudgetError(
            'model budget attempt is already fenced to a different route',
            'MODEL_BUDGET_ATTEMPT_FENCED',
            {
              runId: this.runId,
              stageId: stage,
              attemptId: attempt,
              reservationId: sameAttempt.reservationId,
            }
          );
        }
        return {
          status: 'replayed',
          reservation: structuredClone(sameAttempt),
          authorization: authorizationFromReservation(sameAttempt),
          budget: budgetSummary(store),
          path: this.storePath,
        };
      }

      if (store.reservations.length >= store.maxSolReservations) {
        throw new ModelBudgetError(
          'automatic Sol budget is exhausted; explicit user approval is required to raise the run limit',
          'MODEL_BUDGET_USER_APPROVAL_REQUIRED',
          {
            runId: this.runId,
            initialMaxSolReservations: store.initialMaxSolReservations,
            maxSolReservations: store.maxSolReservations,
            usedSolReservations: store.reservations.length,
            requested: {
              stageId: stage,
              attemptId: attempt,
              role: normalizedRoute.role,
              routeLevel: normalizedRoute.routeLevel,
              model: normalizedRoute.model,
              reasoningEffort: normalizedRoute.reasoningEffort,
            },
          }
        );
      }

      const reservation = {
        reservationId: stableHash({
          runId: this.runId,
          stageId: stage,
          attemptId: attempt,
          requestFingerprint,
        }),
        requestFingerprint,
        runId: this.runId,
        stageId: stage,
        attemptId: attempt,
        role: normalizedRoute.role,
        routeLevel: normalizedRoute.routeLevel,
        model: normalizedRoute.model,
        reasoningEffort: normalizedRoute.reasoningEffort,
        escalationReasons: normalizedRoute.escalationReasons,
        reservedAt: new Date().toISOString(),
      };
      store.reservations.push(reservation);
      store.reservations.sort(compareReservation);
      await this.#writeUnlocked(store);

      return {
        status: 'reserved',
        reservation: structuredClone(reservation),
        authorization: authorizationFromReservation(reservation),
        budget: budgetSummary(store),
        path: this.storePath,
      };
    });
  }

  async verify(route, stageId, attemptId, authorization = null) {
    const normalizedRoute = validateBudgetRoute(route);
    const stage = safeSegment(stageId, 'stageId');
    const attempt = safeSegment(attemptId, 'attemptId');

    if (normalizedRoute.family !== 'sol') {
      return {
        valid: true,
        status: 'not-required',
        runId: this.runId,
        stageId: stage,
        attemptId: attempt,
      };
    }

    const request = {
      runId: this.runId,
      stageId: stage,
      attemptId: attempt,
      role: normalizedRoute.role,
      routeLevel: normalizedRoute.routeLevel,
      model: normalizedRoute.model,
      reasoningEffort: normalizedRoute.reasoningEffort,
      escalationReasons: normalizedRoute.escalationReasons,
    };
    const requestFingerprint = stableHash(request);
    const store = await this.#loadUnlocked({ createIfMissing: false });
    const reservation = store?.reservations?.find(
      (item) => item.stageId === stage && item.attemptId === attempt
    );
    if (!reservation) {
      throw new ModelBudgetError(
        'Sol execution has no durable model budget reservation',
        'MODEL_BUDGET_RESERVATION_REQUIRED',
        { runId: this.runId, stageId: stage, attemptId: attempt }
      );
    }
    if (reservation.requestFingerprint !== requestFingerprint) {
      throw new ModelBudgetError(
        'Sol execution route does not match its model budget reservation',
        'MODEL_BUDGET_RESERVATION_MISMATCH',
        {
          runId: this.runId,
          stageId: stage,
          attemptId: attempt,
          reservationId: reservation.reservationId,
        }
      );
    }

    const expectedAuthorization = authorizationFromReservation(reservation);
    if (authorization == null) {
      throw new ModelBudgetError(
        'Sol execution requires the exact model budget authorization returned by reservation',
        'MODEL_BUDGET_AUTHORIZATION_REQUIRED',
        { reservationId: reservation.reservationId }
      );
    }
    if (canonical(expectedAuthorization) !== canonical(authorization)) {
      throw new ModelBudgetError(
        'model budget authorization was modified after reservation',
        'MODEL_BUDGET_AUTHORIZATION_TAMPERED',
        { reservationId: reservation.reservationId }
      );
    }

    return {
      valid: true,
      status: 'reserved',
      reservation: structuredClone(reservation),
      authorization: expectedAuthorization,
      budget: budgetSummary(store),
      path: this.storePath,
    };
  }

  async approveLimit(receipt) {
    validateModelBudgetApprovalReceipt(receipt, { runId: this.runId });

    return this.#withStoreLock(async () => {
      const store = await this.#loadUnlocked({ createIfMissing: true });
      const existing = store.limitApprovals.find(
        (item) => item.approvalId === receipt.approvalId
      );
      if (existing) {
        if (existing.receiptHash !== receipt.receiptHash) {
          throw new ModelBudgetError(
            'model budget approval id is already fenced to different content',
            'MODEL_BUDGET_APPROVAL_FENCED',
            { approvalId: receipt.approvalId }
          );
        }
        return {
          status: 'replayed',
          budget: budgetSummary(store),
          approval: structuredClone(existing),
          path: this.storePath,
        };
      }

      if (receipt.currentLimit !== store.maxSolReservations) {
        throw new ModelBudgetError(
          'model budget approval was issued for a different current limit',
          'MODEL_BUDGET_APPROVAL_LIMIT_MISMATCH',
          {
            expectedCurrentLimit: store.maxSolReservations,
            receiptCurrentLimit: receipt.currentLimit,
          }
        );
      }
      if (receipt.newLimit <= store.maxSolReservations) {
        throw new ModelBudgetError(
          'model budget approval must strictly increase the run limit',
          'MODEL_BUDGET_APPROVAL_INVALID_LIMIT',
          {
            currentLimit: store.maxSolReservations,
            newLimit: receipt.newLimit,
          }
        );
      }

      store.maxSolReservations = receipt.newLimit;
      store.limitApprovals.push(structuredClone(receipt));
      await this.#writeUnlocked(store);

      return {
        status: 'approved',
        budget: budgetSummary(store),
        approval: structuredClone(receipt),
        path: this.storePath,
      };
    });
  }

  async list() {
    const store = await this.#loadUnlocked({ createIfMissing: false });
    if (!store) {
      return {
        schema: MODEL_BUDGET_SCHEMA,
        runId: this.runId,
        initialMaxSolReservations: this.defaultMaxSolReservations,
        maxSolReservations: this.defaultMaxSolReservations,
        usedSolReservations: 0,
        remainingSolReservations: this.defaultMaxSolReservations,
        reservations: [],
        limitApprovals: [],
        path: this.storePath,
      };
    }
    return {
      ...budgetSummary(store),
      reservations: store.reservations.map((item) => structuredClone(item)),
      limitApprovals: store.limitApprovals.map((item) => structuredClone(item)),
      path: this.storePath,
    };
  }

  async #loadUnlocked(options = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.storePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (options.createIfMissing !== true) return null;
        return {
          schema: MODEL_BUDGET_SCHEMA,
          runId: this.runId,
          initialMaxSolReservations: this.defaultMaxSolReservations,
          maxSolReservations: this.defaultMaxSolReservations,
          reservations: [],
          limitApprovals: [],
        };
      }
      throw error;
    }

    let store;
    try {
      store = JSON.parse(raw);
    } catch {
      throw new ModelBudgetError(
        'model budget store contains invalid JSON',
        'MODEL_BUDGET_STORE_CORRUPT'
      );
    }
    validateBudgetStore(store, this.runId);
    return store;
  }

  async #writeUnlocked(store) {
    validateBudgetStore(store, this.runId);
    await fs.mkdir(this.runDir, { recursive: true });
    const temp =
      this.storePath +
      '.tmp-' +
      process.pid +
      '-' +
      Date.now() +
      '-' +
      Math.random().toString(16).slice(2);
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(store, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
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
    const startedAt = Date.now();
    let handle = null;

    while (!handle) {
      try {
        handle = await fs.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + '\n',
          'utf8'
        );
        await handle.sync();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.#removeStaleLockIfSafe();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new ModelBudgetError(
            'timed out acquiring model budget store lock',
            'MODEL_BUDGET_LOCK_TIMEOUT',
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
        const parsed = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
        if (Number.isInteger(parsed?.pid) && parsed.pid > 0) ownerPid = parsed.pid;
      } catch {
        // A malformed owner record is reclaimable only after the stale-age bound.
      }

      if (ownerPid && processIsAlive(ownerPid)) return;
      await fs.rm(this.lockPath, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function createModelBudgetApprovalReceipt(input = {}) {
  const runId = safeSegment(input.runId, 'runId');
  const approvalId = safeSegment(input.approvalId, 'approvalId');
  const approvedBy = String(input.approvedBy ?? '').trim();
  if (approvedBy !== 'user') {
    throw new ModelBudgetError(
      'model budget limit approval must be explicitly attributed to user',
      'MODEL_BUDGET_APPROVER_INVALID'
    );
  }
  const currentLimit = positiveInt(input.currentLimit, null);
  const newLimit = positiveInt(input.newLimit, null);
  if (newLimit <= currentLimit) {
    throw new ModelBudgetError(
      'new model budget limit must be greater than current limit',
      'MODEL_BUDGET_APPROVAL_INVALID_LIMIT'
    );
  }
  const approvedAt = normalizeTimestamp(input.approvedAt);
  const receipt = {
    schema: MODEL_BUDGET_APPROVAL_SCHEMA,
    approvalId,
    approvedBy,
    approvedAt,
    runId,
    currentLimit,
    newLimit,
  };
  receipt.receiptHash = modelBudgetApprovalHash(receipt);
  return Object.freeze(receipt);
}

export function validateModelBudgetApprovalReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ModelBudgetError(
      'model budget approval receipt must be an object',
      'MODEL_BUDGET_APPROVAL_INVALID'
    );
  }
  if (receipt.schema !== MODEL_BUDGET_APPROVAL_SCHEMA) {
    throw new ModelBudgetError(
      'model budget approval receipt has invalid schema',
      'MODEL_BUDGET_APPROVAL_INVALID'
    );
  }

  const normalized = createModelBudgetApprovalReceipt(receipt);
  if (receipt.receiptHash !== normalized.receiptHash) {
    throw new ModelBudgetError(
      'model budget approval receipt hash mismatch',
      'MODEL_BUDGET_APPROVAL_INVALID'
    );
  }
  if (expected.runId && normalized.runId !== expected.runId) {
    throw new ModelBudgetError(
      'model budget approval belongs to a different run',
      'MODEL_BUDGET_APPROVAL_RUN_MISMATCH',
      { expectedRunId: expected.runId, actualRunId: normalized.runId }
    );
  }
  return true;
}

export function modelBudgetApprovalHash(receipt) {
  return stableHash({
    schema: receipt.schema,
    approvalId: receipt.approvalId,
    approvedBy: receipt.approvedBy,
    approvedAt: receipt.approvedAt,
    runId: receipt.runId,
    currentLimit: receipt.currentLimit,
    newLimit: receipt.newLimit,
  });
}

export function validateBudgetRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new ModelBudgetError('route must be an object', 'MODEL_BUDGET_ROUTE_INVALID');
  }
  const role = safeSegment(route.role, 'role');
  const routeLevel = String(route.routeLevel ?? '').trim();
  const level = MODEL_ROUTING_POLICY.levels?.[routeLevel];
  if (!level) {
    throw new ModelBudgetError(
      'unknown route level for model budget: ' + routeLevel,
      'MODEL_BUDGET_ROUTE_INVALID'
    );
  }

  const model = String(route.model ?? route.attemptedModel ?? '').trim();
  const reasoningEffort = String(route.reasoningEffort ?? '').trim();
  try {
    validateModelSelection(model, reasoningEffort);
  } catch (error) {
    throw new ModelBudgetError(
      'route failed model selection validation: ' + error.message,
      'MODEL_BUDGET_ROUTE_INVALID',
      { causeCode: error?.code || null }
    );
  }

  const actualFamily = modelFamily(model);
  if (actualFamily !== level.family) {
    throw new ModelBudgetError(
      'route model family does not match route level family',
      'MODEL_BUDGET_ROUTE_FAMILY_MISMATCH',
      {
        routeLevel,
        routeFamily: level.family,
        model,
        modelFamily: actualFamily,
      }
    );
  }

  return {
    role,
    routeLevel,
    family: actualFamily,
    model,
    reasoningEffort,
    escalationReasons: [...new Set(
      Array.isArray(route.escalationReasons)
        ? route.escalationReasons.map(String).filter(Boolean)
        : []
    )].sort(),
  };
}

function validateBudgetStore(store, runId) {
  const errors = [];
  if (store?.schema !== MODEL_BUDGET_SCHEMA) errors.push('invalid schema');
  if (store?.runId !== runId) errors.push('runId mismatch');
  const policyDefault = defaultMaxSolReservations();
  if (
    !Number.isInteger(store?.initialMaxSolReservations) ||
    store.initialMaxSolReservations < 1 ||
    store.initialMaxSolReservations > policyDefault
  ) {
    errors.push('invalid initialMaxSolReservations');
  }
  if (!Number.isInteger(store?.maxSolReservations) || store.maxSolReservations < 1) {
    errors.push('invalid maxSolReservations');
  }
  if (!Array.isArray(store?.reservations)) errors.push('missing reservations');
  if (!Array.isArray(store?.limitApprovals)) errors.push('missing limitApprovals');

  const attempts = new Set();
  if (Array.isArray(store?.reservations)) {
    for (const item of store.reservations) {
      const key = String(item?.stageId || '') + '\0' + String(item?.attemptId || '');
      if (!item?.reservationId || !item?.requestFingerprint || attempts.has(key)) {
        errors.push('invalid or duplicate reservation');
        continue;
      }
      attempts.add(key);
      try {
        const route = validateBudgetRoute(item);
        if (route.family !== 'sol') errors.push('non-Sol reservation stored');
        const request = {
          runId,
          stageId: item.stageId,
          attemptId: item.attemptId,
          role: route.role,
          routeLevel: route.routeLevel,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          escalationReasons: route.escalationReasons,
        };
        const expectedFingerprint = stableHash(request);
        const expectedReservationId = stableHash({
          runId,
          stageId: item.stageId,
          attemptId: item.attemptId,
          requestFingerprint: expectedFingerprint,
        });
        if (item.requestFingerprint !== expectedFingerprint) {
          errors.push('reservation fingerprint mismatch');
        }
        if (item.reservationId !== expectedReservationId) {
          errors.push('reservation id mismatch');
        }
      } catch {
        errors.push('invalid stored route');
      }
    }
    if (
      Number.isInteger(store?.maxSolReservations) &&
      store.reservations.length > store.maxSolReservations
    ) {
      errors.push('reservations exceed current limit');
    }
  }

  const approvalIds = new Set();
  let derivedLimit = store?.initialMaxSolReservations;
  if (Array.isArray(store?.limitApprovals)) {
    for (const receipt of store.limitApprovals) {
      if (approvalIds.has(receipt?.approvalId)) {
        errors.push('duplicate limit approval');
        continue;
      }
      approvalIds.add(receipt?.approvalId);
      try {
        validateModelBudgetApprovalReceipt(receipt, { runId });
        if (receipt.currentLimit !== derivedLimit || receipt.newLimit <= derivedLimit) {
          errors.push('broken limit approval chain');
        } else {
          derivedLimit = receipt.newLimit;
        }
      } catch {
        errors.push('invalid limit approval');
      }
    }
  }
  if (
    Number.isInteger(store?.maxSolReservations) &&
    Number.isInteger(derivedLimit) &&
    store.maxSolReservations !== derivedLimit
  ) {
    errors.push('maxSolReservations does not match approval chain');
  }

  if (errors.length) {
    throw new ModelBudgetError(
      'model budget store validation failed: ' + errors.join('; '),
      'MODEL_BUDGET_STORE_CORRUPT',
      { errors }
    );
  }
  return true;
}

function authorizationFromReservation(reservation) {
  return Object.freeze({
    schema: MODEL_BUDGET_AUTHORIZATION_SCHEMA,
    reservationId: reservation.reservationId,
    runId: reservation.runId,
    stageId: reservation.stageId,
    attemptId: reservation.attemptId,
    role: reservation.role,
    routeLevel: reservation.routeLevel,
    model: reservation.model,
    reasoningEffort: reservation.reasoningEffort,
    requestFingerprint: reservation.requestFingerprint,
  });
}

function budgetSummary(store) {
  return {
    schema: MODEL_BUDGET_SCHEMA,
    runId: store.runId,
    initialMaxSolReservations: store.initialMaxSolReservations,
    maxSolReservations: store.maxSolReservations,
    usedSolReservations: store.reservations.length,
    remainingSolReservations: Math.max(
      0,
      store.maxSolReservations - store.reservations.length
    ),
  };
}

function defaultMaxSolReservations() {
  return positiveInt(
    MODEL_ROUTING_POLICY.budget_policy?.default_max_sol_reservations_per_run,
    3
  );
}

function modelFamily(model) {
  const families = new Set(
    Object.values(MODEL_ROUTING_POLICY.levels || {})
      .filter((level) => level?.model === model)
      .map((level) => level.family)
  );
  return families.size === 1 ? [...families][0] : null;
}

function compareReservation(left, right) {
  return (
    left.stageId.localeCompare(right.stageId) ||
    left.attemptId.localeCompare(right.attemptId) ||
    left.reservationId.localeCompare(right.reservationId)
  );
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

function positiveInt(value, fallback) {
  if (value == null && fallback != null) return positiveInt(fallback, null);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new ModelBudgetError(
      'model budget limit must be a positive integer',
      'MODEL_BUDGET_LIMIT_INVALID'
    );
  }
  return number;
}

function normalizeTimestamp(value) {
  const text = String(value ?? '').trim();
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) {
    throw new ModelBudgetError(
      'model budget approval timestamp is invalid',
      'MODEL_BUDGET_APPROVAL_INVALID'
    );
  }
  return new Date(milliseconds).toISOString();
}

function safeSegment(value, field) {
  const text = String(value ?? '').trim();
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    throw new ModelBudgetError(
      field + ' must be a safe identifier',
      'MODEL_BUDGET_IDENTIFIER_INVALID',
      { field }
    );
  }
  return text;
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
