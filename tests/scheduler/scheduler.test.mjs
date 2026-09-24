import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionWaves, planExecutionIsolation, SchedulerError } from '../../core/scheduler/index.mjs';

test('dependency ordering creates topological waves', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['a.js'] },
    { id: 'B', depends_on: ['A'], files_modified: ['b.js'] },
    { id: 'C', depends_on: ['B'], files_modified: ['c.js'] },
    { id: 'D', depends_on: ['C'], files_modified: ['d.js'] },
    { id: 'E', depends_on: ['C'], files_modified: ['e.js'] },
  ]);

  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [
    ['A'],
    ['B'],
    ['C'],
    ['D', 'E'],
  ]);
});

test('same-file writers are serialized', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['shared.js'] },
    { id: 'B', depends_on: [], files_modified: ['shared.js'] },
  ]);
  assert.equal(waves.length, 2);
  assert.notEqual(waves[0][0].id, waves[1][0].id);
});

test('independent tasks run in parallel', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['a.js'] },
    { id: 'B', depends_on: [], files_modified: ['b.js'] },
    { id: 'C', depends_on: [], files_modified: ['c.js'] },
  ]);
  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [['A', 'B', 'C']]);
});

test('cycle detection fails closed', () => {
  assert.throws(
    () => buildExecutionWaves([
      { id: 'A', depends_on: ['B'], files_modified: ['a.js'] },
      { id: 'B', depends_on: ['A'], files_modified: ['b.js'] },
    ]),
    (error) => error instanceof SchedulerError && error.code === 'CYCLE'
  );
});


test('precise tiny independent parallel writers may stay in the current workspace', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['src/a.js'] },
    { id: 'B', depends_on: [], files_modified: ['src/b.js'] },
  ]);
  const planned = planExecutionIsolation(waves, { worktreeAvailable: true });
  assert.equal(planned.isolation[0].mode, 'current-workspace');
  assert.deepEqual(planned.waves[0].map((task) => task.id), ['A', 'B']);
});

test('lockfiles generated paths and low ownership confidence trigger worktree isolation', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['package-lock.json'] },
    { id: 'B', depends_on: [], files_modified: ['generated/client.js'], generated_files: true },
  ]);
  const planned = planExecutionIsolation(waves, { worktreeAvailable: true });
  assert.equal(planned.isolation[0].mode, 'worktree');
  assert.match(planned.isolation[0].reason, /lockfile|generated/);
});

test('required isolation falls back to safe serialization when worktrees are unavailable', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['package-lock.json'] },
    { id: 'B', depends_on: [], files_modified: ['src/b.js'] },
  ]);
  const planned = planExecutionIsolation(waves, { worktreeAvailable: false });
  assert.deepEqual(planned.waves.map((wave) => wave.map((task) => task.id)), [['A'], ['B']]);
  assert.ok(planned.isolation.every((entry) => entry.reason === 'worktree-unavailable-safe-serialization'));
});
