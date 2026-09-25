import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCaseKFixture, preflightParallelProvenanceSmoke, validateParallelProvenanceEvidence } from '../../scripts/parallel-provenance-runtime-smoke.mjs';

test('Case K parallel provenance deterministic preflight covers positive and negative contracts', async () => {
  const result = await preflightParallelProvenanceSmoke();
  assert.equal(result.status, 'preflight-passed');
  assert.equal(result.case, 'K');
  assert.equal(result.runtimeExecuted, false);
  for (const name of [
    'exitZeroNoDecisions', 'oneChildMissing', 'serializedDispatch', 'spawnWithoutDecision', 'orphanWorker', 'leadEdits',
    'crossWrite', 'workerCentralDecision', 'workerCentralAction', 'actorObserved',
    'auditMissing', 'auditFailed', 'installedApiMissing', 'frameworkBypass', 'installedCoreModified',
  ]) assert.ok(result.negativeCases.includes(name), name);
  assert.equal(typeof validateParallelProvenanceEvidence, 'function');
});

test('Case K fixture accepts exact text with at most one final line terminator', () => {
  assert.equal(matchesCaseKFixture('A1', 'A1'), true);
  assert.equal(matchesCaseKFixture('A1\n', 'A1'), true);
  assert.equal(matchesCaseKFixture('A1\r\n', 'A1'), true);
  assert.equal(matchesCaseKFixture('A1 ', 'A1'), false);
  assert.equal(matchesCaseKFixture('A1\n\n', 'A1'), false);
  assert.equal(matchesCaseKFixture('A1\t', 'A1'), false);
});
