import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
      worktrees.push({
        task,
        taskId: task.id,
        path: worktreePath,
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
  };
}

export async function collectWorktreeResults(handle) {
  validateHandle(handle);
  const results = [];

  for (const worktree of handle.worktrees) {
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

    results.push({
      taskId: worktree.taskId,
      worktreePath: worktree.path,
      changedFiles,
      patchPath,
      patchBytes: Buffer.byteLength(patch),
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
        changedFiles: result.changedFiles,
        patchBytes: result.patchBytes,
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
