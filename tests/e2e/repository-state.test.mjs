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
  assert.match(state.nextAction, /execution graph v4 isolation authority/i);
  assert.match(state.nextAction, /durable lease\/terminal fencing/i);
  assert.match(state.nextAction, /worktree integration-backed completion\/recovery are complete/i);
  assert.match(state.nextAction, /explicit allowlisted model\/effort fail-closed routing/i);
  assert.match(state.nextAction, /authenticated revised Cases J\/K provenance validation are complete/i);
  assert.match(state.nextAction, /Tier 0 Implementer ownership/i);
  assert.match(state.nextAction, /parallel sibling provenance/i);
  assert.match(state.nextAction, /Lead-only central persistence/i);
  assert.match(state.nextAction, /npm test 352\/352/i);
  assert.match(state.nextAction, /test:unit 121\/121/i);
  assert.deepEqual(state.blockers, [
    'Real Case D has not been exercised because the harness must not invent user responses',
  ]);

  for (const relative of [state.activeSpec, state.activePlan].filter(Boolean)) {
    await fs.access(path.join(root, relative));
  }
});
