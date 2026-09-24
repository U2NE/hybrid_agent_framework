import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightSmokeCase, runCodexExec, validateLiveSmokeWorkspace } from '../../scripts/runtime-smoke.mjs';

test('runtime smoke Case A preflight proves sibling parallel eligibility', () => {
  const result = preflightSmokeCase('A');
  assert.deepEqual(result.waves, [['alpha', 'beta']]);
  assert.equal(result.securityReview, false);
});

test('runtime smoke Case B preflight proves same-file serialization', () => {
  const result = preflightSmokeCase('B');
  assert.deepEqual(result.waves, [['first'], ['second']]);
});

test('runtime smoke Case C preflight proves security quality-lane activation and bounded Luna-max reviewer route', () => {
  const result = preflightSmokeCase('C');
  assert.equal(result.securityReview, true);
  for (const stage of ['tester', 'code-reviewer', 'security-reviewer', 'verifier']) {
    assert.ok(result.pipeline.includes(stage));
  }
  const security = result.modelRouting.stages.find((entry) => entry.stage === 'security-reviewer');
  assert.equal(security.model, 'gpt-6-luna');
  assert.equal(security.routeLevel, 'luna_max');
});


test('runtime smoke Case D preflight proves iterative clarification report semantics', () => {
  const report = preflightSmokeCase('D');

  assert.equal(report.round0.kind, 'topology');
  assert.equal(report.threshold, 0.20);
  assert.ok(report.roundCount >= 2);
  assert.equal(report.rounds.length, report.roundCount);
  assert.ok(report.rounds.every((round) => round.question.length > 0));
  assert.ok(report.rounds.every((round) => round.component && round.dimension));
  assert.ok(report.rounds.every((round) => round.ambiguityBefore !== round.ambiguityAfter));

  const targets = report.rounds.map((round) => round.component + ':' + round.dimension);
  assert.ok(new Set(targets).size >= 2);
  assert.ok(report.final.ambiguity <= report.threshold);
  assert.equal(report.final.pass, true);
  assert.equal(report.final.specReady, true);
  assert.equal(report.final.approvalRequired, true);
  assert.equal(report.final.approvalStatus, 'pending');
});


async function runtimeFixture(key, report, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-smoke-semantic-' + key + '-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.planning'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, 'src', name), content);
  }
  await fs.writeFile(
    path.join(root, '.planning', 'runtime-smoke-report.json'),
    JSON.stringify(report, null, 2)
  );
  return root;
}

test('Case A semantic validator checks overlap outputs routing delegation and verifier', async () => {
  const report = {
    planned_waves: [{ wave: 1, tasks: ['alpha', 'beta'] }],
    observed_waves: [{
      wave: 1,
      tasks: ['alpha', 'beta'],
      sibling_workers: ['/root/alpha', '/root/beta'],
      overlap_observed: true,
      evidence: 'both running',
    }],
    workers: [
      { task: 'alpha', role: 'hybrid-implementer', requested_model: 'gpt-6-luna', reasoning_effort: 'medium', override_accepted: true, delegation_allowed: false, status: 'completed' },
      { task: 'beta', role: 'hybrid-implementer', requested_model: 'gpt-6-luna', reasoning_effort: 'medium', override_accepted: true, delegation_allowed: false, status: 'completed' },
      { task: 'verifier', role: 'hybrid-verifier', delegation_allowed: false, status: 'passed' },
    ],
    verification: { final_verifier: { status: 'passed' } },
  };
  const root = await runtimeFixture('A', report, {
    'alpha.js': 'export const alpha = 1;\n',
    'beta.js': 'export const beta = 2;\n',
  });
  const result = await validateLiveSmokeWorkspace('A', root, preflightSmokeCase('A'));
  assert.equal(result.ok, true);
  assert.equal(result.modelIdentityAttested, false);
});

test('Case B semantic validator rejects same-file overlap and requires both output changes', async () => {
  const good = {
    planned_waves: [{ wave: 1, tasks: ['first'] }, { wave: 2, tasks: ['second'] }],
    observed_waves: [{ wave: 1, tasks: ['first'], overlap_observed: false }, { wave: 2, tasks: ['second'], overlap_observed: false }],
    workers: [
      { task: 'first', role: 'hybrid-implementer', wave: 1, delegation_allowed: false, status: 'completed' },
      { task: 'second', role: 'hybrid-implementer', wave: 2, delegation_allowed: false, status: 'completed' },
      { task: 'verifier', role: 'hybrid-verifier', delegation_allowed: false, status: 'passed' },
    ],
    verification: { final_verifier: { status: 'passed' } },
  };
  const root = await runtimeFixture('B', good, {
    'shared.js': 'export const first = 1;\nexport const second = 2;\n',
  });
  assert.equal((await validateLiveSmokeWorkspace('B', root, preflightSmokeCase('B'))).ok, true);

  good.observed_waves[0].overlap_observed = true;
  await fs.writeFile(path.join(root, '.planning', 'runtime-smoke-report.json'), JSON.stringify(good));
  const bad = await validateLiveSmokeWorkspace('B', root, preflightSmokeCase('B'));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((error) => /overlap/.test(error)));
});

test('Case C semantic validator requires actual quality roles accepted Luna-max security override and auth behavior', async () => {
  const report = {
    planned_waves: [{ wave: 1, tasks: ['auth'] }],
    observed_waves: [{ wave: 1, tasks: ['auth'], overlap_observed: false }],
    workers: [
      { task: 'auth', role: 'hybrid-implementer', delegation_allowed: false, status: 'completed' },
      { task: 'tester', role: 'hybrid-tester', delegation_allowed: false, status: 'passed' },
      { task: 'reviewer', role: 'hybrid-code-reviewer', delegation_allowed: false, status: 'passed' },
      { task: 'security', role: 'hybrid-security-reviewer', requested_model: 'gpt-6-luna', reasoning_effort: 'max', override_accepted: true, delegation_allowed: false, status: 'passed' },
      { task: 'verifier', role: 'hybrid-verifier', delegation_allowed: false, status: 'passed' },
    ],
    verification: {
      security_review: { status: 'passed' },
      final_verifier: { status: 'passed' },
    },
  };
  const root = await runtimeFixture('C', report, {
    'auth.js': 'export function canAccess(user) { return Boolean(user && user.role === "admin"); }\n',
  });
  const result = await validateLiveSmokeWorkspace('C', root, preflightSmokeCase('C'));
  assert.equal(result.ok, true);
  assert.match(result.modelClaim, /not independently attested/);
});


test('Case C validator accepts real-style underscore role and direct route evidence', async () => {
  const report = {
    planned_waves: [
      { wave: 1, roles: ['implementer'] },
      { wave: 2, roles: ['tester', 'code_reviewer', 'security_reviewer'] },
      { wave: 3, roles: ['verifier'] },
    ],
    observed_waves: [
      { wave: 1, roles: ['implementer'] },
      { wave: 2, roles: ['tester', 'code_reviewer', 'security_reviewer'] },
      { wave: 3, roles: ['verifier'] },
    ],
    workers: [
      { role: 'implementer', id: '/root/implementer', model: 'gpt-6-luna', effort: 'medium', accepted: true, status: 'completed' },
      { role: 'tester', id: '/root/tester', model: 'gpt-6-luna', effort: 'medium', accepted: true, status: 'passed' },
      { role: 'code_reviewer', id: '/root/reviewer', model: 'gpt-6-luna', effort: 'high', accepted: true, status: 'passed' },
      { role: 'security_reviewer', id: '/root/security', model: 'gpt-6-luna', effort: 'max', accepted: true, status: 'passed' },
      { role: 'verifier', id: '/root/verifier', model: 'gpt-6-luna', effort: 'medium', accepted: true, status: 'passed' },
    ],
    routes: [
      { role: 'implementer', model: 'gpt-6-luna', reasoning_effort: 'medium' },
      { role: 'tester', model: 'gpt-6-luna', reasoning_effort: 'medium' },
      { role: 'code_reviewer', model: 'gpt-6-luna', reasoning_effort: 'high' },
      { role: 'security_reviewer', model: 'gpt-6-luna', reasoning_effort: 'max' },
      { role: 'verifier', model: 'gpt-6-luna', reasoning_effort: 'medium' },
    ],
    verification: {
      status: 'PASS',
      verdict: 'PASS',
      security_review: { status: 'passed' },
    },
  };
  const root = await runtimeFixture('C-real', report, {
    'auth.js': 'export function canAccess(user) { return Boolean(user && user.role === "admin"); }\n',
  });
  const result = await validateLiveSmokeWorkspace('C', root, preflightSmokeCase('C'));
  assert.equal(result.ok, true);
});

test('Codex exec runner enforces a bounded timeout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-smoke-timeout-'));
  const result = await runCodexExec(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'],
    { cwd: root, timeoutMs: 50 }
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});
