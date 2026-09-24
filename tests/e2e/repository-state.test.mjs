import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../../core/state/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

test('repository canonical STATE.md is parseable and points at durable active artifacts', async () => {
  const state = await new StateStore(root).load();
  assert.equal(state.schemaVersion, 1);
  assert.ok(state.phase);
  assert.ok(state.status);

  for (const relative of [state.activeSpec, state.activePlan].filter(Boolean)) {
    await fs.access(path.join(root, relative));
  }
});
