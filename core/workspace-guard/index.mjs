import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateSealedExecutionGraph } from '../execution-graph/index.mjs';
import { ResourceLeaseStore } from '../leases/index.mjs';

const execFileAsync = promisify(execFile);
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

export const CURRENT_WORKSPACE_GUARD_SCHEMA = 'hybrid-current-workspace-guard/v1';
export const CURRENT_WORKSPACE_RESULT_SCHEMA = 'hybrid-current-workspace-result/v1';

export class WorkspaceGuardError extends Error {
  constructor(message, code = 'WORKSPACE_GUARD_ERROR', details = {}) {
    super(message);
    this.name = 'WorkspaceGuardError';
    this.code = code;
    this.details = details;
  }
}

export async function beginCurrentWorkspaceGuard({
  projectRoot,
  graph,
  authorization,
}) {
  const root = path.resolve(String(projectRoot || '.'));
  validateSealedExecutionGraph(graph);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await leaseStore.assertAuthorization(graph, authorization);
  return withWorkspaceGuardLock(root, () =>
    beginCurrentWorkspaceGuardUnlocked({ root, graph, authorization })
  );
}

async function beginCurrentWorkspaceGuardUnlocked({
  root,
  graph,
  authorization,
}) {
  const node = executableNode(graph, authorization.taskId);
  const identity = guardIdentity(graph, authorization);
  const guardId = stableHash(identity);
  const paths = await guardPaths(root, guardId);

  const completed = await readJson(paths.historyPath, { missingOk: true });
  if (completed) {
    validateCompletedHistory(completed, identity, guardId);
    throw new WorkspaceGuardError(
      'current-workspace task attempt already completed its mutation guard',
      'WORKSPACE_GUARD_ALREADY_COMPLETED',
      {
        guardId,
        taskId: authorization.taskId,
        attemptId: authorization.attemptId,
        historyPath: paths.historyPath,
      }
    );
  }

  const existing = await readJson(paths.currentPath, { missingOk: true });
  if (existing) {
    validateCurrentGuard(existing);
    if (canonical(existing.identity) !== canonical(identity)) {
      throw new WorkspaceGuardError(
        'another current-workspace writer already owns the repository mutation guard',
        'CURRENT_WORKSPACE_BUSY',
        publicCurrentGuard(existing, paths.currentPath)
      );
    }

    if (existing.status === 'initializing') {
      const baseline = await captureWorkspaceSnapshot(root);
      const activated = activeGuardState({
        guardId,
        identity,
        node,
        baseline,
      });
      await atomicJsonWrite(paths.currentPath, activated);
      return {
        status: 'recovered-initialization',
        guard: publicCurrentGuard(activated, paths.currentPath),
      };
    }

    if (existing.status !== 'active') {
      throw new WorkspaceGuardError(
        'current-workspace guard requires reconciliation before any redispatch',
        'WORKSPACE_GUARD_RECONCILIATION_REQUIRED',
        publicCurrentGuard(existing, paths.currentPath)
      );
    }

    return {
      status: 'replayed',
      guard: publicCurrentGuard(existing, paths.currentPath),
    };
  }

  await fs.mkdir(path.dirname(paths.currentPath), { recursive: true });
  const initializing = {
    schema: CURRENT_WORKSPACE_GUARD_SCHEMA,
    guardId,
    status: 'initializing',
    identity,
    allowedWrites: allowedWritesFor(node),
    baseline: null,
    observed: null,
    violation: null,
  };

  let handle;
  try {
    handle = await fs.open(paths.currentPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return beginCurrentWorkspaceGuardUnlocked({ root, graph, authorization });
    }
    throw error;
  }

  try {
    await handle.writeFile(JSON.stringify(initializing, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    const baseline = await captureWorkspaceSnapshot(root);
    const activated = activeGuardState({
      guardId,
      identity,
      node,
      baseline,
    });
    await atomicJsonWrite(paths.currentPath, activated);
    return {
      status: 'started',
      guard: publicCurrentGuard(activated, paths.currentPath),
    };
  } catch (error) {
    await fs.rm(paths.currentPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function completeCurrentWorkspaceGuard({
  projectRoot,
  graph,
  authorization,
}) {
  const root = path.resolve(String(projectRoot || '.'));
  validateSealedExecutionGraph(graph);
  const leaseStore = new ResourceLeaseStore(root, graph.runId);
  await leaseStore.assertAuthorization(graph, authorization);
  return withWorkspaceGuardLock(root, () =>
    completeCurrentWorkspaceGuardUnlocked({ root, graph, authorization })
  );
}

async function completeCurrentWorkspaceGuardUnlocked({
  root,
  graph,
  authorization,
}) {
  const node = executableNode(graph, authorization.taskId);
  const identity = guardIdentity(graph, authorization);
  const guardId = stableHash(identity);
  const paths = await guardPaths(root, guardId);

  const current = await readJson(paths.currentPath, { missingOk: true });
  if (!current) {
    const completedHistory = await readJson(paths.historyPath, { missingOk: true });
    if (completedHistory) {
      validateCompletedHistory(completedHistory, identity, guardId);
      return {
        status: 'replayed',
        result: structuredClone(completedHistory.result),
        historyPath: paths.historyPath,
      };
    }
    throw new WorkspaceGuardError(
      'current-workspace guard state is missing',
      'WORKSPACE_GUARD_MISSING',
      { path: paths.currentPath, guardId }
    );
  }
  validateCurrentGuard(current);
  if (
    current.guardId !== guardId ||
    canonical(current.identity) !== canonical(identity)
  ) {
    throw new WorkspaceGuardError(
      'current-workspace guard belongs to a different task attempt',
      'WORKSPACE_GUARD_FENCED',
      {
        expectedGuardId: guardId,
        observedGuardId: current.guardId || null,
      }
    );
  }
  if (!current.baseline || current.status === 'initializing') {
    throw new WorkspaceGuardError(
      'current-workspace guard baseline is not ready',
      'WORKSPACE_GUARD_NOT_READY',
      { guardId }
    );
  }

  const observed = await captureWorkspaceSnapshot(root);
  const changedFiles = changedPaths(current.baseline, observed);
  const allowedWrites = allowedWritesFor(node);
  const allowed = new Set(allowedWrites);
  const outsideWrites = changedFiles.filter((file) => !allowed.has(file));

  if (observed.head !== current.baseline.head) {
    const blocked = {
      ...current,
      status: 'reconcile-required',
      observed: snapshotSummary(observed),
      violation: {
        code: 'WORKSPACE_BASE_MOVED',
        expectedHead: current.baseline.head,
        actualHead: observed.head,
        changedFiles,
      },
    };
    await atomicJsonWrite(paths.currentPath, blocked);
    throw new WorkspaceGuardError(
      'repository HEAD changed while current-workspace task was active',
      'WORKSPACE_BASE_MOVED',
      {
        guardId,
        expectedHead: current.baseline.head,
        actualHead: observed.head,
        changedFiles,
      }
    );
  }

  if (outsideWrites.length) {
    const blocked = {
      ...current,
      status: 'write-set-violation',
      observed: snapshotSummary(observed),
      violation: {
        code: 'WRITE_SET_VIOLATION',
        changedFiles,
        allowedWrites,
        outsideWrites,
      },
    };
    await atomicJsonWrite(paths.currentPath, blocked);
    throw new WorkspaceGuardError(
      'current-workspace task changed files outside its sealed write set: ' +
        outsideWrites.join(', '),
      'WRITE_SET_VIOLATION',
      {
        guardId,
        taskId: authorization.taskId,
        attemptId: authorization.attemptId,
        changedFiles,
        allowedWrites,
        outsideWrites,
        currentPath: paths.currentPath,
      }
    );
  }

  const result = {
    schema: CURRENT_WORKSPACE_RESULT_SCHEMA,
    guardId,
    identity,
    baselineHash: current.baseline.snapshotHash,
    finalSnapshotHash: observed.snapshotHash,
    changedFiles,
    allowedWrites,
    attribution: 'observed',
  };
  const completed = {
    schema: CURRENT_WORKSPACE_GUARD_SCHEMA,
    guardId,
    status: 'completed',
    identity,
    allowedWrites,
    baseline: snapshotSummary(current.baseline),
    observed: snapshotSummary(observed),
    violation: null,
    result,
  };

  await fs.mkdir(path.dirname(paths.historyPath), { recursive: true });
  const existingHistory = await readJson(paths.historyPath, { missingOk: true });
  if (existingHistory) {
    validateCompletedHistory(existingHistory, identity, guardId);
    if (canonical(existingHistory.result) !== canonical(result)) {
      throw new WorkspaceGuardError(
        'completed workspace guard history conflicts with current observation',
        'WORKSPACE_GUARD_HISTORY_FENCED',
        { guardId, historyPath: paths.historyPath }
      );
    }
  } else {
    await atomicJsonWrite(paths.historyPath, completed);
  }

  const beforeRelease = await readJson(paths.currentPath, { missingOk: true });
  if (!beforeRelease) {
    const completedHistory = await readJson(paths.historyPath, { missingOk: true });
    validateCompletedHistory(completedHistory, identity, guardId);
    if (canonical(completedHistory.result) !== canonical(result)) {
      throw new WorkspaceGuardError(
        'completed workspace guard history conflicts with current observation',
        'WORKSPACE_GUARD_HISTORY_FENCED',
        { guardId, historyPath: paths.historyPath }
      );
    }
    return {
      status: 'replayed',
      result: structuredClone(completedHistory.result),
      historyPath: paths.historyPath,
    };
  }
  if (
    beforeRelease.guardId !== guardId ||
    canonical(beforeRelease.identity) !== canonical(identity)
  ) {
    throw new WorkspaceGuardError(
      'current-workspace guard ownership changed before release',
      'WORKSPACE_GUARD_FENCED',
      { guardId }
    );
  }
  await fs.rm(paths.currentPath);

  return {
    status: current.status === 'active' ? 'completed' : 'reconciled',
    result,
    historyPath: paths.historyPath,
  };
}

export async function inspectCurrentWorkspaceGuard(projectRoot) {
  const root = path.resolve(String(projectRoot || '.'));
  const commonDir = await gitCommonDir(root);
  const currentPath = path.join(
    commonDir,
    'hybrid',
    'current-workspace',
    'current.json'
  );
  const current = await readJson(currentPath, { missingOk: true });
  if (!current) {
    return {
      active: false,
      current: null,
      path: currentPath,
    };
  }
  validateCurrentGuard(current);
  return {
    active: true,
    current: publicCurrentGuard(current, currentPath),
    path: currentPath,
  };
}

export async function captureWorkspaceSnapshot(projectRoot) {
  const root = path.resolve(String(projectRoot || '.'));
  const head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
  if (!head) {
    throw new WorkspaceGuardError(
      'current-workspace guard requires a repository HEAD',
      'WORKSPACE_HEAD_REQUIRED'
    );
  }

  const tracked = await trackedVisiblePaths(root);
  const untrackedRaw = (
    await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).stdout;
  const untracked = splitNull(untrackedRaw).map(normalizeRepoPath);
  const visible = [...new Set([...tracked, ...untracked])].sort();
  const states = [];

  for (const relativePath of visible) {
    states.push(await pathState(root, relativePath));
  }

  const snapshot = {
    head,
    paths: states,
  };
  snapshot.snapshotHash = stableHash(snapshot);
  return snapshot;
}

function activeGuardState({ guardId, identity, node, baseline }) {
  return {
    schema: CURRENT_WORKSPACE_GUARD_SCHEMA,
    guardId,
    status: 'active',
    identity,
    allowedWrites: allowedWritesFor(node),
    baseline,
    observed: null,
    violation: null,
  };
}

function guardIdentity(graph, authorization) {
  return {
    runId: graph.runId,
    descriptorHash: graph.descriptorHash,
    graphRevision: graph.revisionId,
    taskId: authorization.taskId,
    attemptId: authorization.attemptId,
    leaseId: authorization.leaseId,
    requestFingerprint: authorization.requestFingerprint,
  };
}

function executableNode(graph, taskId) {
  const node = graph.nodes.find(
    (item) => item.id === taskId && item.kind === 'agent'
  );
  if (!node) {
    throw new WorkspaceGuardError(
      'workspace guard target is not an executable graph node: ' + taskId,
      'WORKSPACE_GUARD_TASK_NOT_FOUND'
    );
  }
  if (!Array.isArray(node.writes) || !node.writes.length) {
    throw new WorkspaceGuardError(
      'current-workspace mutation guard requires a task with a sealed write set',
      'WORKSPACE_GUARD_WRITE_SET_REQUIRED',
      { taskId }
    );
  }
  return node;
}

function allowedWritesFor(node) {
  return [...new Set(
    (node.writes || []).map(normalizeRepoPath).filter(Boolean)
  )].sort();
}

async function guardPaths(repoRoot, guardId) {
  const commonDir = await gitCommonDir(repoRoot);
  const root = path.join(commonDir, 'hybrid', 'current-workspace');
  return {
    currentPath: path.join(root, 'current.json'),
    historyPath: path.join(root, 'history', guardId + '.json'),
  };
}

async function withWorkspaceGuardLock(repoRoot, fn) {
  const commonDir = await gitCommonDir(repoRoot);
  const lockPath = path.join(
    commonDir,
    'hybrid',
    'current-workspace',
    '.guard.lock'
  );
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  let handle = null;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
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
      await removeStaleWorkspaceGuardLock(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new WorkspaceGuardError(
          'timed out acquiring current-workspace mutation guard lock',
          'WORKSPACE_GUARD_LOCK_TIMEOUT',
          { lockPath }
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await releaseWorkspaceGuardLock(lockPath, process.pid);
  }
}

async function releaseWorkspaceGuardLock(lockPath, expectedPid) {
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
    throw new WorkspaceGuardError(
      'current-workspace mutation guard lock ownership changed',
      'WORKSPACE_GUARD_LOCK_FENCED',
      { lockPath, expectedPid, observedPid: ownerPid }
    );
  }
  await fs.rm(lockPath, { force: true });
}

async function removeStaleWorkspaceGuardLock(lockPath) {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return;

    let ownerPid = null;
    try {
      const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (Number.isInteger(parsed?.pid) && parsed.pid > 0) {
        ownerPid = parsed.pid;
      }
    } catch {
      // Unknown ownership is reclaimable only after the stale-age bound.
    }

    if (ownerPid && processIsAlive(ownerPid)) return;
    await fs.rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function gitCommonDir(repoRoot) {
  let value;
  try {
    value = (await runGit(repoRoot, ['rev-parse', '--git-common-dir'])).stdout.trim();
  } catch (error) {
    throw new WorkspaceGuardError(
      'current-workspace mutation guard requires a Git repository',
      'WORKSPACE_GIT_REQUIRED',
      { cause: String(error?.message || error) }
    );
  }
  return path.isAbsolute(value)
    ? value
    : path.resolve(repoRoot, value);
}

async function trackedVisiblePaths(repoRoot) {
  const raw = (
    await runGit(repoRoot, ['diff', '--name-status', '-z', 'HEAD', '--'])
  ).stdout;
  const tokens = splitNull(raw);
  const paths = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from) paths.push(normalizeRepoPath(from));
      if (to) paths.push(normalizeRepoPath(to));
      continue;
    }
    const file = tokens[index++];
    if (file) paths.push(normalizeRepoPath(file));
  }

  return [...new Set(paths)].sort();
}

async function pathState(repoRoot, relativePath) {
  const normalized = normalizeRepoPath(relativePath);
  const absolute = path.join(repoRoot, normalized);
  const diff = (
    await runGit(repoRoot, [
      'diff',
      '--binary',
      '--full-index',
      'HEAD',
      '--',
      normalized,
    ])
  ).stdout;

  let fsState;
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      fsState = {
        kind: 'symlink',
        mode: stat.mode & 0o777,
        contentHash: sha256(await fs.readlink(absolute)),
      };
    } else if (stat.isFile()) {
      fsState = {
        kind: 'file',
        mode: stat.mode & 0o777,
        contentHash: sha256(await fs.readFile(absolute)),
      };
    } else {
      fsState = {
        kind: 'other',
        mode: stat.mode & 0o777,
        contentHash: null,
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fsState = {
      kind: 'missing',
      mode: null,
      contentHash: null,
    };
  }

  const value = {
    path: normalized,
    diffHash: sha256(diff),
    ...fsState,
  };
  value.fingerprint = stableHash(value);
  return value;
}

function changedPaths(before, after) {
  const left = new Map(
    (before.paths || []).map((item) => [item.path, item.fingerprint])
  );
  const right = new Map(
    (after.paths || []).map((item) => [item.path, item.fingerprint])
  );
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.filter((file) => left.get(file) !== right.get(file));
}

function snapshotSummary(snapshot) {
  return {
    head: snapshot.head,
    snapshotHash: snapshot.snapshotHash,
    paths: (snapshot.paths || []).map((item) => ({
      path: item.path,
      fingerprint: item.fingerprint,
    })),
  };
}

function validateCurrentGuard(value) {
  const errors = [];
  if (value?.schema !== CURRENT_WORKSPACE_GUARD_SCHEMA) errors.push('invalid schema');
  if (typeof value?.guardId !== 'string' || !/^[0-9a-f]{64}$/.test(value.guardId)) {
    errors.push('invalid guardId');
  }
  if (!['initializing', 'active', 'write-set-violation', 'reconcile-required'].includes(value?.status)) {
    errors.push('invalid status');
  }
  if (!value?.identity || typeof value.identity !== 'object') errors.push('missing identity');
  if (!Array.isArray(value?.allowedWrites)) errors.push('invalid allowedWrites');
  if (value?.status !== 'initializing' && !value?.baseline) errors.push('missing baseline');

  if (errors.length) {
    throw new WorkspaceGuardError(
      'current-workspace guard state is corrupt: ' + errors.join('; '),
      'WORKSPACE_GUARD_CORRUPT',
      { errors }
    );
  }
  return true;
}

function validateCompletedHistory(value, identity, guardId) {
  if (
    value?.schema !== CURRENT_WORKSPACE_GUARD_SCHEMA ||
    value?.status !== 'completed' ||
    value?.guardId !== guardId ||
    canonical(value?.identity) !== canonical(identity) ||
    value?.result?.schema !== CURRENT_WORKSPACE_RESULT_SCHEMA
  ) {
    throw new WorkspaceGuardError(
      'current-workspace guard history is corrupt or fenced',
      'WORKSPACE_GUARD_HISTORY_FENCED',
      { guardId }
    );
  }
  return true;
}

function publicCurrentGuard(value, currentPath) {
  return {
    schema: value.schema,
    guardId: value.guardId,
    status: value.status,
    identity: structuredClone(value.identity),
    allowedWrites: [...value.allowedWrites],
    baselineHash: value.baseline?.snapshotHash || null,
    observedHash: value.observed?.snapshotHash || null,
    violation: value.violation ? structuredClone(value.violation) : null,
    currentPath,
  };
}

async function readJson(filePath, options = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && options.missingOk === true) return null;
    if (error?.code === 'ENOENT') {
      throw new WorkspaceGuardError(
        'current-workspace guard state is missing',
        'WORKSPACE_GUARD_MISSING',
        { path: filePath }
      );
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new WorkspaceGuardError(
      'current-workspace guard state contains invalid JSON',
      'WORKSPACE_GUARD_CORRUPT',
      { path: filePath }
    );
  }
}

async function atomicJsonWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp =
    filePath +
    '.tmp-' +
    process.pid +
    '-' +
    Date.now() +
    '-' +
    Math.random().toString(16).slice(2);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function runGit(cwd, args) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    throw new WorkspaceGuardError(
      'git ' + args.join(' ') + ' failed: ' +
        String(error?.stderr || error?.message || error).trim(),
      'WORKSPACE_GIT_FAILED',
      {
        args,
        exitCode: error?.code ?? null,
      }
    );
  }
}

function splitNull(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function normalizeRepoPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableHash(value) {
  return sha256(canonical(value));
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

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + canonical(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
