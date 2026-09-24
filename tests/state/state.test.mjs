import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore, StateError, STATE_SCHEMA } from '../../core/state/index.mjs';

async function fixture() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-state-'));
}

test('state resumes after interruption with explicit hybrid-state/v1 schema', async () => {
  const root = await fixture();
  const store = new StateStore(root);
  await store.init({ phase: '01', status: 'executing', nextAction: 'run B' });
  await store.update((state) => {
    state.nextAction = 'resume C';
    return state;
  });

  const secondProcessView = new StateStore(root);
  const loaded = await secondProcessView.load();
  assert.equal(loaded.schema, STATE_SCHEMA);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.nextAction, 'resume C');
  assert.equal(loaded.revision, 2);

  const text = await fs.readFile(path.join(root, '.planning', 'STATE.md'), 'utf8');
  assert.match(text, /hybrid-state:v1/);
  assert.match(text, /"schema": "hybrid-state\/v1"/);
});

test('legacy v1 state without string schema remains readable and is upgraded on next write', async () => {
  const root = await fixture();
  const dir = path.join(root, '.planning');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'STATE.md'), [
    '# Project State',
    '<!-- hybrid-state:v1',
    '{"schemaVersion":1,"phase":"legacy","status":"active","nextAction":"resume","revision":1}',
    '-->',
    '',
  ].join('\n'));

  const store = new StateStore(root);
  const loaded = await store.load();
  assert.equal(loaded.schema, STATE_SCHEMA);
  assert.equal(loaded.phase, 'legacy');
  await store.write(loaded);
  const rewritten = await fs.readFile(path.join(dir, 'STATE.md'), 'utf8');
  assert.match(rewritten, /"schema": "hybrid-state\/v1"/);
});

test('unsupported state schema fails closed instead of being silently normalized', async () => {
  const root = await fixture();
  const dir = path.join(root, '.planning');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'STATE.md'), [
    '# Project State',
    '<!-- hybrid-state:v1',
    '{"schema":"hybrid-state/v2","schemaVersion":2,"phase":"future"}',
    '-->',
    '',
  ].join('\n'));

  const store = new StateStore(root);
  await assert.rejects(
    () => store.load(),
    (error) => error instanceof StateError && error.code === 'UNSUPPORTED_SCHEMA'
  );
});

test('corrupt state does not silently reset', async () => {
  const root = await fixture();
  const stateDir = path.join(root, '.planning');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'STATE.md'), '# Project State\n<!-- hybrid-state:v1\n{broken\n-->\n');

  const store = new StateStore(root);
  await assert.rejects(
    () => store.load(),
    (error) => error instanceof StateError && error.code === 'CORRUPT'
  );

  const contents = await fs.readFile(path.join(stateDir, 'STATE.md'), 'utf8');
  assert.match(contents, /\{broken/);
});
