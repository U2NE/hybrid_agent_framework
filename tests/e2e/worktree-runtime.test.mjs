import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  cleanupWorktreeWave,
  collectWorktreeResults,
  createWorktreeWave,
  findCompletedWorktreeIntegration,
  integrateWorktreeResults,
  listGitWorktrees,
  readIntegrationJournal,
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

async function createAuthorizedWorktreeWave(input) {
  return createWorktreeWave({
    ...input,
    tasks: (input.tasks || []).map((task) => ({
      attemptId: task.attemptId || 'attempt-' + task.id,
      leaseId: task.leaseId || 'lease-' + task.id,
      ...task,
    })),
  });
}

test('worktree bridge rejects mutating tasks without attempt and lease identity', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });

  await assert.rejects(
    () => createWorktreeWave({
      repoRoot: root,
      tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
    }),
    (error) => error.code === 'WORKTREE_AUTHORITY_IDENTITY_REQUIRED'
  );
});

test('worktree bridge creates isolated paths, integrates owned patches, and cleans up', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/b.js': 'export const b = 0;\n',
  });

  const handle = await createAuthorizedWorktreeWave({
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
    schema: 'hybrid-worktree-owner/v2',
    runId: 'run-1',
    revisionId: 'graph-2',
    graphHash: 'hash-abc',
    taskId: 'a',
    agentRunId: 'agent-a',
    attemptId: 'attempt-a',
    leaseId: 'lease-a',
    baseCommit: handle.baseCommit,
  });

  await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 1;\n');
  await fs.writeFile(path.join(handle.worktrees[1].path, 'src/b.js'), 'export const b = 2;\n');

  const collected = await collectWorktreeResults(handle);
  assert.deepEqual(collected.results.map((x) => x.changedFiles), [['src/a.js'], ['src/b.js']]);
  assert.ok(collected.results.every((x) => /^[0-9a-f]{64}$/.test(x.patchHash)));
  assert.ok(collected.results.every((x) => x.attribution === 'observed'));
  assert.deepEqual(collected.results.map((x) => x.agentRunId), ['agent-a', 'agent-b']);
  assert.deepEqual(collected.results.map((x) => x.attemptId), ['attempt-a', 'attempt-b']);
  assert.deepEqual(collected.results.map((x) => x.leaseId), ['lease-a', 'lease-b']);

  const completionOrderIndependent = {
    ...collected,
    results: [...collected.results].reverse(),
  };
  const integrated = await integrateWorktreeResults(completionOrderIndependent);
  assert.equal(integrated.integrated.length, 2);
  assert.ok(integrated.integrated.every((x) => x.attribution === 'observed'));
  assert.deepEqual(integrated.integrated.map((x) => x.taskId), ['a', 'b']);
  assert.deepEqual(
    integrated.integrated.map((x) => x.patchHash),
    collected.results.map((x) => x.patchHash)
  );
  assert.equal(integrated.integrationQueue.status, 'completed');
  assert.equal(integrated.integrationQueue.disposition, 'committed');
  assert.deepEqual(integrated.integrationQueue.orderedTaskIds, ['a', 'b']);
  assert.match(integrated.integrationQueue.queueId, /^[0-9a-f]{64}$/);
  assert.match(integrated.integrationQueue.finalWorkspaceHash, /^[0-9a-f]{64}$/);

  const receipt = await findCompletedWorktreeIntegration({
    repoRoot: root,
    runId: 'run-1',
    revisionId: 'graph-2',
    graphHash: 'hash-abc',
    taskId: 'a',
    attemptId: 'attempt-a',
    leaseId: 'lease-a',
  });
  assert.equal(receipt.schema, 'hybrid-worktree-integration-receipt/v1');
  assert.equal(receipt.queueId, integrated.integrationQueue.queueId);
  assert.equal(receipt.record.taskId, 'a');
  assert.equal(receipt.record.attemptId, 'attempt-a');
  assert.equal(receipt.record.leaseId, 'lease-a');
  assert.equal(
    receipt.finalWorkspaceHash,
    integrated.integrationQueue.finalWorkspaceHash
  );
  assert.equal(
    await findCompletedWorktreeIntegration({
      repoRoot: root,
      runId: 'run-1',
      revisionId: 'graph-2',
      graphHash: 'hash-abc',
      taskId: 'a',
      attemptId: 'attempt-wrong',
      leaseId: 'lease-a',
    }),
    null
  );

  const replay = await integrateWorktreeResults(completionOrderIndependent);
  assert.equal(replay.integrationQueue.disposition, 'replayed');
  assert.deepEqual(replay.integrated, integrated.integrated);
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await fs.readFile(path.join(root, 'src/b.js'), 'utf8'), 'export const b = 2;\n');

  const cleanup = await cleanupWorktreeWave(integrated);
  assert.equal(cleanup.remaining.length, 1);
  assert.equal(cleanup.remaining[0].path, root);

  const status = (await git(root, ['status', '--short'])).stdout.trimEnd().split(/\r?\n/).sort();
  assert.deepEqual(status, [' M src/a.js', ' M src/b.js']);
});

test('concurrent integration callers serialize on one durable queue and replay the loser', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    runId: 'run-concurrent',
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 7;\n');
    const collected = await collectWorktreeResults(handle);
    const [left, right] = await Promise.all([
      integrateWorktreeResults(collected),
      integrateWorktreeResults(collected),
    ]);

    assert.deepEqual(
      [left.integrationQueue.disposition, right.integrationQueue.disposition].sort(),
      ['committed', 'replayed']
    );
    assert.equal(left.integrationQueue.queueId, right.integrationQueue.queueId);
    assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 7;\n');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('integration restart reconciles a patch applied after write-ahead journal but before completion checkpoint', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    runId: 'run-crash-window',
    revisionId: 'G1',
    graphHash: 'graph-crash-window',
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 9;\n');
    const collected = await collectWorktreeResults(handle);
    const first = await integrateWorktreeResults(collected);
    const journal = await readIntegrationJournal(root, first.integrationQueue.queueId);

    const simulatedCrash = {
      ...journal,
      status: 'applying',
      nextIndex: 0,
      currentTaskId: 'a',
      preWorkspaceHash: createHash('sha256')
        .update('{"trackedDiff":"","untracked":[]}')
        .digest('hex'),
      applied: [],
      finalWorkspaceHash: null,
    };
    await fs.writeFile(
      first.integrationQueue.journalPath,
      JSON.stringify(simulatedCrash, null, 2) + '\n',
      'utf8'
    );

    const recovered = await integrateWorktreeResults(collected);
    assert.equal(recovered.integrationQueue.disposition, 'replayed');
    assert.equal(recovered.integrationQueue.status, 'completed');
    assert.equal(recovered.integrated.length, 1);
    assert.equal(recovered.integrated[0].taskId, 'a');
    assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 9;\n');

    const recoveredJournal = await readIntegrationJournal(root, recovered.integrationQueue.queueId);
    assert.equal(recoveredJournal.status, 'completed');
    assert.equal(recoveredJournal.applied.length, 1);
    assert.equal(recoveredJournal.nextIndex, 1);
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('integration snapshot hash includes newly added untracked files', async () => {
  const root = await fixture({
    'src/existing.js': 'export const existing = true;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    runId: 'run-new-file',
    tasks: [{ id: 'new-file', files_modified: ['src/new.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/new.js'), 'export const added = 1;\n');
    const collected = await collectWorktreeResults(handle);
    const integrated = await integrateWorktreeResults(collected);
    const emptyHash = createHash('sha256')
      .update('{\"trackedDiff\":\"\",\"untracked\":[]}')
      .digest('hex');

    assert.notEqual(integrated.integrationQueue.finalWorkspaceHash, emptyHash);
    assert.equal(await fs.readFile(path.join(root, 'src/new.js'), 'utf8'), 'export const added = 1;\n');
    const replay = await integrateWorktreeResults(collected);
    assert.equal(replay.integrationQueue.disposition, 'replayed');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('integration rejects a corrupted applied journal record on restart', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    runId: 'run-corrupt-journal',
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 3;\n');
    const collected = await collectWorktreeResults(handle);
    const integrated = await integrateWorktreeResults(collected);
    const journal = await readIntegrationJournal(root, integrated.integrationQueue.queueId);
    journal.applied[0].patchHash = '0'.repeat(64);
    await fs.writeFile(
      integrated.integrationQueue.journalPath,
      JSON.stringify(journal, null, 2) + '\n',
      'utf8'
    );

    await assert.rejects(
      () => integrateWorktreeResults(collected),
      (error) => error.code === 'WORKTREE_INTEGRATION_JOURNAL_CORRUPT'
    );
    assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 3;\n');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('completed integration preserves unexplained workspace drift and requires reconciliation', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/other.js': 'export const other = 0;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    runId: 'run-drift',
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 4;\n');
    const collected = await collectWorktreeResults(handle);
    await integrateWorktreeResults(collected);
    await fs.writeFile(path.join(root, 'src/other.js'), 'export const other = 99;\n');

    await assert.rejects(
      () => integrateWorktreeResults(collected),
      (error) => error.code === 'WORKTREE_INTEGRATION_RECONCILE_REQUIRED'
    );
    assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'export const a = 4;\n');
    assert.equal(await fs.readFile(path.join(root, 'src/other.js'), 'utf8'), 'export const other = 99;\n');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('integration refuses a patch handoff modified after result collection', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
  });
  const handle = await createAuthorizedWorktreeWave({
    repoRoot: root,
    tasks: [{ id: 'a', files_modified: ['src/a.js'] }],
  });

  try {
    await fs.writeFile(path.join(handle.worktrees[0].path, 'src/a.js'), 'export const a = 1;\n');
    const collected = await collectWorktreeResults(handle);
    await fs.appendFile(collected.results[0].patchPath, '\n# tampered\n', 'utf8');

    await assert.rejects(
      () => integrateWorktreeResults(collected),
      (error) => error.code === 'WORKTREE_PATCH_TAMPERED'
    );
    assert.equal((await git(root, ['status', '--porcelain'])).stdout.trim(), '');
  } finally {
    await cleanupWorktreeWave(handle, { suppressErrors: true });
  }
});

test('worktree bridge fails closed on ownership escape before integration', async () => {
  const root = await fixture({
    'src/a.js': 'export const a = 0;\n',
    'src/other.js': 'export const other = 0;\n',
  });

  const handle = await createAuthorizedWorktreeWave({
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

  const handle = await createAuthorizedWorktreeWave({
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

  const handle = await createAuthorizedWorktreeWave({
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
