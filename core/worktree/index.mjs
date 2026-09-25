import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const OWNER_FILENAME = 'hybrid-worktree-owner.json';
const OWNER_SCHEMA = 'hybrid-worktree-owner/v1';

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
    throw new WorktreeRuntimeError('collectWorktreeResults must run before integration', 'WORKTREE_RESULTS_MISSING');
  }

  await assertCleanRepository(handleWithResults.repoRoot);
  const currentHead = await revParse(handleWithResults.repoRoot, 'HEAD');
  if (currentHead !== handleWithResults.baseCommit) {
    throw new WorktreeRuntimeError(
      'main repository HEAD changed after worktree creation',
      'WORKTREE_BASE_MOVED',
      { expected: handleWithResults.baseCommit, actual: currentHead }
    );
  }

  const integrated = [];
  try {
    for (const result of handleWithResults.results) {
      if (!result.patchBytes) {
        throw new WorktreeRuntimeError(
          'worker produced no patch for task ' + result.taskId,
          'WORKTREE_EMPTY_RESULT',
          { taskId: result.taskId }
        );
      }

      await runGit(handleWithResults.repoRoot, ['apply', '--check', result.patchPath]);
      await runGit(handleWithResults.repoRoot, ['apply', result.patchPath]);
      integrated.push({
        taskId: result.taskId,
        agentRunId: result.agentRunId || null,
        baseCommit: result.baseCommit || handleWithResults.baseCommit,
        changedFiles: result.changedFiles,
        patchBytes: result.patchBytes,
        patchHash: result.patchHash,
        attribution: 'observed',
      });
    }
  } catch (error) {
    await rollbackIntegration(handleWithResults);
    if (error instanceof WorktreeRuntimeError && error.code === 'WORKTREE_EMPTY_RESULT') {
      throw error;
    }
    throw new WorktreeRuntimeError(
      'worktree integration conflict or apply failure: ' + error.message,
      'WORKTREE_INTEGRATION_CONFLICT',
      { integrated, causeCode: error?.code || null }
    );
  }

  return {
    ...handleWithResults,
    integrated,
  };
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
    baseCommit: String(input.baseCommit || ''),
  };
  if (!owner.taskId || !owner.baseCommit) {
    throw new WorktreeRuntimeError(
      'worktree owner requires taskId and baseCommit',
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
    return { ...task, id, files_modified: files };
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

function wrapError(error, code) {
  if (error instanceof WorktreeRuntimeError) return error;
  return new WorktreeRuntimeError(String(error?.message || error), code);
}
