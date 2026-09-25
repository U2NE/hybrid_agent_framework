import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightDecisionProvenanceSmoke, validateDecisionProvenanceEvidence } from '../../scripts/decision-provenance-runtime-smoke.mjs';
test('Case J installs real contract and rejects all semantic negatives without authentication', async () => {
  const result = await preflightDecisionProvenanceSmoke();
  assert.equal(result.status, 'preflight-passed');
  assert.equal(result.runtimeExecuted, false);
  for (const name of ['leadImplementationBypass', 'actorObserved', 'noWorkerExecution', 'frameworkSourceBypass', 'installedCoreChanged']) assert.ok(result.negativeCases.includes(name), name);
  assert.equal(validateDecisionProvenanceEvidence({ exitCode: 0 }).ok, false);
});
