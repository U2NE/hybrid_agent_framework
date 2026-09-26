import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runQualityClosure } from '../../core/orchestrator/index.mjs';
import { evaluateCompletionGate } from '../../core/verification/index.mjs';

function report(criteria = ['A works'], overrides = {}) {
  const verificationEvidence = Object.fromEntries(
    criteria.map((criterion, index) => [
      'AC-' + String(index + 1).padStart(3, '0'),
      { status: 'VERIFIED', evidence: 'independent verifier assessed ' + criterion },
    ])
  );
  const implementationEvidence = Object.fromEntries(
    criteria.map((criterion, index) => [
      'AC-' + String(index + 1).padStart(3, '0'),
      { evidence: 'implementation for ' + criterion },
    ])
  );
  return {
    criteria,
    planTasks: criteria.map((criterion, index) => ({
      id: 'task-' + (index + 1),
      acceptance_criteria: [criterion],
    })),
    implementationEvidence,
    verificationEvidence,
    freshTestOutput: true,
    buildApplicable: false,
    typecheckApplicable: false,
    lintApplicable: false,
    specGoalAligned: true,
    ...overrides,
  };
}

function task(criteria = ['A works']) {
  return {
    id: 'quality-task',
    goal: 'Implement A.',
    files_modified: ['src/a.js'],
    acceptance_criteria: criteria,
    verify: 'node --test tests/a.test.mjs',
    owner: 'implementer',
  };
}

test('generic normal path uses QA verifier and completion gate with zero repair proof extra verifier or browser calls', async () => {
  const counts = { qa: 0, verifier: 0, repair: 0, proof: 0, browser: 0 };
  const events = [];

  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(),
    qa: async () => {
      counts.qa += 1;
      return { ok: true, findings: [] };
    },
    verifier: async () => {
      counts.verifier += 1;
      return {
        ok: true,
        verdict: 'PASS',
        reason: 'VERIFIED',
        report: report(),
      };
    },
    repairImplementation: async () => {
      counts.repair += 1;
      return { changed: false };
    },
    proofAcquisition: async () => {
      counts.proof += 1;
      return [];
    },
    appendRuntimeEvent: async ({ event }) => {
      events.push(event);
      return { ok: true };
    },
  });

  assert.equal(result.pass, true);
  assert.equal(result.completion.pass, true);
  assert.deepEqual(counts, { qa: 1, verifier: 1, repair: 0, proof: 0, browser: 0 });
  assert.equal(counts.verifier - 1, 0);
  assert.ok(events.some((event) => event.stage === 'qa' && event.lifecycle === 'start'));
  assert.ok(events.some((event) => event.stage === 'qa' && event.lifecycle === 'end'));
  assert.ok(events.some((event) => event.stage === 'verifier' && event.lifecycle === 'start'));
  assert.ok(events.some((event) => event.stage === 'verifier' && event.lifecycle === 'end'));
  assert.ok(events.some((event) => event.stage === 'completion' && event.outcome === 'pass'));
});

test('generic repair path repairs exactly once on a blocking defect then reruns QA and verifier on new snapshot', async () => {
  const calls = { qa: 0, verifier: 0, repair: 0 };
  const snapshots = [];

  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(),
    qa: async ({ snapshot }) => {
      calls.qa += 1;
      snapshots.push(['qa', snapshot]);
      if (snapshot === 'R1') {
        return {
          ok: false,
          findings: [{
            severity: 'high',
            category: 'correctness',
            criterionId: 'AC-001',
            acceptanceFailure: true,
            file: 'src/a.js',
            symbol: 'a',
            evidence: 'A returns the wrong value',
            expectedBehavior: 'A returns the expected value',
          }],
        };
      }
      return { ok: true, findings: [] };
    },
    verifier: async ({ snapshot }) => {
      calls.verifier += 1;
      snapshots.push(['verifier', snapshot]);
      return {
        ok: snapshot === 'R2',
        verdict: snapshot === 'R2' ? 'PASS' : 'FAIL',
        reason: snapshot === 'R2' ? 'VERIFIED' : 'FIX_REQUIRED',
        report: report(),
      };
    },
    repairImplementation: async ({ snapshot }) => {
      calls.repair += 1;
      assert.equal(snapshot, 'R1');
      return { changed: true, snapshot: 'R2' };
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  assert.equal(result.pass, true);
  assert.equal(result.snapshot, 'R2');
  for (const event of result.events.filter(e => ['repair', 'completion'].includes(e.stage))) assert.ok(result.decisionTrace.some(d => d.decisionId === event.decisionId));
  assert.equal(result.decisionTrace.filter(d => d.decision === 'repair_trigger').length, 1);
  for (const d of result.decisionTrace.filter(d => d.stage === 'repair')) {
    assert.equal(d.policy.rule, 'repair.material-finding-only');
    assert.deepEqual(d.reasonCodes, [d.decision === 'repair_trigger' ? 'ACCEPTANCE_FAILURE' : 'NO_MATERIAL_FINDING']);
  }
  const completed = result.decisionTrace.find(d => d.decision === 'complete');
  assert.equal(completed.stage, 'completion');
  assert.equal(completed.policy.rule, 'completion.evidence-gate');
  assert.deepEqual(completed.reasonCodes, ['ALL_AC_VERIFIED']);
  for (const e of result.events.filter(e => e.decisionId)) {
    assert.equal(e.actorRole, 'lead');
    assert.equal(e.role, 'lead');
    assert.equal(e.attribution, 'observed');
    assert.equal(e.action, result.decisionTrace.find(d => d.decisionId === e.decisionId).intendedAction.type);
  }
  assert.ok(result.decisionTrace.some(d => d.decision === 'repair_skip'));
  assert.deepEqual(calls, { qa: 2, verifier: 1, repair: 1 });
  assert.deepEqual(snapshots, [
    ['qa', 'R1'],
    ['qa', 'R2'],
    ['verifier', 'R2'],
  ]);
});

test('generic proof-gap path acquires raw proof then requires verifier assessment before completion', async () => {
  let verifierCalls = 0;
  let proofCalls = 0;
  let acquiredId = null;

  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(['CLI stdout is exactly "hello Alice"']),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    proofRequests: {
      'AC-001': {
        requiredKind: 'cli',
        command: [process.execPath, '-e', 'process.stdout.write("hello Alice")'],
      },
    },
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async ({ phase, evidence }) => {
      verifierCalls += 1;
      if (phase === 'verification') {
        return {
          ok: false,
          verdict: 'FAIL',
          reason: 'PROOF_GAP',
          report: report(['CLI stdout is exactly "hello Alice"']),
        };
      }

      assert.equal(phase, 'proof-reassessment');
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].acquired, true);
      assert.equal(evidence[0].assessed, false);
      acquiredId = evidence[0].evidenceId;
      return {
        ok: true,
        verdict: 'PASS',
        reason: 'VERIFIED',
        report: report(['CLI stdout is exactly "hello Alice"']),
        assessments: [{
          criterionId: 'AC-001',
          kind: 'cli',
          evidenceIds: [acquiredId],
          verified: true,
          verifier: 'verifier',
        }],
      };
    },
    proofAcquisition: async ({ gaps }) => {
      proofCalls += 1;
      assert.equal(gaps.length, 1);
      const { acquireProof } = await import('../../core/qe/index.mjs');
      return [await acquireProof(gaps[0])];
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  assert.equal(result.pass, true);
  assert.equal(verifierCalls, 2);
  assert.equal(proofCalls, 1);
  const proofDecision = result.decisionTrace.find(d => d.decision === 'acquire_proof');
  assert.equal(proofDecision.stage, 'proof');
  assert.equal(proofDecision.policy.rule, 'proof.cheapest-adequate-proof');
  assert.deepEqual(proofDecision.reasonCodes, ['PROOF_GAP_CLI']);
  assert.deepEqual(proofDecision.facts.kinds, ['cli']);
  assert.equal(proofDecision.facts.reason, 'PROOF_GAP');
  assert.ok(result.events.filter(e => e.stage === 'proof-acquisition').every(e => e.decisionId === proofDecision.decisionId));
  assert.ok(acquiredId);
  assert.equal(result.evidence[0].assessed, true);
  assert.equal(result.evidence[0].verified, true);
  assert.equal(result.evidence[0].evidenceId, acquiredId);
});

test('browser proof gap auto-wires built-in provider and still requires verifier reassessment', async () => {
  let verifierCalls = 0;
  const browserPage = {
    on() {},
    async goto() {},
    locator(selector) {
      return {
        first() { return this; },
        async click() {},
        async textContent() { return selector === '#status' ? 'saved' : ''; },
      };
    },
    async screenshot() {},
    async title() { return 'Browser fixture'; },
    url() { return 'http://example.test/app'; },
    async close() {},
  };
  const playwright = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return { async newPage() { return browserPage; }, async close() {} };
          },
          async close() {},
        };
      },
    },
  };

  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(['Saving through the UI shows saved']),
    requiredProofByCriterion: { 'AC-001': 'browser' },
    proofRequests: {
      'AC-001': {
        requiredKind: 'browser',
        url: 'http://example.test/app',
        browserMode: 'functional',
        actions: [
          { type: 'click', selector: '#save' },
          { type: 'expect-text', selector: '#status', value: 'saved' },
        ],
      },
    },
    browserQa: { playwright },
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async ({ phase, evidence }) => {
      verifierCalls += 1;
      if (phase === 'verification') {
        return {
          ok: false,
          verdict: 'FAIL',
          reason: 'PROOF_GAP',
          report: report(['Saving through the UI shows saved']),
        };
      }
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].kind, 'browser');
      assert.equal(evidence[0].acquired, true);
      assert.equal(evidence[0].assessed, false);
      return {
        ok: true,
        verdict: 'PASS',
        reason: 'VERIFIED',
        report: report(['Saving through the UI shows saved']),
        assessments: [{
          criterionId: 'AC-001',
          kind: 'browser',
          evidenceIds: [evidence[0].evidenceId],
          verified: true,
          verifier: 'verifier',
        }],
      };
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  assert.equal(result.pass, true);
  assert.equal(verifierCalls, 2);
  assert.equal(result.evidence[0].source, 'hybrid-playwright-browser-provider');
  assert.equal(result.evidence[0].verified, true);
});

test('raw proof success with wrong semantic content cannot complete even when command exits zero', async () => {
  let rawEvidence = null;

  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(['CLI stdout is exactly "hello Alice"']),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    proofRequests: {
      'AC-001': {
        requiredKind: 'cli',
        command: [process.execPath, '-e', 'process.stdout.write("hello Bob")'],
      },
    },
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async ({ phase, evidence }) => {
      if (phase === 'verification') {
        return {
          ok: false,
          verdict: 'FAIL',
          reason: 'PROOF_GAP',
          report: report(['CLI stdout is exactly "hello Alice"']),
        };
      }

      rawEvidence = evidence[0];
      assert.equal(rawEvidence.success, true);
      assert.equal(rawEvidence.stdout, 'hello Bob');
      return {
        ok: false,
        verdict: 'FAIL',
        reason: 'FAILURE',
        report: report(['CLI stdout is exactly "hello Alice"']),
        assessments: [{
          criterionId: 'AC-001',
          kind: 'cli',
          evidenceIds: [rawEvidence.evidenceId],
          verified: false,
          verifier: 'verifier',
        }],
      };
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  assert.ok(rawEvidence);
  assert.equal(rawEvidence.exitCode, 0);
  assert.equal(result.pass, false);
  assert.equal(result.evidence[0].assessed, true);
  assert.equal(result.evidence[0].verified, false);
});

test('acquired proof cannot be verifier-assessed unless the verifier consumes its exact evidence id', async () => {
  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(['CLI stdout is exactly "hello Alice"']),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    proofRequests: {
      'AC-001': {
        requiredKind: 'cli',
        command: [process.execPath, '-e', 'process.stdout.write("hello Alice")'],
      },
    },
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async ({ phase, evidence }) => {
      if (phase === 'verification') {
        return {
          ok: false,
          reason: 'PROOF_GAP',
          report: report(['CLI stdout is exactly "hello Alice"']),
        };
      }
      return {
        ok: true,
        reason: 'VERIFIED',
        report: report(['CLI stdout is exactly "hello Alice"']),
        assessments: [{
          criterionId: 'AC-001',
          kind: 'cli',
          evidenceIds: ['different-evidence-id'],
          verified: true,
          verifier: 'verifier',
        }],
      };
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  assert.equal(result.pass, false);
  assert.equal(result.evidence[0].assessed, false);
  assert.equal(result.evidence[0].verified, false);
});

test('Tier 2 full verification requires all acceptance criteria and current snapshot coverage', () => {
  const criteria = ['A works', 'B works'];
  const base = report(criteria, { snapshot: 'R7' });

  const partial = evaluateCompletionGate({
    tier: 2,
    snapshot: 'R7',
    report: {
      ...base,
      independentVerification: {
        verifiedBy: 'verifier',
        coveredCriteria: ['AC-001'],
        snapshot: 'R7',
        fresh: true,
      },
    },
  });
  assert.equal(partial.pass, false);

  const stale = evaluateCompletionGate({
    tier: 2,
    snapshot: 'R8',
    report: {
      ...base,
      snapshot: 'R8',
      independentVerification: {
        verifiedBy: 'verifier',
        coveredCriteria: ['AC-001', 'AC-002'],
        snapshot: 'R7',
        fresh: true,
      },
    },
  });
  assert.equal(stale.pass, false);

  const complete = evaluateCompletionGate({
    tier: 2,
    snapshot: 'R7',
    report: {
      ...base,
      independentVerification: {
        verifiedBy: 'verifier',
        coveredCriteria: ['AC-001', 'AC-002'],
        snapshot: 'R7',
        fresh: true,
      },
    },
  });
  assert.equal(complete.pass, true);
  assert.equal(complete.independentVerification.mode, 'final-verifier-coverage');
});

test('generic shared worker context uses cache only for real reuse opportunities and reuses the snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-cache-'));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-runtime-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');

  const makeRun = () => runQualityClosure({
    repoRoot: root,
    runtimeRoot,
    snapshot: 'R1',
    tier: 1,
    task: task(),
    context: {
      repoRoot: root,
      runtimeRoot,
      reuseSharedContext: true,
      reuseCount: 2,
      gitRevision: 'abc',
      spec: '# SPEC\nA\n',
      plan: { tasks: [{ id: 'quality-task' }] },
    },
    qa: async ({ sharedContext }) => {
      assert.ok(sharedContext);
      return { ok: true, findings: [] };
    },
    verifier: async ({ sharedContext }) => {
      assert.ok(sharedContext);
      return { ok: true, reason: 'VERIFIED', report: report() };
    },
    appendRuntimeEvent: async () => ({ ok: true }),
  });

  const first = await makeRun();
  const second = await makeRun();
  assert.equal(first.pass, true);
  assert.equal(first.cache.used, true);
  assert.equal(first.cache.hit, false);
  assert.equal(second.pass, true);
  assert.equal(second.cache.hit, true);

  let tier0Shared = 'unset';
  const tier0 = await runQualityClosure({
    repoRoot: root,
    snapshot: 'R1',
    tier: 0,
    task: task(),
    context: {
      repoRoot: root,
      reuseSharedContext: true,
      reuseCount: 2,
    },
    qa: async ({ sharedContext }) => {
      tier0Shared = sharedContext;
      return { ok: true, findings: [] };
    },
    verifier: async () => ({
      ok: true,
      report: {
        lightweightVerificationEvidence: {
          kind: 'test',
          fresh: true,
          success: true,
          source: 'focused check',
        },
      },
    }),
    appendRuntimeEvent: async () => ({ ok: true }),
  });
  assert.equal(tier0.pass, true);
  assert.equal(tier0.cache.used, false);
  assert.equal(tier0Shared, null);
});

test('generic quality closure remains correct when passive observability throws', async () => {
  const result = await runQualityClosure({
    snapshot: 'R1',
    tier: 1,
    task: task(),
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async () => ({ ok: true, reason: 'VERIFIED', report: report() }),
    appendRuntimeEvent: async () => {
      throw new Error('logger unavailable');
    },
  });

  assert.equal(result.pass, true);
  assert.equal(result.completion.pass, true);
});


test('generic context cache write failure falls back to normal context without changing correctness', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-cache-fallback-'));
  const runtimeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-cache-blocked-'));
  const blockedRuntime = path.join(runtimeBase, 'not-a-directory');
  await fs.writeFile(blockedRuntime, 'file');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');

  let sawFallbackContext = false;
  const result = await runQualityClosure({
    repoRoot: root,
    runtimeRoot: blockedRuntime,
    snapshot: 'R1',
    tier: 1,
    task: task(),
    context: {
      repoRoot: root,
      runtimeRoot: blockedRuntime,
      reuseSharedContext: true,
      reuseCount: 2,
      gitRevision: 'abc',
      spec: '# SPEC\nA\n',
      plan: { tasks: [{ id: 'quality-task' }] },
    },
    qa: async ({ context, sharedContext, cache }) => {
      sawFallbackContext = Boolean(context?.goal) && sharedContext === null && Boolean(cache.error);
      return { ok: true, findings: [] };
    },
    verifier: async () => ({ ok: true, reason: 'VERIFIED', report: report() }),
  });

  assert.equal(result.pass, true);
  assert.equal(result.cache.used, true);
  assert.equal(result.cache.hit, false);
  assert.ok(result.cache.error);
  assert.equal(sawFallbackContext, true);
});

test('generic quality closure default observability emits valid JSONL lifecycle events', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-observe-repo-'));
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-quality-observe-runtime-'));

  const result = await runQualityClosure({
    repoRoot: root,
    runtimeRoot,
    runId: 'generic-observe',
    snapshot: 'R1',
    tier: 1,
    task: task(),
    qa: async () => ({ ok: true, findings: [] }),
    verifier: async () => ({ ok: true, reason: 'VERIFIED', report: report() }),
  });

  assert.equal(result.pass, true);
  const eventPath = path.join(runtimeRoot, 'runs', 'generic-observe', 'events.jsonl');
  const rows = (await fs.readFile(eventPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(rows.some((event) => event.stage === 'qa' && event.lifecycle === 'start'));
  assert.ok(rows.some((event) => event.stage === 'verifier' && event.lifecycle === 'end'));
  assert.ok(rows.some((event) => event.stage === 'completion' && event.outcome === 'pass'));
});
