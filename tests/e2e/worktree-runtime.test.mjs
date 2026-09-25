import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cleanupWorktreeWave,
  collectWorktreeResults,
  createWorktreeWave,
  integrateWorktreeResults,
  listGitWorktrees,
  readWorktreeOwner,
} from '../../core/worktree/index.mjs';
import { validateWorktreeSmokeReport } from '../../scripts/worktree-runtime-smoke.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, encoding: 'utf8' });
}

async function fixture(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-worktree-test-'));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Hybrid Test']);
  await git(root, ['config', 'user.email', 'hybrid-test@example.invalid']);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'baseline']);
  return root;
}

test('worktree bridge creates isolated paths, integrates owned patches, and cleans up', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/b.js': 'export const b = 0;\n',
  });

  const handle = await createWorktreeWave({
    repoRoot: root,
    runId: 'run-1',
    revisionId: 'graph-2',
    graphHash: 'hash-abc',
    tasks: [
      { id: 'a', agentRunId: 'agent-a', files_modified: ['src/a.js'] },
      { id: 'b', agentRunId: 'agent-b', files_modified: ['src/b.js'] },
    ],
  });

  assert.equal(handle.worktrees.length, 2);
  assert.notEqual(handle.worktrees[0].path, handle.worktrees[1].path);
  assert.equal((await listGitWorktrees(root)).length, 3);
  assert.deepEqual(await readWorktreeOwner(handle.worktrees[0].path), {
    schema: 'hybrid-worktree-owner/v1',
    runId: 'run-1',
    revisionId: 'graph-2',
    graphHash: 'hash-abc',
    taskId: 'a',
    agentRunId: 'agent-a',
    baseCommit: handle.baseCommit,
  });

  await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 1;\n');
  await fs.writeFile(path.join(handle.worktrees[1].path, 'src/b.js'), 'export const b = 2;\n');

  const collected = await collectWorktreeResults(handle);
  assert.deepEqual(collected.results.map((x) => x.changedFiles), [['src/a.js'], ['src/b.js']]);
  assert.ok(collected.results.every((x) => /^[0-9a-f]{64}$/.test(x.patchHash)));
  assert.ok(collected.results.every((x) => x.attribution === 'observed'));
  assert.deepEqual(collected.results.map((x) => x.agentRunId), ['agent-a', 'agent-b']);

  const integrated = await integrateWorktreeResults(collected);
  assert.equal(integrated.integrated.length, 2);
  assert.ok(integrated.integrated.every((x) => x.attribution === 'observed'));
  assert.deepEqual(
    integrated.integrated.map((x) => x.patchHash),
    collected.results.map((x) => x.patchHash)
  );
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await fs.readFile(path.join(root, 'src/b.js'), 'utf8'), 'export const b = 2;\n');

  const cleanup = await cleanupWorktreeWave(integrated);
  assert.equal(cleanup.remaining.length, 1);
  assert.equal(cleanup.remaining[0].path, root);

  const status = (await git(root, ['status', '--short'])).stdout.trimEnd().split(/\r?\n/).sort();
  assert.deepEqual(status, [' M src/a.js', ' M src/b.js']);
});

test('worktree bridge fails closed on ownership escape before integration', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/other.js': 'export const other = 0;\n',
  });

  const handle = await createWorktreeWave({
    repoRoot: root,
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/other.js'), 'export const other = 99;\n');
    await assert.rejects(
      () => collectWorktreeResults(handle),
      (error) => error.code === 'WORKTREE_OWNERSHIP_VIOLATION'
    );
    assert.equal((await git(root, ['status', '--porcelain'])).stdout.trim(), '');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('worktree result collection rejects tampered execution ownership metadata', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });

  const handle = await createWorktreeWave({
    repoRoot: root,
    runId: 'run-owner',
    revisionId: 'revision-1',
    graphHash: 'graph-hash',
    tasks: [{ id: 'a', agentRunId: 'agent-a', files_modified: ['src/a.js'] }],
  });

  try {
    const worktreePath = handle.worktrees[0].path;
    const metadataRaw = (await git(worktreePath, [
      'rev-parse',
      '--git-path',
      'hybrid-worktree-owner.json',
    ])).stdout.trim();
    const metadataPath = path.isAbsolute(metadataRaw)
      ? metadataRaw
      : path.resolve(worktreePath, metadataRaw);
    const owner = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    owner.taskId = 'different-task';
    await fs.writeFile(metadataPath, JSON.stringify(owner, null, 2) + '\n');
    await fs.writeFile(path.join(worktreePath, 'src/a.js'), 'export const a = 1;\n');

    await assert.rejects(
      () => collectWorktreeResults(handle),
      (error) => error.code === 'WORKTREE_OWNER_MISMATCH'
    );
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('worktree integration conflict rolls main workspace back instead of overwriting silently', async () => {
  const root = await fixture({
    'src/shared.js': 'export const value = 0;\n',
  });

  const handle = await createWorktreeWave({
    repoRoot: root,
    tasks: [
      { id: 'first', files_modified: ['src/shared.js'] },
      { id: 'second', files_modified: ['src/shared.js'] },
    ],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/shared.js'), 'export const value = 1;\n');
    await fs.writeFile(path.join(handle.worktrees[1].path, 'src/shared.js'), 'export const value = 2;\n');

    const collected = await collectWorktreeResults(handle);
    await assert.rejects(
      () => integrateWorktreeResults(collected),
      (error) => error.code === 'WORKTREE_INTEGRATION_CONFLICT'
    );

    assert.equal(
      await fs.readFile(path.join(root, 'src/shared.js'), 'utf8'),
      'export const value = 0;\n'
    );
    assert.equal((await git(root, ['status', '--porcelain'])).stdout.trim(), '');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }

  assert.equal((await listGitWorktrees(root)).length, 1);
});


test('worktree semantic validator refuses exit-zero style fake success without filesystem/git/verifier evidence', () => {
  const fake = validateWorktreeSmokeReport({
    preflight: { isolation: [{ mode: 'worktree' }] },
    workspace: '/tmp/fake-main',
    duringWorktrees: [
      { path: '/tmp/fake-main' },
      { path: '/tmp/fake-a' },
      { path: '/tmp/fake-b' },
    ],
    workers: [
      { taskId: 'alpha', worktreePath: '/tmp/fake-a', exitCode: 0, timedOut: false, delegationObserved: false },
      { taskId: 'beta', worktreePath: '/tmp/fake-b', exitCode: 0, timedOut: false, delegationObserved: false },
    ],
    parallelOverlap: true,
    handoff: [],
    integration: [],
    finalFiles: {
      alpha: 'export const alpha = 1;\n',
      beta: 'export const beta = 2;\n',
    },
    verifier: { exitCode: 0, timedOut: false, delegationObserved: false, commandEvidence: false },
    cleanup: {
      errors: [],
      finalWorktrees: [{ path: '/tmp/fake-main' }],
      worktreeRootExists: false,
    },
    finalGitStatus: [' M src/alpha.js', ' M src/beta.js'],
    runtimeError: null,
  });

  assert.equal(fake.ok, false);
  assert.ok(fake.errors.some((error) => /patch handoff/.test(error)));
  assert.ok(fake.errors.some((error) => /integrated/.test(error)));
  assert.ok(fake.errors.some((error) => /command evidence/.test(error)));
});
