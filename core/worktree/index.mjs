import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const OWNER_FILENAME = 'hybrid-worktree-owner.json';
const OWNER_SCHEMA = 'hybrid-worktree-owner/v2';
const INTEGRATION_SCHEMA = 'hybrid-worktree-integration/v1';

export class WorktreeRuntimeError extends Error {
  constructor(message, code = 'WORKTREE_RUNTIME_ERROR', details = {}) {
    super(message);
    this.name = 'WorktreeRuntimeError';
    this.code = code;
    this.details = details;
  }
}

export async function createWorktreeWave({
  repoRoot,
  tasks,
  baseRef = 'HEAD',
  tempRoot = null,
  runId = null,
  revisionId = null,
  graphHash = null,
}) {
  const normalizedRoot = path.resolve(String(repoRoot || ''));
  const normalizedTasks = normalizeTasks(tasks);
  if (!normalizedTasks.length) {
    throw new WorktreeRuntimeError('worktree wave requires at least one task', 'INVALID_WORKTREE_WAVE');
  }

  await assertCleanRepository(normalizedRoot);
  const baseCommit = await revParse(normalizedRoot, baseRef);
  const initialWorktrees = await listGitWorktrees(normalizedRoot);
  const root = tempRoot
    ? path.resolve(tempRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-worktrees-'));
  await fs.mkdir(root, { recursive: true });

  const worktrees = [];
  try {
    for (const task of normalizedTasks) {
      const worktreePath = path.join(root, safeName(task.id));
      await runGit(normalizedRoot, ['worktree', 'add', '--detach', worktreePath, baseCommit]);
      const owner = await bindWorktreeOwner(worktreePath, {
        runId,
        revisionId,
        graphHash,
        taskId: task.id,
        agentRunId: task.agentRunId || task.agent_run_id || null,
        attemptId: task.attemptId,
        leaseId: task.leaseId,
        baseCommit,
      });
      worktrees.push({
        task,
        taskId: task.id,
        path: worktreePath,
        owner,
      });
    }
  } catch (error) {
    await cleanupWorktreeWave({
      repoRoot: normalizedRoot,
      root,
      worktrees,
      initialWorktrees,
    }, { suppressErrors: true });
    throw wrapError(error, 'WORKTREE_CREATE_FAILED');
  }

  return {
    schema: 'hybrid-worktree-wave/v1',
    repoRoot: normalizedRoot,
    baseCommit,
    root,
    initialWorktrees,
    worktrees,
    runId,
    revisionId,
    graphHash,
  };
}

export async function collectWorktreeResults(handle) {
  validateHandle(handle);
  const results = [];

  for (const worktree of handle.worktrees) {
    const observedOwner = await readWorktreeOwner(worktree.path);
    if (!ownerMatches(worktree.owner, observedOwner)) {
      throw new WorktreeRuntimeError(
        'worktree ownership metadata does not match the execution handle for task ' + worktree.taskId,
        'WORKTREE_OWNER_MISMATCH',
        { taskId: worktree.taskId, expected: worktree.owner, observed: observedOwner }
      );
    }

    // Intent-to-add makes new files visible to git diff without staging content.
    await runGit(worktree.path, ['add', '-N', '.']);
    const changedFiles = lines((await runGit(worktree.path, ['diff', '--name-only', 'HEAD'])).stdout);
    const allowed = new Set(worktree.task.files_modified.map(normalizeRepoPath));
    const outsideOwnership = changedFiles
      .map(normalizeRepoPath)
      .filter((file) => !allowed.has(file));

    if (outsideOwnership.length) {
      throw new WorktreeRuntimeError(
        'worker changed files outside declared ownership: ' + outsideOwnership.join(', '),
        'WORKTREE_OWNERSHIP_VIOLATION',
        { taskId: worktree.taskId, outsideOwnership }
      );
    }

    const patch = (await runGit(worktree.path, ['diff', '--binary', '--full-index', 'HEAD'])).stdout;
    const patchPath = path.join(handle.root, '.hybrid-' + safeName(worktree.taskId) + '.patch');
    await fs.writeFile(patchPath, patch, 'utf8');
    const patchHash = createHash('sha256').update(patch).digest('hex');

    results.push({
      taskId: worktree.taskId,
      agentRunId: observedOwner.agentRunId,
      attemptId: observedOwner.attemptId,
      leaseId: observedOwner.leaseId,
      worktreePath: worktree.path,
      baseCommit: handle.baseCommit,
      changedFiles,
      patchPath,
      patchBytes: Buffer.byteLength(patch),
      patchHash,
      attribution: 'observed',
      owner: observedOwner,
    });
  }

  return {
    ...handle,
    results,
  };
}

export async function integrateWorktreeResults(handleWithResults) {
  validateHandle(handleWithResults);
  if (!Array.isArray(handleWithResults.results)) {
    throw new WorktreeRuntimeError(
      'collectWorktreeResults must run before integration',
      'WORKTREE_RESULTS_MISSING'
    );
  }

  const orderedResults = await orderedIntegrationResults(handleWithResults);
  const descriptor = integrationQueueDescriptor(handleWithResults, orderedResults);
  const journalPath = await integrationJournalPath(
    handleWithResults.repoRoot,
    descriptor.queueId
  );
  const integrationLock = await acquireIntegrationLock(journalPath);
  try {
    let state = await loadIntegrationJournal(journalPath, { missingOk: true });

    const currentHead = await revParse(handleWithResults.repoRoot, 'HEAD');
    if (currentHead !== handleWithResults.baseCommit) {
      throw new WorktreeRuntimeError(
        'main repository HEAD changed after worktree creation',
        'WORKTREE_BASE_MOVED',
        { expected: handleWithResults.baseCommit, actual: currentHead }
      );
    }

    if (!state) {
      await assertCleanRepository(handleWithResults.repoRoot);
      state = {
        ...descriptor,
        status: 'pending',
        nextIndex: 0,
        currentTaskId: null,
        preWorkspaceHash: null,
        applied: [],
        finalWorkspaceHash: null,
        lastError: null,
      };
      await writeIntegrationJournal(journalPath, state);
    } else {
      validateIntegrationJournal(state, descriptor);
    }

    state = await reconcileIntegrationJournal(
      handleWithResults,
      orderedResults,
      journalPath,
      state
    );

    if (state.status === 'completed') {
      return {
        ...handleWithResults,
        integrated: state.applied.map(publicIntegratedRecord),
        integrationQueue: integrationQueueSummary(state, journalPath, 'replayed'),
      };
    }

    if (state.status === 'rolled-back') {
      const currentHash = await workspaceDiffHash(handleWithResults.repoRoot);
      if (currentHash !== emptyDiffHash()) {
        throw new WorktreeRuntimeError(
          'rolled-back integration journal does not match repository state',
          'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
          { queueId: state.queueId, currentHash }
        );
      }
      state = {
        ...state,
        status: 'pending',
        nextIndex: 0,
        currentTaskId: null,
        preWorkspaceHash: null,
        applied: [],
        finalWorkspaceHash: null,
        lastError: null,
      };
      await writeIntegrationJournal(journalPath, state);
    }

    try {
      while (state.nextIndex < orderedResults.length) {
        const index = state.nextIndex;
        const result = orderedResults[index];
        const preWorkspaceHash = await workspaceDiffHash(handleWithResults.repoRoot);
        const expectedPreHash = index === 0
          ? emptyDiffHash()
          : state.applied[index - 1]?.workspaceHash;
        if (!expectedPreHash || preWorkspaceHash !== expectedPreHash) {
          throw new WorktreeRuntimeError(
            'integration workspace does not match the durable queue prefix',
            'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
            {
              queueId: state.queueId,
              taskId: result.taskId,
              expectedWorkspaceHash: expectedPreHash || null,
              actualWorkspaceHash: preWorkspaceHash,
            }
          );
        }

        state = {
          ...state,
          status: 'applying',
          currentTaskId: result.taskId,
          preWorkspaceHash,
          lastError: null,
        };
        await writeIntegrationJournal(journalPath, state);

        await runGit(handleWithResults.repoRoot, ['apply', '--check', result.patchPath]);
        await runGit(handleWithResults.repoRoot, ['apply', result.patchPath]);

        const workspaceHash = await workspaceDiffHash(handleWithResults.repoRoot);
        const record = integratedRecord(result, workspaceHash, index);
        state = {
          ...state,
          status: index + 1 === orderedResults.length ? 'completed' : 'pending',
          nextIndex: index + 1,
          currentTaskId: null,
          preWorkspaceHash: null,
          applied: [...state.applied, record],
          finalWorkspaceHash: index + 1 === orderedResults.length ? workspaceHash : null,
        };
        await writeIntegrationJournal(journalPath, state);
      }
    } catch (error) {
      if (
        error instanceof WorktreeRuntimeError &&
        error.code === 'WORKTREE_INTEGRATION_RECONCILE_REQUIRED'
      ) {
        throw error;
      }

      await rollbackIntegration(handleWithResults);
      const rolledBack = {
        ...state,
        status: 'rolled-back',
        nextIndex: 0,
        currentTaskId: null,
        preWorkspaceHash: null,
        applied: [],
        finalWorkspaceHash: null,
        lastError: {
          code: error?.code || null,
          message: String(error?.message || error),
        },
      };
      await writeIntegrationJournal(journalPath, rolledBack);

      if (error instanceof WorktreeRuntimeError && error.code === 'WORKTREE_EMPTY_RESULT') {
        throw error;
      }
      throw new WorktreeRuntimeError(
        'worktree integration conflict or apply failure: ' + error.message,
        'WORKTREE_INTEGRATION_CONFLICT',
        {
          queueId: state.queueId,
          integrated: state.applied.map(publicIntegratedRecord),
          causeCode: error?.code || null,
          journalPath,
        }
      );
    }

    return {
      ...handleWithResults,
      integrated: state.applied.map(publicIntegratedRecord),
      integrationQueue: integrationQueueSummary(state, journalPath, 'committed'),
    };
  } finally {
    await releaseIntegrationLock(integrationLock);
  }
}

export async function readIntegrationJournal(repoRoot, queueId) {
  const journalPath = await integrationJournalPath(repoRoot, queueId);
  const state = await loadIntegrationJournal(journalPath);
  validateIntegrationJournal(state, descriptorFromJournalState(state));
  if (state.queueId !== queueId) {
    throw new WorktreeRuntimeError(
      'integration journal path does not match its queue identity',
      'WORKTREE_INTEGRATION_JOURNAL_FENCED',
      {
        expectedQueueId: queueId,
        observedQueueId: state.queueId,
        journalPath,
      }
    );
  }
  return state;
}

export async function findCompletedWorktreeIntegration({
  repoRoot,
  runId,
  revisionId,
  graphHash,
  taskId,
  attemptId,
  leaseId,
} = {}) {
  const root = path.resolve(String(repoRoot || ''));
  const expected = {
    runId: nullableString(runId),
    revisionId: nullableString(revisionId),
    graphHash: nullableString(graphHash),
    taskId: String(taskId || '').trim(),
    attemptId: String(attemptId || '').trim(),
    leaseId: String(leaseId || '').trim(),
  };
  if (
    !expected.runId ||
    !expected.revisionId ||
    !expected.graphHash ||
    !expected.taskId ||
    !expected.attemptId ||
    !expected.leaseId
  ) {
    throw new WorktreeRuntimeError(
      'completed integration lookup requires run/revision/graph/task/attempt/lease identity',
      'WORKTREE_INTEGRATION_IDENTITY_REQUIRED',
      { expected }
    );
  }

  const journalDir = await integrationJournalDirectory(root);
  let entries;
  try {
    entries = await fs.readdir(journalDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  const matches = [];
  for (const entry of entries
    .filter((item) => item.isFile() && /^[0-9a-f]{64}\.json$/.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const journalPath = path.join(journalDir, entry.name);
    const state = await loadIntegrationJournal(journalPath);
    validateIntegrationJournal(state, descriptorFromJournalState(state));
    const pathQueueId = entry.name.slice(0, -'.json'.length);
    if (state.queueId !== pathQueueId) {
      throw new WorktreeRuntimeError(
        'integration journal path does not match its queue identity',
        'WORKTREE_INTEGRATION_JOURNAL_FENCED',
        {
          expectedQueueId: pathQueueId,
          observedQueueId: state.queueId,
          journalPath,
        }
      );
    }
    if (
      state.status !== 'completed' ||
      (state.runId ?? null) !== expected.runId ||
      (state.revisionId ?? null) !== expected.revisionId ||
      (state.graphHash ?? null) !== expected.graphHash
    ) {
      continue;
    }

    const record = state.applied.find(
      (item) =>
        item.taskId === expected.taskId &&
        item.attemptId === expected.attemptId &&
        item.leaseId === expected.leaseId
    );
    if (!record) continue;

    const currentHead = await revParse(root, 'HEAD');
    if (currentHead !== state.baseCommit) {
      throw new WorktreeRuntimeError(
        'completed integration evidence no longer matches repository HEAD',
        'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
        {
          queueId: state.queueId,
          expectedHead: state.baseCommit,
          actualHead: currentHead,
        }
      );
    }
    const currentHash = await workspaceDiffHash(root);
    if (currentHash !== state.finalWorkspaceHash) {
      throw new WorktreeRuntimeError(
        'completed integration evidence no longer matches the current workspace',
        'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
        {
          queueId: state.queueId,
          expectedWorkspaceHash: state.finalWorkspaceHash,
          actualWorkspaceHash: currentHash,
        }
      );
    }

    matches.push({
      schema: 'hybrid-worktree-integration-receipt/v1',
      queueId: state.queueId,
      journalPath,
      runId: state.runId,
      revisionId: state.revisionId,
      graphHash: state.graphHash,
      baseCommit: state.baseCommit,
      finalWorkspaceHash: state.finalWorkspaceHash,
      record: publicIntegratedRecord(record),
    });
  }

  if (matches.length > 1) {
    throw new WorktreeRuntimeError(
      'multiple completed integration journals claim the same task attempt lease',
      'WORKTREE_INTEGRATION_AMBIGUOUS',
      {
        taskId: expected.taskId,
        attemptId: expected.attemptId,
        leaseId: expected.leaseId,
        queueIds: matches.map((item) => item.queueId),
      }
    );
  }
  return matches[0] ?? null;
}

async function orderedIntegrationResults(handle) {
  const expectedTaskIds = [...handle.worktrees]
    .map((worktree) => String(worktree.taskId || ''))
    .sort((left, right) => left.localeCompare(right));
  const resultByTask = new Map();

  for (const result of handle.results) {
    const taskId = String(result?.taskId || '');
    if (!taskId || resultByTask.has(taskId)) {
      throw new WorktreeRuntimeError(
        'worktree results contain duplicate or missing task identity',
        'WORKTREE_RESULTS_INVALID',
        { taskId: taskId || null }
      );
    }
    resultByTask.set(taskId, result);
  }

  const actualIds = [...resultByTask.keys()].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedTaskIds)) {
    throw new WorktreeRuntimeError(
      'worktree result set does not match the integration wave',
      'WORKTREE_RESULTS_INVALID',
      { expectedTaskIds, actualTaskIds: actualIds }
    );
  }

  const ordered = [];
  for (const taskId of expectedTaskIds) {
    const result = resultByTask.get(taskId);
    if (!result.patchBytes) {
      throw new WorktreeRuntimeError(
        'worker produced no patch for task ' + taskId,
        'WORKTREE_EMPTY_RESULT',
        { taskId }
      );
    }
    const patch = await fs.readFile(result.patchPath);
    const observedPatchHash = createHash('sha256').update(patch).digest('hex');
    if (
      observedPatchHash !== result.patchHash ||
      patch.byteLength !== result.patchBytes ||
      result.baseCommit !== handle.baseCommit
    ) {
      throw new WorktreeRuntimeError(
        'worktree patch handoff changed after collection for task ' + taskId,
        'WORKTREE_PATCH_TAMPERED',
        {
          taskId,
          expectedPatchHash: result.patchHash,
          observedPatchHash,
          expectedPatchBytes: result.patchBytes,
          observedPatchBytes: patch.byteLength,
        }
      );
    }
    ordered.push(result);
  }
  return ordered;
}

function integrationQueueDescriptor(handle, orderedResults) {
  const order = orderedResults.map((result, index) => ({
    index,
    taskId: result.taskId,
    agentRunId: result.agentRunId || null,
    attemptId: result.attemptId,
    leaseId: result.leaseId,
    patchHash: result.patchHash,
    patchBytes: result.patchBytes,
    changedFiles: [...result.changedFiles].sort(),
  }));
  const identity = {
    baseCommit: handle.baseCommit,
    runId: handle.runId || null,
    revisionId: handle.revisionId || null,
    graphHash: handle.graphHash || null,
    order,
  };
  return {
    schema: INTEGRATION_SCHEMA,
    queueId: createHash('sha256').update(canonical(identity)).digest('hex'),
    ...identity,
  };
}

async function integrationJournalPath(repoRoot, queueId) {
  if (!/^[0-9a-f]{64}$/.test(String(queueId || ''))) {
    throw new WorktreeRuntimeError(
      'integration queue id must be a sha256 digest',
      'WORKTREE_INTEGRATION_JOURNAL_INVALID'
    );
  }
  return path.join(
    await integrationJournalDirectory(repoRoot),
    queueId + '.json'
  );
}

async function integrationJournalDirectory(repoRoot) {
  const commonDirRaw = (
    await runGit(repoRoot, ['rev-parse', '--git-common-dir'])
  ).stdout.trim();
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.resolve(repoRoot, commonDirRaw);
  return path.join(commonDir, 'hybrid', 'integration');
}

function descriptorFromJournalState(state) {
  const identity = {
    baseCommit: state?.baseCommit,
    runId: state?.runId ?? null,
    revisionId: state?.revisionId ?? null,
    graphHash: state?.graphHash ?? null,
    order: state?.order,
  };
  return {
    schema: INTEGRATION_SCHEMA,
    queueId: createHash('sha256').update(canonical(identity)).digest('hex'),
    ...identity,
  };
}

async function loadIntegrationJournal(journalPath, options = {}) {
  let raw;
  try {
    raw = await fs.readFile(journalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && options.missingOk === true) return null;
    if (error?.code === 'ENOENT') {
      throw new WorktreeRuntimeError(
        'integration journal is missing',
        'WORKTREE_INTEGRATION_JOURNAL_MISSING',
        { journalPath }
      );
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new WorktreeRuntimeError(
      'integration journal contains invalid JSON',
      'WORKTREE_INTEGRATION_JOURNAL_CORRUPT',
      { journalPath }
    );
  }
}

function validateIntegrationJournal(state, descriptor) {
  const identity = {
    schema: state?.schema,
    queueId: state?.queueId,
    baseCommit: state?.baseCommit,
    runId: state?.runId ?? null,
    revisionId: state?.revisionId ?? null,
    graphHash: state?.graphHash ?? null,
    order: state?.order,
  };
  if (canonical(identity) !== canonical(descriptor)) {
    throw new WorktreeRuntimeError(
      'integration journal identity does not match the current patch queue',
      'WORKTREE_INTEGRATION_JOURNAL_FENCED',
      { expected: descriptor, observed: identity }
    );
  }
  if (!['pending', 'applying', 'completed', 'rolled-back'].includes(state.status)) {
    throw new WorktreeRuntimeError(
      'integration journal has an invalid status',
      'WORKTREE_INTEGRATION_JOURNAL_CORRUPT',
      { status: state.status }
    );
  }
  if (!Number.isInteger(state.nextIndex) || state.nextIndex < 0 || state.nextIndex > descriptor.order.length) {
    throw new WorktreeRuntimeError(
      'integration journal has an invalid nextIndex',
      'WORKTREE_INTEGRATION_JOURNAL_CORRUPT',
      { nextIndex: state.nextIndex }
    );
  }
  if (!Array.isArray(state.applied) || state.applied.length !== state.nextIndex) {
    throw new WorktreeRuntimeError(
      'integration journal applied prefix is inconsistent',
      'WORKTREE_INTEGRATION_JOURNAL_CORRUPT'
    );
  }
  for (let index = 0; index < state.applied.length; index++) {
    const record = state.applied[index];
    const expected = descriptor.order[index];
    const valid =
      record?.index === index &&
      record?.taskId === expected?.taskId &&
      (record?.agentRunId ?? null) === (expected?.agentRunId ?? null) &&
      record?.attemptId === expected?.attemptId &&
      record?.leaseId === expected?.leaseId &&
      record?.baseCommit === descriptor.baseCommit &&
      record?.patchHash === expected?.patchHash &&
      record?.patchBytes === expected?.patchBytes &&
      canonical([...(record?.changedFiles || [])].sort()) === canonical(expected?.changedFiles || []) &&
      record?.attribution === 'observed' &&
      /^[0-9a-f]{64}$/.test(String(record?.workspaceHash || ''));
    if (!valid) {
      throw new WorktreeRuntimeError(
        'integration journal contains an invalid applied record',
        'WORKTREE_INTEGRATION_JOURNAL_CORRUPT',
        { index, taskId: record?.taskId || null }
      );
    }
  }
  if (state.status === 'completed') {
    const finalRecord = state.applied[state.applied.length - 1];
    if (
      state.nextIndex !== descriptor.order.length ||
      !finalRecord ||
      state.finalWorkspaceHash !== finalRecord.workspaceHash
    ) {
      throw new WorktreeRuntimeError(
        'completed integration journal has an invalid final snapshot',
        'WORKTREE_INTEGRATION_JOURNAL_CORRUPT'
      );
    }
  }
  return true;
}

async function reconcileIntegrationJournal(handle, orderedResults, journalPath, state) {
  const currentHash = await workspaceDiffHash(handle.repoRoot);

  if (state.status === 'completed') {
    if (
      state.nextIndex !== orderedResults.length ||
      state.applied.length !== orderedResults.length ||
      currentHash !== state.finalWorkspaceHash
    ) {
      throw new WorktreeRuntimeError(
        'completed integration journal does not match the current workspace',
        'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
        {
          queueId: state.queueId,
          expectedWorkspaceHash: state.finalWorkspaceHash,
          actualWorkspaceHash: currentHash,
        }
      );
    }
    return state;
  }

  if (state.status === 'rolled-back') return state;

  const expectedPrefixHash = state.nextIndex === 0
    ? emptyDiffHash()
    : state.applied[state.nextIndex - 1]?.workspaceHash;

  if (state.status === 'pending') {
    if (!expectedPrefixHash || currentHash !== expectedPrefixHash) {
      throw new WorktreeRuntimeError(
        'integration workspace diverged from the durable applied prefix',
        'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
        {
          queueId: state.queueId,
          expectedWorkspaceHash: expectedPrefixHash || null,
          actualWorkspaceHash: currentHash,
        }
      );
    }
    return state;
  }

  const result = orderedResults[state.nextIndex];
  if (!result || state.currentTaskId !== result.taskId || state.preWorkspaceHash !== expectedPrefixHash) {
    throw new WorktreeRuntimeError(
      'in-flight integration journal does not identify the expected next patch',
      'WORKTREE_INTEGRATION_JOURNAL_CORRUPT',
      { queueId: state.queueId, currentTaskId: state.currentTaskId }
    );
  }

  if (currentHash === state.preWorkspaceHash) {
    return state;
  }

  const reverseApplied = await gitCommandSucceeds(
    handle.repoRoot,
    ['apply', '--reverse', '--check', result.patchPath]
  );
  if (!reverseApplied) {
    throw new WorktreeRuntimeError(
      'cannot prove whether the in-flight integration patch was applied',
      'WORKTREE_INTEGRATION_RECONCILE_REQUIRED',
      { queueId: state.queueId, taskId: result.taskId, currentHash }
    );
  }

  const recovered = integratedRecord(result, currentHash, state.nextIndex);
  const nextIndex = state.nextIndex + 1;
  const next = {
    ...state,
    status: nextIndex === orderedResults.length ? 'completed' : 'pending',
    nextIndex,
    currentTaskId: null,
    preWorkspaceHash: null,
    applied: [...state.applied, recovered],
    finalWorkspaceHash: nextIndex === orderedResults.length ? currentHash : null,
  };
  await writeIntegrationJournal(journalPath, next);
  return next;
}

function integratedRecord(result, workspaceHash, index) {
  return {
    index,
    taskId: result.taskId,
    agentRunId: result.agentRunId || null,
    attemptId: result.attemptId,
    leaseId: result.leaseId,
    baseCommit: result.baseCommit,
    changedFiles: [...result.changedFiles],
    patchBytes: result.patchBytes,
    patchHash: result.patchHash,
    workspaceHash,
    attribution: 'observed',
  };
}

function publicIntegratedRecord(record) {
  return { ...record };
}

function integrationQueueSummary(state, journalPath, disposition) {
  return {
    schema: state.schema,
    queueId: state.queueId,
    status: state.status,
    disposition,
    baseCommit: state.baseCommit,
    orderedTaskIds: state.order.map((entry) => entry.taskId),
    appliedCount: state.applied.length,
    finalWorkspaceHash: state.finalWorkspaceHash,
    journalPath,
  };
}

async function workspaceDiffHash(repoRoot) {
  const trackedDiff = (await runGit(
    repoRoot,
    ['diff', '--binary', '--full-index', 'HEAD']
  )).stdout;
  const untrackedRaw = (await runGit(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z']
  )).stdout;
  const untracked = [];
  for (const relativePath of untrackedRaw.split('\0').filter(Boolean).sort()) {
    const absolutePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      untracked.push({
        path: normalizeRepoPath(relativePath),
        kind: 'symlink',
        contentHash: createHash('sha256').update(await fs.readlink(absolutePath)).digest('hex'),
      });
      continue;
    }
    if (stat.isFile()) {
      untracked.push({
        path: normalizeRepoPath(relativePath),
        kind: 'file',
        contentHash: createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex'),
      });
      continue;
    }
    untracked.push({
      path: normalizeRepoPath(relativePath),
      kind: 'other',
      contentHash: null,
    });
  }
  return createHash('sha256')
    .update(canonical({ trackedDiff, untracked }))
    .digest('hex');
}

function emptyDiffHash() {
  return createHash('sha256')
    .update(canonical({ trackedDiff: '', untracked: [] }))
    .digest('hex');
}

async function gitCommandSucceeds(cwd, args) {
  try {
    await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

async function acquireIntegrationLock(journalPath, options = {}) {
  const lockPath = journalPath + '.lock';
  const timeoutMs = Number(options.timeoutMs ?? 30000);
  const pollMs = Number(options.pollMs ?? 25);
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }) + '\n', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lockPath, pid: process.pid };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ownerPid = await integrationLockOwnerPid(lockPath);
      if (ownerPid && !processIsAlive(ownerPid)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (!ownerPid && await unknownIntegrationLockIsStale(lockPath)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new WorktreeRuntimeError(
          'timed out waiting for the integration queue lock',
          'WORKTREE_INTEGRATION_LOCK_TIMEOUT',
          { lockPath, ownerPid }
        );
      }
      await sleep(pollMs);
    }
  }
}

async function releaseIntegrationLock(lock) {
  if (!lock?.lockPath) return;
  const ownerPid = await integrationLockOwnerPid(lock.lockPath);
  if (ownerPid !== lock.pid) {
    throw new WorktreeRuntimeError(
      'integration lock ownership changed before release',
      'WORKTREE_INTEGRATION_LOCK_FENCED',
      { lockPath: lock.lockPath, expectedPid: lock.pid, observedPid: ownerPid }
    );
  }
  await fs.rm(lock.lockPath, { force: true });
}

async function integrationLockOwnerPid(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function unknownIntegrationLockIsStale(lockPath) {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > 5000;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
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

async function writeIntegrationJournal(journalPath, value) {
  await fs.mkdir(path.dirname(journalPath), { recursive: true });
  const temp = journalPath + '.tmp-' + process.pid + '-' + Date.now();
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, journalPath);
}

export async function cleanupWorktreeWave(handle, options = {}) {
  if (!handle?.repoRoot) return { removed: [], remaining: [] };
  const removed = [];
  const errors = [];

  for (const worktree of [...(handle.worktrees || [])].reverse()) {
    try {
      await runGit(handle.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
      removed.push(worktree.path);
    } catch (error) {
      errors.push({ path: worktree.path, error: error.message });
    }
  }

  try {
    await runGit(handle.repoRoot, ['worktree', 'prune']);
  } catch (error) {
    errors.push({ path: handle.repoRoot, error: error.message });
  }

  if (handle.root) {
    try {
      await fs.rm(handle.root, { recursive: true, force: true });
    } catch (error) {
      errors.push({ path: handle.root, error: error.message });
    }
  }

  const remaining = await listGitWorktrees(handle.repoRoot).catch(() => []);
  if (errors.length && options.suppressErrors !== true) {
    throw new WorktreeRuntimeError(
      'worktree cleanup failed',
      'WORKTREE_CLEANUP_FAILED',
      { errors, removed, remaining }
    );
  }

  return { removed, remaining, errors };
}

export async function readWorktreeOwner(worktreePath) {
  const metadataPath = await worktreeOwnerMetadataPath(worktreePath);
  let raw;
  try {
    raw = await fs.readFile(metadataPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new WorktreeRuntimeError(
        'worktree ownership metadata is missing',
        'WORKTREE_OWNER_MISSING',
        { worktreePath, metadataPath }
      );
    }
    throw error;
  }

  let owner;
  try {
    owner = JSON.parse(raw);
  } catch (error) {
    throw new WorktreeRuntimeError(
      'worktree ownership metadata is invalid JSON',
      'WORKTREE_OWNER_CORRUPT',
      { worktreePath, metadataPath }
    );
  }
  if (
    owner?.schema !== OWNER_SCHEMA ||
    typeof owner.taskId !== 'string' ||
    !owner.taskId ||
    typeof owner.attemptId !== 'string' ||
    !owner.attemptId ||
    typeof owner.leaseId !== 'string' ||
    !owner.leaseId ||
    typeof owner.baseCommit !== 'string' ||
    !owner.baseCommit
  ) {
    throw new WorktreeRuntimeError(
      'worktree ownership metadata has an invalid schema',
      'WORKTREE_OWNER_CORRUPT',
      { worktreePath, metadataPath }
    );
  }
  return owner;
}

export async function listGitWorktrees(repoRoot) {
  const output = (await runGit(repoRoot, ['worktree', 'list', '--porcelain'])).stdout;
  const entries = [];
  let current = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export async function assertCleanRepository(repoRoot) {
  const status = (await runGit(repoRoot, ['status', '--porcelain'])).stdout.trim();
  if (status) {
    throw new WorktreeRuntimeError(
      'worktree runtime requires a clean integration workspace',
      'WORKTREE_DIRTY_BASE',
      { status }
    );
  }
  return true;
}

async function bindWorktreeOwner(worktreePath, input) {
  const metadataPath = await worktreeOwnerMetadataPath(worktreePath);
  const owner = {
    schema: OWNER_SCHEMA,
    runId: nullableString(input.runId),
    revisionId: nullableString(input.revisionId),
    graphHash: nullableString(input.graphHash),
    taskId: String(input.taskId || ''),
    agentRunId: nullableString(input.agentRunId),
    attemptId: String(input.attemptId || ''),
    leaseId: String(input.leaseId || ''),
    baseCommit: String(input.baseCommit || ''),
  };
  if (!owner.taskId || !owner.attemptId || !owner.leaseId || !owner.baseCommit) {
    throw new WorktreeRuntimeError(
      'worktree owner requires taskId, attemptId, leaseId, and baseCommit',
      'WORKTREE_OWNER_INVALID',
      { owner }
    );
  }

  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  try {
    const handle = await fs.open(metadataPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner, null, 2) + '\n', 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readWorktreeOwner(worktreePath);
    if (!ownerMatches(owner, existing)) {
      throw new WorktreeRuntimeError(
        'worktree already belongs to a different execution owner',
        'WORKTREE_OWNER_CONFLICT',
        { worktreePath, expected: owner, observed: existing }
      );
    }
  }
  return owner;
}

async function worktreeOwnerMetadataPath(worktreePath) {
  const raw = (await runGit(worktreePath, ['rev-parse', '--git-path', OWNER_FILENAME])).stdout.trim();
  if (!raw) {
    throw new WorktreeRuntimeError(
      'git did not return a worktree metadata path',
      'WORKTREE_OWNER_PATH_MISSING',
      { worktreePath }
    );
  }
  return path.isAbsolute(raw) ? raw : path.resolve(worktreePath, raw);
}

function ownerMatches(expected, observed) {
  if (!expected || !observed) return false;
  return [
    'schema',
    'runId',
    'revisionId',
    'graphHash',
    'taskId',
    'agentRunId',
    'attemptId',
    'leaseId',
    'baseCommit',
  ].every((key) => (expected[key] ?? null) === (observed[key] ?? null));
}

function nullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

async function rollbackIntegration(handle) {
  await runGit(handle.repoRoot, ['reset', '--hard', handle.baseCommit]);
  await runGit(handle.repoRoot, ['clean', '-fd']);
}

async function revParse(repoRoot, ref) {
  return (await runGit(repoRoot, ['rev-parse', ref])).stdout.trim();
}

async function runGit(cwd, args) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error).trim();
    throw new WorktreeRuntimeError(
      'git ' + args.join(' ') + ' failed' + (detail ? ': ' + detail : ''),
      'GIT_WORKTREE_COMMAND_FAILED',
      { cwd, args, detail }
    );
  }
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new WorktreeRuntimeError('tasks must be an array', 'INVALID_WORKTREE_WAVE');
  }
  const ids = new Set();
  return tasks.map((task) => {
    const id = String(task?.id || '').trim();
    if (!id || ids.has(id)) {
      throw new WorktreeRuntimeError('worktree task ids must be unique and non-empty', 'INVALID_WORKTREE_WAVE');
    }
    ids.add(id);
    const files = [...new Set((task.files_modified || []).map(normalizeRepoPath).filter(Boolean))];
    if (!files.length) {
      throw new WorktreeRuntimeError('worktree task requires files_modified: ' + id, 'INVALID_WORKTREE_WAVE');
    }
    const attemptId = String(task.attemptId || '').trim();
    const leaseId = String(task.leaseId || '').trim();
    if (!attemptId || !leaseId) {
      throw new WorktreeRuntimeError(
        'worktree task requires attemptId and leaseId: ' + id,
        'WORKTREE_AUTHORITY_IDENTITY_REQUIRED',
        { taskId: id }
      );
    }
    return { ...task, id, attemptId, leaseId, files_modified: files };
  });
}

function validateHandle(handle) {
  if (!handle || handle.schema !== 'hybrid-worktree-wave/v1' || !handle.repoRoot || !handle.baseCommit) {
    throw new WorktreeRuntimeError('invalid worktree runtime handle', 'INVALID_WORKTREE_HANDLE');
  }
}

function normalizeRepoPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

function wrapError(error, code) {
  if (error instanceof WorktreeRuntimeError) return error;
  return new WorktreeRuntimeError(String(error?.message || error), code);
}
