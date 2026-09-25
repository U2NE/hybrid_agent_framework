import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightParallelProvenanceSmoke, validateParallelProvenanceEvidence } from '../../scripts/parallel-provenance-runtime-smoke.mjs';

test('Case K parallel provenance deterministic preflight covers positive and negative contracts', async () => {
  const result = await preflightParallelProvenanceSmoke();
  assert.equal(result.status, 'preflight-passed');
  assert.equal(result.case, 'K');
  assert.equal(result.runtimeExecuted, false);
  for (const name of [
    'exitZeroNoDecisions', 'oneChildMissing', 'spawnWithoutDecision', 'orphanWorker', 'leadEdits',
    'crossWrite', 'workerCentralDecision', 'workerCentralAction', 'actorObserved',
    'auditMissing', 'auditFailed', 'installedApiMissing', 'frameworkBypass', 'installedCoreModified',
  ]) assert.ok(result.negativeCases.includes(name), name);
  assert.equal(typeof validateParallelProvenanceEvidence, 'function');
});
