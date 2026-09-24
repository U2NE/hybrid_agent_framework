import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCompletionGate } from '../../core/verification/index.mjs';
import {
  acquireProof,
  mergeAcquiredEvidence,
  selectProofAcquisition,
} from '../../core/qe/index.mjs';
import {
  appendRuntimeEvent,
  sanitizeRuntimeEvent,
} from '../../core/observability/index.mjs';

function report() {
  return {
    criteria: ['CLI prints hello Alice'],
    planTasks: [{ id: 'cli', acceptance_criteria: ['CLI prints hello Alice'] }],
    implementationEvidence: { 'AC-001': { evidence: 'bin/hello.mjs' } },
    verificationEvidence: {
      'AC-001': { status: 'VERIFIED', evidence: 'static implementation inspected' },
    },
    freshTestOutput: true,
    buildApplicable: false,
    typecheckApplicable: false,
    lintApplicable: false,
    specGoalAligned: true,
  };
}

test('Tier 0 sufficient evidence and UI-only metadata do not create QE work', () => {
  const tier0 = evaluateCompletionGate({
    tier: 0,
    report: {
      lightweightVerificationEvidence: {
        kind: 'lint',
        source: 'git diff --check',
        fresh: true,
        success: true,
      },
    },
  });
  assert.equal(tier0.pass, true);
  assert.deepEqual(tier0.proofGaps, []);

  const coveredUi = evaluateCompletionGate({
    tier: 1,
    report: report(),
    evidence: [{ kind: 'test', source: 'focused UI text test', fresh: true, success: true, criterionId: 'AC-001' }],
  });
  assert.equal(coveredUi.pass, true);
  assert.deepEqual(coveredUi.proofGaps, []);
});

test('missing runtime CLI evidence creates a CLI proof gap and process acquisition closes it', async () => {
  const first = evaluateCompletionGate({
    tier: 1,
    report: report(),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    evidence: [],
  });
  assert.equal(first.pass, false);
  assert.equal(first.reason, 'PROOF_GAP');

  const gap = {
    ...first.proofGaps[0],
    command: [process.execPath, '-e', 'process.stdout.write("hello Alice")'],
  };
  assert.equal(selectProofAcquisition(gap).adapter, 'process');

  const acquisition = await acquireProof(gap, { timeoutMs: 5000 });
  assert.equal(acquisition.acquired, true);
  assert.equal(acquisition.evidence.success, true);
  assert.equal(acquisition.evidence.stdout, 'hello Alice');

  const second = evaluateCompletionGate({
    tier: 1,
    report: report(),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    evidence: mergeAcquiredEvidence([], [acquisition]),
  });
  assert.equal(second.pass, true);
});

test('cheapest adequate proof prefers process CLI over browser when both are semantically adequate', () => {
  const selection = selectProofAcquisition({
    criterionId: 'AC-001',
    adequateKinds: ['browser', 'cli'],
    command: [process.execPath, '-e', 'process.exit(0)'],
  });

  assert.equal(selection.available, true);
  assert.equal(selection.requiredKind, 'cli');
  assert.equal(selection.adapter, 'process');
});

test('browser-only proof fails closed when no browser provider exists', async () => {
  const gap = {
    criterionId: 'AC-002',
    requiredKind: 'browser',
    reason: 'refresh persistence requires browser interaction',
  };
  const selection = selectProofAcquisition(gap);
  assert.equal(selection.available, false);
  assert.equal(selection.reason, 'browser-provider-unavailable');

  const result = await acquireProof(gap);
  assert.equal(result.acquired, false);
  assert.equal(result.evidence, null);
});

test('configured browser provider can return bounded structured evidence without adding an agent', async () => {
  const gap = { criterionId: 'AC-002', requiredKind: 'browser' };
  const result = await acquireProof(gap, {
    browserProvider: async () => ({
      success: true,
      source: 'project-owned-playwright',
      artifactRef: '/tmp/screenshot.png',
      summary: 'state persisted after refresh',
    }),
  });
  assert.equal(result.acquired, true);
  assert.equal(result.evidence.kind, 'browser');
  assert.equal(result.evidence.success, true);
  assert.equal(result.evidence.criterionId, 'AC-002');
});

test('passive observability writes JSONL, redacts secrets, and omits prompts', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-obs-repo-'));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-obs-runtime-'));

  const written = await appendRuntimeEvent({
    repoRoot,
    runId: 'run-1',
    event: {
      runId: 'run-1',
      taskId: 'auth',
      stage: 'verifier',
      role: 'verifier',
      modelRequested: 'gpt-6-luna',
      effortRequested: 'medium',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
      outcome: 'fix',
      attempt: 1,
      failureReason: 'AC-002 failed',
      evidenceRefs: [],
      cacheHit: true,
      authorization: 'Bearer top-secret',
      nested: { apiKey: 'secret-key', safe: 'ok' },
      prompt: 'do not log this full prompt',
    },
  }, { runtimeRoot });

  assert.equal(written.ok, true);
  const lines = (await fs.readFile(written.eventPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.authorization, '[REDACTED]');
  assert.equal(event.nested.apiKey, '[REDACTED]');
  assert.equal(event.nested.safe, 'ok');
  assert.equal('prompt' in event, false);
  assert.equal(event.modelRequested, 'gpt-6-luna');
});

test('observability storage failure never fails the calling execution', async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-obs-fail-'));
  const fileRoot = path.join(runtimeRoot, 'file');
  await fs.writeFile(fileRoot, 'not a directory');

  const result = await appendRuntimeEvent({
    repoRoot: '/tmp/repo',
    runId: 'run',
    event: { stage: 'verifier', password: 'secret' },
  }, { runtimeRoot: fileRoot });

  assert.equal(result.ok, false);
  assert.ok(result.error);
  const safe = sanitizeRuntimeEvent({ password: 'secret', stage: 'verifier' });
  assert.equal(safe.password, '[REDACTED]');
});
