import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  preflightInstalledLeadSmoke,
  runInstalledLeadRuntimeSmoke,
  validateInstalledLeadRuntimeEvidence,
} from '../../scripts/installed-lead-runtime-smoke.mjs';

const ACTION = '.planning/lead-quality-closure.mjs';
const SNAPSHOT = 'sha256:' + createHash('sha256').update('export const value = 1;\n').digest('hex');

function validEvidence(overrides = {}) {
  const workspace = path.join(os.tmpdir(), 'hybrid-case-i-validator-fixture');
  const events = [
    { runId: 'case-i', taskId: 'case-i', stage: 'qa', lifecycle: 'start', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: 'case-i', taskId: 'case-i', stage: 'qa', lifecycle: 'end', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: 'case-i', taskId: 'case-i', stage: 'verifier', lifecycle: 'start', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: 'case-i', taskId: 'case-i', stage: 'verifier', lifecycle: 'end', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: 'case-i', taskId: 'case-i', stage: 'completion', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
  ];
  return {
    workspace,
    leadCwd: workspace,
    leadAction: {
      path: path.join(workspace, ACTION),
      cwd: workspace,
      source: [
        "import { runQualityClosure } from '../.hybrid/core/orchestrator/index.mjs';",
        "import { execFileSync } from 'node:child_process';",
        "import assert from 'node:assert/strict';",
        'const result = await runQualityClosure({ repoRoot: process.cwd(), runId: "case-i", taskId: "case-i", snapshot: ' + JSON.stringify(SNAPSHOT) + ', tier: 0, qa: async () => ({ ok: true, findings: [] }), verifier: async ({ snapshot }) => { execFileSync(process.execPath, ["--input-type=module", "-e", "import assert from \\\"node:assert/strict\\\"; import { value } from \\\"./src/value.mjs\\\"; assert.equal(value, 1)"], { cwd: process.cwd() }); assert.equal(true, true); return { ok: true, report: { snapshot, lightweightVerificationEvidence: { kind: "test", fresh: true, success: true } } }; } });',
        'if (!result.pass || !result.completion?.pass) throw new Error("closure failed");',
      ].join('\n'),
    },
    installed: {
      installed: true,
      manifestExists: true,
      orchestratorExists: true,
      orchestratorExport: true,
      agentsContract: true,
      skillContract: true,
      coreIntegrity: true,
      coreIntegrityAfterRun: true,
    },
    fixture: { initialValid: true, finalValid: true },
    authentication: { authStatus: 'ok' },
    codex: {
      code: 0,
      timedOut: false,
      cwd: workspace,
      args: ['exec', '--strict-config', '--json', '--cd', workspace],
      stdout: '',
      commandExecutions: [{ command: 'node .planning/lead-quality-closure.mjs', cwd: workspace, exitCode: 0 }],
    },
    runtimeEvents: events,
    expected: { runId: 'case-i', snapshot: SNAPSHOT, actionRelativePath: ACTION },
    ...overrides,
  };
}

test('Case I preflight installs the real project surface and validates the installed export without running it', async () => {
  const result = await preflightInstalledLeadSmoke();
  assert.equal(result.status, 'preflight-passed');
  assert.equal(result.installed.manifest, true);
  assert.equal(result.installed.orchestrator, true);
  assert.equal(result.installed.export, true);
  assert.equal(result.installed.agentsContract, true);
  assert.equal(result.installed.skillContract, true);
  assert.equal(result.fixture.initialValid, true);
  assert.equal(result.validator.runtimeExecuted, false);
});

test('Case I validator accepts installed Lead execution only with primitive lifecycle evidence', () => {
  assert.deepEqual(validateInstalledLeadRuntimeEvidence(validEvidence()), { ok: true, errors: [] });
});

test('Case I validator rejects fake success without runtime events', () => {
  const result = validateInstalledLeadRuntimeEvidence(validEvidence({ runtimeEvents: [] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /runtime lifecycle events/.test(error)));
});

test('Case I validator rejects a missing completion event even when Codex exits zero', () => {
  const input = validEvidence();
  input.runtimeEvents = input.runtimeEvents.filter((event) => event.stage !== 'completion');
  const result = validateInstalledLeadRuntimeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /completion PASS/.test(error)));
});

test('Case I validator rejects framework-source direct bypass', () => {
  const input = validEvidence();
  input.leadAction.source = input.leadAction.source.replace(
    "'../.hybrid/core/orchestrator/index.mjs'",
    "'../../core/orchestrator/index.mjs'"
  );
  const result = validateInstalledLeadRuntimeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /framework-source-direct bypass/.test(error)));
});

test('Case I validator accepts a shell-wrapped Node action only with recorded zero exit', () => {
  const input = validEvidence();
  input.codex.commandExecutions[0].command = "bash -lc 'node .planning/lead-quality-closure.mjs'";
  assert.equal(validateInstalledLeadRuntimeEvidence(input).ok, true);
});

test('Case I validator rejects a null action exit code even if the Codex turn says zero', () => {
  const input = validEvidence();
  input.codex.commandExecutions[0].exitCode = null;
  const result = validateInstalledLeadRuntimeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /no successful command execution/.test(error)));
});

test('Case I validator rejects a function call named spawn_agent', () => {
  const input = validEvidence();
  input.codex.stdout = JSON.stringify({ type: 'function_call', name: 'spawn_agent' });
  const result = validateInstalledLeadRuntimeEvidence(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /recursive worker delegation/.test(error)));
});

test('Case I live smoke reports runtime-validation-pending when Codex auth is unavailable', async () => {
  const result = await runInstalledLeadRuntimeSmoke({ codexBin: path.join(os.tmpdir(), 'missing-case-i-codex') });
  assert.equal(result.status, 'runtime-validation-pending');
  assert.match(result.reason, /not found|Codex CLI/i);
});
