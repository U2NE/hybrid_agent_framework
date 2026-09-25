import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutionWaves,
  findResourceConflicts,
  planExecutionIsolation,
  SchedulerError,
} from '../../core/scheduler/index.mjs';

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

test('declared read/write overlap serializes even when files_modified differs', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['src/api.js'], writes: ['src/contract.js'] },
    { id: 'B', depends_on: [], files_modified: ['src/client.js'], reads: ['src/contract.js'] },
  ]);
  assert.deepEqual(waves.map((wave) => wave.map((task) => task.id)), [['A'], ['B']]);
});

test('exclusive semantic resources serialize independent files', () => {
  const tasks = [
    {
      id: 'A',
      depends_on: [],
      files_modified: ['src/api.js'],
      resources: [{ key: 'contract:user-api', mode: 'exclusive' }],
    },
    {
      id: 'B',
      depends_on: [],
      files_modified: ['src/client.js'],
      resources: ['contract:user-api'],
    },
  ];
  const waves = buildExecutionWaves(tasks);
  assert.deepEqual(waves.map((wave) => wave.map((task) => task.id)), [['A'], ['B']]);
  assert.deepEqual(findResourceConflicts(tasks), [{
    resource: 'contract:user-api',
    tasks: ['A', 'B'],
    modes: ['exclusive', 'exclusive'],
  }]);
});

test('shared semantic resources can run together and wildcard exclusive resources conflict', () => {
  const shared = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['a.js'], resources: [{ key: 'schema:user', mode: 'shared' }] },
    { id: 'B', depends_on: [], files_modified: ['b.js'], resources: [{ key: 'schema:user', mode: 'read' }] },
  ]);
  assert.deepEqual(shared.map((wave) => wave.map((task) => task.id)), [['A', 'B']]);

  const wildcard = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['a.js'], resources: ['directory:src/auth/*'] },
    { id: 'B', depends_on: [], files_modified: ['b.js'], resources: ['directory:src/auth/session'] },
  ]);
  assert.deepEqual(wildcard.map((wave) => wave.map((task) => task.id)), [['A'], ['B']]);
});

test('design executor and implementer serialize only when they lease the same UI surface', () => {
  const sameSurface = buildExecutionWaves([
    {
      id: 'design',
      owner: 'design-executor',
      depends_on: [],
      files_modified: ['src/components/Checkout.tsx'],
      resources: [{ key: 'ui:checkout', mode: 'exclusive' }],
    },
    {
      id: 'logic',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/hooks/useCheckout.ts'],
      resources: [{ key: 'ui:checkout', mode: 'exclusive' }],
    },
  ]);
  assert.deepEqual(
    sameSurface.map((wave) => wave.map((task) => task.id)),
    [['design'], ['logic']]
  );

  const differentSurfaces = buildExecutionWaves([
    {
      id: 'checkout',
      owner: 'design-executor',
      depends_on: [],
      files_modified: ['src/components/Checkout.tsx'],
      resources: [{ key: 'ui:checkout', mode: 'exclusive' }],
    },
    {
      id: 'profile',
      owner: 'implementer',
      depends_on: [],
      files_modified: ['src/components/Profile.tsx'],
      resources: [{ key: 'ui:profile', mode: 'exclusive' }],
    },
  ]);
  assert.deepEqual(
    differentSurfaces.map((wave) => wave.map((task) => task.id)),
    [['checkout', 'profile']]
  );
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

test('parallel mutators always use worktree isolation when available', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['src/a.js'] },
    { id: 'B', depends_on: [], files_modified: ['src/b.js'] },
  ]);
  const planned = planExecutionIsolation(waves, { worktreeAvailable: true });
  assert.equal(planned.isolation[0].mode, 'worktree');
  assert.match(planned.isolation[0].reason, /parallel-mutators/);
  assert.deepEqual(planned.waves[0].map((task) => task.id), ['A', 'B']);
});

test('parallel mutators serialize when worktrees are unavailable even with disjoint files', () => {
  const waves = buildExecutionWaves([
    { id: 'A', depends_on: [], files_modified: ['src/a.js'] },
    { id: 'B', depends_on: [], files_modified: ['src/b.js'] },
  ]);
  const planned = planExecutionIsolation(waves, { worktreeAvailable: false });
  assert.deepEqual(planned.waves.map((wave) => wave.map((task) => task.id)), [['A'], ['B']]);
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

test('invalid resource modes and effect policies fail closed', () => {
  assert.throws(
    () => buildExecutionWaves([
      { id: 'A', depends_on: [], files_modified: ['a.js'], resources: [{ key: 'contract:x', mode: 'maybe' }] },
    ]),
    (error) => error instanceof SchedulerError && error.code === 'INVALID_RESOURCE'
  );
  assert.throws(
    () => buildExecutionWaves([
      { id: 'A', depends_on: [], files_modified: ['a.js'], effect_policy: 'retry_forever' },
    ]),
    (error) => error instanceof SchedulerError && error.code === 'INVALID_EFFECT_POLICY'
  );
});
