#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareExecution } from '../core/orchestrator/index.mjs';
import {
  confirmInterviewTopology,
  createInterviewState,
  crystallizeInterviewSpec,
  nextInterviewQuestion,
  recordInterviewRound,
} from '../core/requirements/index.mjs';
import { installProject } from './install-project.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

export const SMOKE_CASES = Object.freeze({
  A: {
    title: 'independent sibling parallelism',
    input: {
      task: { request: 'Update two independent files', files: ['src/alpha.js', 'src/beta.js'] },
      request: 'Update two independent files',
      tasks: [
        { id: 'alpha', depends_on: [], files_modified: ['src/alpha.js'] },
        { id: 'beta', depends_on: [], files_modified: ['src/beta.js'] },
      ],
    },
    expectedWaves: [['alpha', 'beta']],
    expectedSecurity: false,
    prompt: [
      'Use $hybrid and execute this as exactly two implementation tasks.',
      'Task alpha: edit only src/alpha.js so it exports const alpha = 1.',
      'Task beta: edit only src/beta.js so it exports const beta = 2.',
      'They are independent and must be sibling workers in the same scheduler wave when the runtime permits parallelism.',
      'Do not let either worker delegate. Run independent verification after implementation.',
      'Record planned/observed waves, worker roles, routed model tiers/models, and any model fallback in .planning/runtime-smoke-report.json. The JSON report must include planned_waves, observed_waves, workers, routes, model_fallbacks, verification, and enough runtime evidence to validate wave overlap/serialization, accepted model+reasoning override requests, no recursive delegation, and final verifier completion.',
    ].join('\n'),
  },
  B: {
    title: 'same-file serialization',
    input: {
      task: { request: 'Apply two separate changes to one shared file', files: ['src/shared.js'] },
      request: 'Apply two separate changes to one shared file',
      tasks: [
        { id: 'first', depends_on: [], files_modified: ['src/shared.js'] },
        { id: 'second', depends_on: [], files_modified: ['src/shared.js'] },
      ],
    },
    expectedWaves: [['first'], ['second']],
    expectedSecurity: false,
    prompt: [
      'Use $hybrid and keep these as two separate implementation tasks even though they touch the same file.',
      'Task first: add export const first = 1 to src/shared.js.',
      'Task second: add export const second = 2 to src/shared.js.',
      'The scheduler must serialize the two same-file writers into different waves; do not run them concurrently.',
      'Do not let workers delegate. Run independent verification.',
      'Record planned/observed waves, worker roles, routed model tiers/models, and any model fallback in .planning/runtime-smoke-report.json.',
    ].join('\n'),
  },
  D: {
    title: 'OMC-style iterative clarification',
    interactive: true,
  },
  C: {
    title: 'security-sensitive quality lanes',
    input: {
      task: { request: 'Change auth authorization permission checks', files: ['src/auth.js'] },
      request: 'Change auth authorization permission checks',
      securityRelevant: true,
      tasks: [{ id: 'auth', depends_on: [], files_modified: ['src/auth.js'] }],
    },
    expectedWaves: [['auth']],
    expectedSecurity: true,
    prompt: [
      'Use $hybrid for a security-sensitive auth change.',
      'Modify src/auth.js so canAccess(user) returns true only when user exists and user.role === "admin".',
      'This must activate tester, code reviewer, security reviewer, and verifier as separate quality roles.',
      'After the implementer finishes, run tester, code reviewer, and security reviewer as independent sibling QA workers in the same QA wave when safe; after all three return, run the verifier last.',
      'Keep each QA worker focused on this one-file change and return promptly; do not perform unrelated repository exploration.',
      'The bounded security reviewer should use Luna max; routine tester/verifier work should remain/downshift to Luna unless another escalation condition is present.',
      'Do not let workers delegate.',
      'Record planned/observed roles, security activation, routed model tiers/models, and any model fallback in .planning/runtime-smoke-report.json. The JSON report must include planned_waves, observed_waves, workers, routes, model_fallbacks, verification, and enough runtime evidence to validate wave overlap/serialization, accepted model+reasoning override requests, no recursive delegation, and final verifier completion.',
    ].join('\n'),
  },
});

export function preflightSmokeCase(name) {
  const key = String(name || '').toUpperCase();
  const spec = SMOKE_CASES[key];
  if (!spec) throw new Error('unknown smoke case: ' + name);

  if (key === 'D') {
    const report = runClarificationFixture();
    assert.equal(report.round0.kind, 'topology');
    assert.ok(report.roundCount >= 2);
    assert.equal(report.rounds.length, report.roundCount);
    assert.ok(report.rounds.every((round) => round.component && round.dimension && round.question));
    assert.ok(report.rounds.every((round) => round.ambiguityBefore !== round.ambiguityAfter));
    assert.ok(new Set(report.rounds.map((round) => round.component + ':' + round.dimension)).size >= 2);
    assert.ok(report.final.ambiguity <= report.threshold);
    assert.equal(report.final.pass, true);
    assert.equal(report.final.specReady, true);
    return report;
  }

  const result = prepareExecution(spec.input);
  const waves = result.waves.map((wave) => wave.map((task) => task.id));
  assert.deepEqual(waves, spec.expectedWaves);
  assert.equal(result.securityReview, spec.expectedSecurity);

  if (key === 'A') {
    assert.equal(result.waves[0].length, 2);
    assert.equal(route(result, 'implementer').model, 'gpt-6-luna');
  }
  if (key === 'B') assert.equal(result.waves.length, 2);
  if (key === 'C') {
    for (const stage of ['tester', 'code-reviewer', 'security-reviewer', 'verifier']) assert.ok(result.pipeline.includes(stage));
    assert.equal(route(result, 'security-reviewer').routeLevel, 'luna_max');
  }

  return {
    case: key,
    title: spec.title,
    waves,
    securityReview: result.securityReview,
    pipeline: result.pipeline,
    modelRouting: result.modelRouting,
  };
}

export function runClarificationFixture() {
  let state = createInterviewState({
    initialIdea: '알아서 로그인 기능 좋게 만들어줘',
    type: 'greenfield',
  });

  const round0 = nextInterviewQuestion(state, {}, {
    topologyCandidates: [
      { id: 'auth-flow', name: 'Auth Flow', description: 'Login and authentication behavior' },
      { id: 'session-policy', name: 'Session Policy', description: 'Session lifetime and post-login behavior' },
    ],
  });

  state = confirmInterviewTopology(state, {
    components: round0.candidates,
    confirmedAt: '2026-01-01T00:00:00.000Z',
  });

  const rounds = [];

  let spec = {
    type: 'greenfield',
    goal: 'Create a usable login feature',
    acceptanceCriteria: ['The confirmed login flow can be verified end to end'],
    topology: [
      { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.35, constraints: 0.45, criteria: 0.40 } },
      { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.55, constraints: 0.60, criteria: 0.45 } },
    ],
  };

  let question = nextInterviewQuestion(state, spec);
  let recorded = recordInterviewRound(state, {
    question,
    answer: 'Email/password login is the primary goal; social login is out of scope.',
    spec: {
      ...spec,
      topology: [
        { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.80, constraints: 0.45, criteria: 0.50 } },
        { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.55, constraints: 0.60, criteria: 0.45 } },
      ],
    },
  });
  state = recorded.state;
  spec = {
    ...spec,
    topology: [
      { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.80, constraints: 0.45, criteria: 0.50 } },
      { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.55, constraints: 0.60, criteria: 0.45 } },
    ],
  };
  rounds.push(reportRound(recorded));

  question = nextInterviewQuestion(state, spec);
  recorded = recordInterviewRound(state, {
    question,
    answer: 'A valid session must survive refresh, expire after 24 hours, and redirect expired users to login.',
    spec: {
      ...spec,
      topology: [
        { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.80, constraints: 0.65, criteria: 0.60 } },
        { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.75, constraints: 0.70, criteria: 0.80 } },
      ],
    },
  });
  state = recorded.state;
  spec = {
    ...spec,
    topology: [
      { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.80, constraints: 0.65, criteria: 0.60 } },
      { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.75, constraints: 0.70, criteria: 0.80 } },
    ],
  };
  rounds.push(reportRound(recorded));

  question = nextInterviewQuestion(state, spec);
  recorded = recordInterviewRound(state, {
    question,
    answer: 'Success means correct credentials enter the app, wrong credentials remain out, and lockout/error states are testable.',
    spec: {
      ...spec,
      constraints: ['Email/password only', 'No social login'],
      nonGoals: ['SSO', 'Social login'],
      topology: [
        { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.90, constraints: 0.75, criteria: 0.85 } },
        { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.85, constraints: 0.75, criteria: 0.85 } },
      ],
    },
  });
  state = recorded.state;
  spec = {
    ...spec,
    constraints: ['Email/password only', 'No social login'],
    nonGoals: ['SSO', 'Social login'],
    topology: [
      { id: 'auth-flow', name: 'Auth Flow', status: 'active', clarity: { goal: 0.90, constraints: 0.75, criteria: 0.85 } },
      { id: 'session-policy', name: 'Session Policy', status: 'active', clarity: { goal: 0.85, constraints: 0.75, criteria: 0.85 } },
    ],
  };
  rounds.push(reportRound(recorded));

  const progress = recorded.progress;
  const crystallized = crystallizeInterviewSpec(state, spec, progress);

  return {
    case: 'D',
    title: 'OMC-style iterative clarification',
    threshold: state.threshold,
    topology: state.topology.components.map((component) => ({
      id: component.id,
      status: component.status,
    })),
    round0: {
      kind: round0.kind,
      question: round0.question,
      components: round0.candidates.map((component) => component.id),
    },
    roundCount: state.roundCount,
    rounds,
    final: {
      ambiguity: state.currentAmbiguity,
      pass: progress.pass === true,
      specReady: progress.specReady === true,
      approvalRequired: progress.approvalRequired === true,
      completion: progress.kind,
      approvalStatus: crystallized.clarification.approvalStatus,
    },
  };
}

function reportRound(recorded) {
  return {
    round: recorded.round.round,
    component: recorded.round.targetComponent,
    dimension: recorded.round.targetDimension,
    question: recorded.round.question,
    ambiguityBefore: recorded.round.ambiguityBefore,
    ambiguityAfter: recorded.round.ambiguityAfter,
  };
}

export async function runLiveSmokeCase(name, options = {}) {
  const key = String(name || '').toUpperCase();
  const spec = SMOKE_CASES[key];
  if (!spec) throw new Error('unknown smoke case: ' + name);
  const preflight = preflightSmokeCase(key);

  if (key === 'D') {
    return {
      status: 'runtime-validation-pending',
      case: key,
      reason: 'Case D requires real user answers across multiple interview rounds; deterministic fixture passed but interactive Codex runtime is not auto-simulated.',
      preflight,
    };
  }

  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await runCodexDoctor(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: key,
      reason: doctor.summary || 'Codex credentials are not ready',
      codexVersion: doctor.codexVersion,
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-runtime-smoke-' + key + '-'));
  await execFileAsync('git', ['init', '-q', workspace]);
  await seedCase(workspace, key);
  await installProject(workspace, { skipCodexValidation: true });

  const traceDir = path.join(workspace, '.planning', 'runtime-smoke');
  await fs.mkdir(traceDir, { recursive: true });
  const eventsPath = path.join(traceDir, 'events.jsonl');
  const stderrPath = path.join(traceDir, 'stderr.log');

  const startedAt = Date.now();
  const run = await runCodexExec(codexBin, [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    options.sandbox || 'workspace-write',
    '--cd',
    workspace,
    spec.prompt,
  ], {
    cwd: workspace,
    timeoutMs: options.timeoutMs || 240000,
  });

  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  let semantic = null;
  if (run.code === 0) {
    semantic = await validateLiveSmokeWorkspace(key, workspace, preflight);
  }

  const completed = run.code === 0 && semantic?.ok === true;
  return {
    status: completed ? 'completed' : 'failed',
    case: key,
    workspace,
    eventsPath,
    stderrPath,
    elapsedMs: Date.now() - startedAt,
    exitCode: run.code,
    semantic,
    timedOut: run.timedOut === true,
    ...(completed
      ? {}
      : {
          error: run.timedOut
            ? 'codex exec timed out'
            : run.code === 0
              ? 'semantic runtime assertions failed'
              : (run.error || 'codex exec failed'),
        }),
  };
}

export async function validateLiveSmokeWorkspace(key, workspace, preflight = null) {
  const reportPath = path.join(workspace, '.planning', 'runtime-smoke-report.json');
  const errors = [];
  let report;

  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      errors: ['runtime-smoke-report.json missing or invalid: ' + String(error.message || error)],
      reportPath,
    };
  }

  const planned = normalizeReportedWaves(report.planned_waves || report.plannedWaves || []);
  const observed = normalizeReportedWaves(report.observed_waves || report.observedWaves || []);
  const expected = preflight?.waves || SMOKE_CASES[key]?.expectedWaves || [];
  if (key === 'A' || key === 'B') {
    if (!sameNestedArray(planned, expected)) errors.push('planned waves do not match expected scheduler waves');
    if (!sameNestedArray(observed, expected)) errors.push('observed waves do not match expected scheduler waves');
  }

  const workers = Array.isArray(report.workers) ? report.workers : [];
  if (workers.some((worker) => worker.delegation_allowed === true || worker.delegated === true)) {
    errors.push('recursive delegation was observed');
  }

  const verifierWorker = workers.find((worker) =>
    String(worker.role || '').includes('verifier') ||
    worker.task === 'verifier' ||
    worker.id === 'verifier'
  );
  const verifierStatus =
    report.verification?.final_verifier?.status ||
    report.verification?.finalVerifier?.status ||
    report.verification?.status ||
    verifierWorker?.status;
  const verifierVerdict =
    report.verification?.final_verifier?.verdict ||
    report.verification?.finalVerifier?.verdict ||
    report.verification?.verdict ||
    null;
  const verifierCompleted =
    /^(pass|passed|completed)$/i.test(String(verifierStatus || '')) &&
    (!verifierVerdict || /^pass$/i.test(String(verifierVerdict)));
  if (!verifierCompleted) {
    errors.push('final verifier completion not evidenced');
  }

  if (key === 'A') {
    const alpha = await readText(path.join(workspace, 'src', 'alpha.js'), errors);
    const beta = await readText(path.join(workspace, 'src', 'beta.js'), errors);
    if (!/^export const alpha = 1;\s*$/.test(alpha)) errors.push('src/alpha.js output is incorrect');
    if (!/^export const beta = 2;\s*$/.test(beta)) errors.push('src/beta.js output is incorrect');

    const observedWave = (report.observed_waves || report.observedWaves || [])[0] || {};
    if (observedWave.overlap_observed !== true && observedWave.overlapObserved !== true) {
      errors.push('parallel overlap was not observed');
    }
    const explicitSiblings = observedWave.sibling_workers || observedWave.siblingWorkers || [];
    const snapshotSiblings = (report.runtime_evidence?.pre_release_snapshot?.agents || [])
      .filter((agent) => String(agent.agent_name || '') !== '/root')
      .filter((agent) => String(agent.agent_status || '').toLowerCase() === 'running')
      .map((agent) => agent.agent_name);
    const siblings = explicitSiblings.length ? explicitSiblings : snapshotSiblings;
    if (!Array.isArray(siblings) || siblings.length < 2) {
      errors.push('two sibling workers were not observed');
    }

    for (const taskId of ['alpha', 'beta']) {
      const worker = workers.find((item) => item.task === taskId || item.id === taskId);
      if (!worker) {
        errors.push('missing implementation worker for ' + taskId);
        continue;
      }
      if (!String(worker.role || '').includes('implementer')) errors.push(taskId + ' worker was not implementer');
      const route = routeEvidenceForWorker(report, worker);
      const requestedModel = worker.requested_model || route?.model;
      const reasoningEffort = worker.reasoning_effort || route?.reasoning_effort;
      const overrideAccepted =
        worker.override_accepted ??
        route?.override_request_accepted ??
        route?.overrideAccepted;
      if (requestedModel !== 'gpt-6-luna') errors.push(taskId + ' did not request Luna');
      if (reasoningEffort !== 'medium') errors.push(taskId + ' did not request medium effort');
      if (overrideAccepted !== true) errors.push(taskId + ' model/effort override not recorded as accepted');
    }
  }

  if (key === 'B') {
    const shared = await readText(path.join(workspace, 'src', 'shared.js'), errors);
    if (!/export const first = 1;/.test(shared)) errors.push('shared.js missing first change');
    if (!/export const second = 2;/.test(shared)) errors.push('shared.js missing second change');
    if (observed.length !== 2 || observed.some((wave) => wave.length !== 1)) {
      errors.push('same-file writers were not observed in separate waves');
    }
    const firstWorker = workers.find((item) => item.task === 'first' || item.id === 'first');
    const secondWorker = workers.find((item) => item.task === 'second' || item.id === 'second');
    if (!firstWorker || !secondWorker) errors.push('same-file implementation workers missing');
    if (
      firstWorker &&
      secondWorker &&
      firstWorker.wave != null &&
      secondWorker.wave != null &&
      firstWorker.wave === secondWorker.wave
    ) {
      errors.push('same-file implementation workers reported the same wave');
    }
    const reportedObserved = report.observed_waves || report.observedWaves || [];
    if (reportedObserved.some((wave) => wave.overlap_observed === true || wave.overlapObserved === true)) {
      errors.push('same-file writer overlap was reported');
    }
  }

  if (key === 'C') {
    const source = await readText(path.join(workspace, 'src', 'auth.js'), errors);
    if (source) {
      try {
        const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#smoke=' + Date.now());
        if (module.canAccess({ role: 'admin' }) !== true) errors.push('admin access behavior incorrect');
        if (module.canAccess({ role: 'user' }) !== false) errors.push('non-admin access behavior incorrect');
        if (module.canAccess(null) !== false) errors.push('null-user access behavior incorrect');
      } catch (error) {
        errors.push('auth output could not be executed: ' + String(error.message || error));
      }
    }

    const requiredRoles = ['tester', 'code-reviewer', 'security-reviewer', 'verifier'];
    for (const role of requiredRoles) {
      if (!workers.some((worker) => normalizeRole(worker.role) === role)) {
        errors.push('missing observed ' + role + ' worker');
      }
    }

    const security =
      workers.find((worker) => normalizeRole(worker.role) === 'security-reviewer') ||
      null;
    if (security) {
      const route = routeEvidenceForWorker(report, security);
      const requestedModel = security.requested_model || security.model || route?.model;
      const reasoningEffort =
        security.reasoning_effort ||
        security.effort ||
        route?.reasoning_effort ||
        route?.reasoningEffort;
      const overrideAccepted =
        security.override_accepted ??
        security.overrideAccepted ??
        security.spawnAccepted ??
        security.accepted ??
        route?.override_request_accepted ??
        route?.overrideAccepted ??
        route?.spawnAccepted ??
        route?.accepted;
      if (requestedModel !== 'gpt-6-luna') errors.push('security reviewer did not request gpt-6-luna');
      if (reasoningEffort !== 'max') errors.push('security reviewer did not request max effort');
      if (overrideAccepted !== true) errors.push('security reviewer override was not recorded as accepted');
    }

    const securityStatus =
      report.verification?.security_review?.status ||
      report.verification?.securityReview?.status ||
      security?.status;
    if (!/^(passed|completed)$/i.test(String(securityStatus || ''))) {
      errors.push('security review completion not evidenced');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    reportPath,
    report,
    modelIdentityAttested: false,
    modelClaim: 'Only requested/accepted model and reasoning overrides are asserted; underlying model identity is not independently attested.',
  };
}

function routeEvidenceForWorker(report, worker) {
  const routes = report.routes;
  if (Array.isArray(routes)) {
    return routes.find((route) =>
      (worker.agent && route.agent === worker.agent) ||
      (worker.id && (route.task === worker.id || route.id === worker.id)) ||
      (worker.task && (route.task === worker.task || route.id === worker.task)) ||
      (worker.role && route.role && normalizeRole(route.role) === normalizeRole(worker.role))
    ) || null;
  }
  if (routes && typeof routes === 'object') {
    const role = normalizeRole(worker.role);
    return routes[worker.task] || routes[worker.id] || routes[role] || routes[role.replace(/-/g, '_')] || null;
  }
  return null;
}

function normalizeRole(value) {
  return String(value || '')
    .replace(/^hybrid[-_]/, '')
    .replace(/_/g, '-')
    .toLowerCase();
}

function normalizeReportedWaves(waves) {
  return (Array.isArray(waves) ? waves : []).map((wave) => {
    if (Array.isArray(wave)) return wave.map(String);
    return (wave?.tasks || []).map(String);
  });
}

function sameNestedArray(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function readText(target, errors) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    errors.push('missing output file ' + target + ': ' + String(error.message || error));
    return '';
  }
}

async function seedCase(root, key) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  if (key === 'A') {
    await fs.writeFile(path.join(root, 'src', 'alpha.js'), 'export const alpha = 0;\n');
    await fs.writeFile(path.join(root, 'src', 'beta.js'), 'export const beta = 0;\n');
  } else if (key === 'B') {
    await fs.writeFile(path.join(root, 'src', 'shared.js'), '// runtime smoke\n');
  } else {
    await fs.writeFile(path.join(root, 'src', 'auth.js'), 'export function canAccess(user) { return Boolean(user); }\n');
  }
}

export async function runCodexExec(codexBin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(codexBin, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeoutMs = Number(options.timeoutMs || 0);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    timer?.unref?.();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, timedOut });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr, error: String(error.message || error) });
    });
    child.on('close', (code, signal) => {
      finish({
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        error: code === 0 ? null : (
          timedOut
            ? 'codex exec timed out after ' + timeoutMs + 'ms'
            : 'codex exited with code ' + code + (signal ? ' signal ' + signal : '')
        ),
      });
    });
  });
}

async function runCodexDoctor(codexBin) {
  try {
    const { stdout } = await execFileAsync(codexBin, ['doctor', '--json'], { maxBuffer: 4 * 1024 * 1024 });
    return parseDoctor(stdout);
  } catch (error) {
    if (error.code === 'ENOENT') return { authStatus: 'missing-cli', summary: 'Codex CLI not found', codexVersion: null };
    return parseDoctor(error.stdout, error.stderr || error.message);
  }
}

function parseDoctor(stdout, fallback = '') {
  try {
    const report = JSON.parse(String(stdout || ''));
    const auth = report.checks?.['auth.credentials'];
    return { authStatus: auth?.status || 'unknown', summary: auth?.summary || fallback, codexVersion: report.codexVersion || null };
  } catch {
    return { authStatus: 'unknown', summary: String(fallback || 'unable to parse codex doctor output'), codexVersion: null };
  }
}

function route(result, stage) {
  return result.modelRouting.stages.find((entry) => entry.stage === stage);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const liveIndex = args.indexOf('--live');
  if (liveIndex >= 0) {
    const result = await runLiveSmokeCase(args[liveIndex + 1]);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'completed') process.exitCode = 1;
  } else {
    const requested = args.includes('--preflight') ? ['A', 'B', 'C', 'D'] : [String(args[0] || 'A').toUpperCase()];
    console.log(JSON.stringify(requested.map(preflightSmokeCase), null, 2));
  }
}
