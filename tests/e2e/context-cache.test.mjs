import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_CACHE_SCHEMA,
  contextCachePath,
  createContextSnapshot,
  getOrCreateContextSnapshot,
} from '../../core/context/cache.mjs';
import { resolveHybridRuntimeRoot } from '../../core/runtime/index.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-context-cache-test-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  return root;
}

function input(root, overrides = {}) {
  return {
    repoRoot: root,
    gitRevision: 'abc123',
    spec: '# SPEC\nGoal A\n',
    plan: { tasks: [{ id: 'a' }] },
    scope: 'implementation',
    goal: 'Implement A.',
    acceptanceCriteria: ['A works'],
    constraints: ['No network'],
    relevantInterfaces: ['a()'],
    decisions: ['Keep API stable'],
    relevantFiles: ['src/a.js'],
    ...overrides,
  };
}

test('same shared inputs produce the same cache key and a cache hit without LLM work', async () => {
  const root = await fixture();
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-runtime-cache-'));
  const first = await getOrCreateContextSnapshot(input(root), { runtimeRoot });
  const second = await getOrCreateContextSnapshot(input(root), { runtimeRoot });

  assert.equal(first.snapshot.schema, CONTEXT_CACHE_SCHEMA);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(first.snapshot.key, second.snapshot.key);
  assert.equal(second.snapshot.shared.goal, 'Implement A.');
});

test('file SPEC PLAN and git revision changes invalidate the shared context cache', async () => {
  const root = await fixture();
  const base = await createContextSnapshot(input(root));

  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
  const fileChanged = await createContextSnapshot(input(root));
  assert.notEqual(fileChanged.key, base.key);

  const specChanged = await createContextSnapshot(input(root, { spec: '# SPEC\nGoal B\n' }));
  assert.notEqual(specChanged.key, fileChanged.key);

  const planChanged = await createContextSnapshot(input(root, { plan: { tasks: [{ id: 'b' }] } }));
  assert.notEqual(planChanged.key, fileChanged.key);

  const gitChanged = await createContextSnapshot(input(root, { gitRevision: 'def456' }));
  assert.notEqual(gitChanged.key, fileChanged.key);
});

test('role-private fields do not change shared snapshot key or leak into shared context', async () => {
  const root = await fixture();
  const a = await createContextSnapshot(input(root, {
    rolePrivateData: { scratchpad: 'implementer secret reasoning' },
  }));
  const b = await createContextSnapshot(input(root, {
    rolePrivateData: { scratchpad: 'reviewer private reasoning' },
  }));

  assert.equal(a.key, b.key);
  assert.equal(JSON.stringify(a).includes('secret reasoning'), false);
  assert.equal(JSON.stringify(b).includes('private reasoning'), false);
});

test('corrupt cache safely recomputes and cache storage failure is non-fatal', async () => {
  const root = await fixture();
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-runtime-cache-'));
  const fresh = await createContextSnapshot(input(root));
  const cachePath = contextCachePath(runtimeRoot, fresh.key);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, '{broken json');

  const recovered = await getOrCreateContextSnapshot(input(root), { runtimeRoot });
  assert.equal(recovered.cacheHit, false);
  assert.equal(recovered.snapshot.key, fresh.key);

  const blockedRoot = path.join(runtimeRoot, 'not-a-directory');
  await fs.writeFile(blockedRoot, 'file');
  const noCache = await getOrCreateContextSnapshot(input(root, { gitRevision: 'new' }), {
    runtimeRoot: blockedRoot,
  });
  assert.equal(noCache.cacheHit, false);
  assert.ok(noCache.cacheError);
  assert.equal(noCache.snapshot.shared.goal, 'Implement A.');
});

test('runtime root uses HYBRID_RUNTIME_DIR or a stable temp-derived path outside the repo', async () => {
  const root = await fixture();
  const explicit = resolveHybridRuntimeRoot(root, {
    env: { HYBRID_RUNTIME_DIR: '/tmp/hybrid-explicit-runtime' },
  });
  assert.equal(explicit, '/tmp/hybrid-explicit-runtime');

  const derivedA = resolveHybridRuntimeRoot(root, { env: {}, tmpdir: '/tmp' });
  const derivedB = resolveHybridRuntimeRoot(root, { env: {}, tmpdir: '/tmp' });
  assert.equal(derivedA, derivedB);
  assert.equal(derivedA.startsWith(path.resolve(root) + path.sep), false);
});
