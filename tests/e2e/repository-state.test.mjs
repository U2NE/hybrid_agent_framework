import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_SCHEMA, StateStore } from '../../core/state/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

test('repository canonical STATE.md matches the current runtime validation boundary', async () => {
  const state = await new StateStore(root).load();

  assert.equal(state.schema, STATE_SCHEMA);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.phase, '04-hardening');
  assert.equal(state.status, 'verified-interactive-runtime-pending');
  assert.match(state.nextAction, /exercise Case D with genuine user answers/i);
  assert.match(state.nextAction, /Cases A\/B\/C, routing probe, Case E worktree, Case F planning convergence/i);
  assert.match(state.nextAction, /planning schema alias canonicalization/i);
  assert.match(state.nextAction, /full regression suite are complete/i);
  assert.deepEqual(state.blockers, [
    'Real Case D has not been exercised because the harness must not invent user responses',
  ]);

  for (const relative of [state.activeSpec, state.activePlan].filter(Boolean)) {
    await fs.access(path.join(root, relative));
  }
});
