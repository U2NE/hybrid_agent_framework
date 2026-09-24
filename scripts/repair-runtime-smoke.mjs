#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installProject } from './install-project.mjs';
import { runCodexExec } from './runtime-smoke.mjs';
import { runQualityClosure } from '../core/orchestrator/index.mjs';
import {
  MAX_REPAIR_CYCLES,
  shouldTriggerRepair,
} from '../core/repair/index.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const CRITERION = 'normalizeUser(null) must return null while valid users have trimmed lowercase names';

export function preflightRepairSmoke() {
  assert.equal(MAX_REPAIR_CYCLES, 3);
  assert.equal(
    shouldTriggerRepair({
      severity: 'high',
      criterionId: 'AC-001',
      evidence: 'null input throws TypeError',
    }),
    true
  );
  assert.equal(
    shouldTriggerRepair({ severity: 'low', category: 'style', evidence: 'rename local' }),
    false
  );
  return {
    case: 'G',
    title: 'authenticated review-fix-review convergence',
    maxRepairCycles: MAX_REPAIR_CYCLES,
    repairOwner: 'implementer',
    reviewerWriteAccess: false,
  };
}

export async function runAuthenticatedRepairSmoke(options = {}) {
  const preflight = preflightRepairSmoke();
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await doctorStatus(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: 'G',
      reason: doctor.summary || 'Codex credentials are not ready',
      preflight,
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-repair-smoke-main-'));
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-repair-smoke-evidence-'));
  await execFileAsync('git', ['init', '-q'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'Hybrid Runtime Smoke'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'hybrid-smoke@example.invalid'], { cwd: workspace });
  await seedWorkspace(workspace);
  await installProject(workspace, { skipCodexValidation: true });
  await commitAll(workspace, 'repair smoke R1 buggy baseline');

  const initialHead = await gitHead(workspace);
  const initialTest = await runFocusedTest(workspace);
  const qaCycles = [];
  const repairRuns = [];
  const verifierRuns = [];
  let runtimeError = null;
  let closure = null;

  try {
    closure = await runQualityClosure({
      repoRoot: workspace,
      runtimeRoot: evidenceRoot,
      runId: 'case-g',
      taskId: 'normalize-user',
      snapshot: initialHead,
      tier: 1,
      maxRepairIterations: MAX_REPAIR_CYCLES,
      task: {
        id: 'normalize-user',
        goal: 'Normalize valid users and return null for null input.',
        files_modified: ['src/user.js'],
        acceptance_criteria: [CRITERION],
        verify: 'node --test tests/user.test.mjs',
        owner: 'implementer',
      },
      qa: async ({ attempt, snapshot }) => {
        const startedAt = Date.now();
        const runs = await Promise.all([
          runQaRole({
            role: 'tester',
            codexBin,
            workspace,
            evidenceRoot,
            attempt,
            snapshot,
            timeoutMs: options.qaTimeoutMs || 180000,
          }),
          runQaRole({
            role: 'code-reviewer',
            codexBin,
            workspace,
            evidenceRoot,
            attempt,
            snapshot,
            timeoutMs: options.qaTimeoutMs || 180000,
          }),
        ]);
        const directTest = await runFocusedTest(workspace);
        const cycle = {
          attempt,
          snapshot,
          startedAt,
          endedAt: Date.now(),
          runs,
          directTest,
          overlapObserved: intervalsOverlap(runs),
        };
        qaCycles.push(cycle);

        const findings = runs.flatMap((run) => run.output.findings || []);
        return {
          ok:
            directTest.exitCode === 0 &&
            runs.every((run) => run.output.ok === true) &&
            findings.length === 0,
          findings,
          evidence: {
            directTest,
            roles: runs.map((run) => run.role),
          },
        };
      },
      verifier: async ({ attempt, snapshot, qa }) => {
        const run = await runVerifier({
          codexBin,
          workspace,
          evidenceRoot,
          attempt,
          snapshot,
          timeoutMs: options.verifierTimeoutMs || 180000,
        });
        verifierRuns.push(run);
        const ok =
          run.exitCode === 0 &&
          run.timedOut !== true &&
          run.output.verdict === 'PASS' &&
          run.testCommandPassed === true &&
          qa?.ok !== false;
        return {
          ok,
          verdict: ok ? 'PASS' : 'FAIL',
          reason: ok ? 'VERIFIED' : 'FIX_REQUIRED',
          findings: run.output.findings || [],
          report: completionReport(snapshot),
          evidence: {
            testCommandPassed: run.testCommandPassed,
            eventsPath: run.eventsPath,
          },
        };
      },
      repairImplementation: async ({ attempt, snapshot, packet, route, owner }) => {
        const run = await runImplementerRepair({
          codexBin,
          workspace,
          evidenceRoot,
          attempt,
          snapshot,
          packet,
          route,
          timeoutMs: options.repairTimeoutMs || 180000,
        });
        const directTest = await runFocusedTest(workspace);
        const changedFiles = lines(
          (await execFileAsync('git', ['diff', '--name-only'], { cwd: workspace })).stdout
        );

        if (
          run.exitCode !== 0 ||
          run.timedOut ||
          directTest.exitCode !== 0 ||
          changedFiles.length !== 1 ||
          changedFiles[0] !== 'src/user.js'
        ) {
          throw new Error('repair implementation did not produce the bounded verified fix');
        }

        await commitAll(workspace, 'repair smoke R' + (attempt + 1));
        const nextSnapshot = await gitHead(workspace);
        const record = {
          attempt,
          owner,
          priorSnapshot: snapshot,
          nextSnapshot,
          route: summarizeRoute(route),
          runtime: run,
          directTest,
          changedFiles,
          packetFingerprint: packet.fingerprint,
          criterionId: packet.finding.criterionId,
        };
        repairRuns.push(record);
        return {
          changed: true,
          snapshot: nextSnapshot,
          evidence: record,
        };
      },
    });
  } catch (error) {
    runtimeError = String(error?.message || error);
  }

  const finalHead = await gitHead(workspace);
  const finalTest = await runFocusedTest(workspace);
  const finalModule = await inspectFinalBehavior(workspace);
  const finalStatus = lines(
    (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout
  );

  const report = {
    schema: 'hybrid-repair-runtime-smoke/v1',
    case: 'G',
    preflight,
    workspace,
    evidenceRoot,
    initial: {
      snapshot: initialHead,
      test: initialTest,
      defectReproduced: initialTest.exitCode !== 0,
    },
    productionPrimitive: 'runQualityClosure',
    qaCycles,
    repairRuns,
    verifierRuns,
    convergence: closure?.convergence
      ? {
          ok: closure.convergence.ok,
          blocked: closure.convergence.blocked === true,
          attempts: closure.convergence.attempts,
          repairCount: closure.convergence.repairs?.length || 0,
          snapshot: closure.convergence.snapshot,
        }
      : null,
    qualityClosure: closure
      ? {
          pass: closure.pass,
          verdict: closure.verdict,
          reason: closure.reason,
          snapshot: closure.snapshot,
          completion: closure.completion,
          gates: closure.gates,
          eventStages: closure.events.map((event) => event.stage),
        }
      : null,
    final: {
      snapshot: finalHead,
      test: finalTest,
      behavior: finalModule,
      gitStatus: finalStatus,
    },
    runtimeError,
  };
  const semantic = validateRepairSmokeReport(report);
  const reportPath = path.join(evidenceRoot, 'repair-runtime-smoke-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  return {
    status: semantic.ok && !runtimeError ? 'completed' : 'failed',
    case: 'G',
    workspace,
    evidenceRoot,
    reportPath,
    semantic,
    report,
  };
}

export function validateRepairSmokeReport(report = {}) {
  const errors = [];

  if (report.productionPrimitive !== 'runQualityClosure') {
    errors.push('Case G did not consume the generic runQualityClosure production primitive');
  }
  if (report.qualityClosure?.pass !== true || report.qualityClosure?.completion?.pass !== true) {
    errors.push('generic quality closure did not reach completion PASS');
  }

  if (report.initial?.defectReproduced !== true || report.initial?.test?.exitCode === 0) {
    errors.push('initial defect was not objectively reproduced');
  }

  const cycles = Array.isArray(report.qaCycles) ? report.qaCycles : [];
  const first = cycles[0];
  const last = cycles.at(-1);
  if (!first || first.runs?.length !== 2) {
    errors.push('initial independent QA pair is missing');
  } else {
    const roles = new Set(first.runs.map((run) => run.role));
    if (!roles.has('tester') || !roles.has('code-reviewer')) {
      errors.push('initial QA did not include tester and code reviewer');
    }
    if (!first.overlapObserved) errors.push('initial QA siblings did not overlap');
    if (!first.runs.every((run) => run.testCommandObserved === true)) {
      errors.push('initial QA lacks focused test command evidence');
    }
    if (!first.runs.some((run) =>
      Array.isArray(run.output?.findings) &&
      run.output.findings.some((finding) => /null|TypeError/i.test(String(finding.evidence || finding.message || '')))
    )) {
      errors.push('independent QA did not report the real null defect');
    }
  }

  const repairs = Array.isArray(report.repairRuns) ? report.repairRuns : [];
  if (repairs.length < 1 || repairs.length > MAX_REPAIR_CYCLES) {
    errors.push('repair count is outside the bounded range');
  } else {
    const repair = repairs[0];
    if (repair.owner !== 'implementer') errors.push('repair was not performed by implementation owner');
    if (repair.priorSnapshot === repair.nextSnapshot) errors.push('repair did not change snapshot');
    if (repair.runtime?.delegationObserved === true) errors.push('repair implementer recursively delegated');
    if (repair.directTest?.exitCode !== 0) errors.push('repair did not objectively fix focused behavior');
    if (JSON.stringify(repair.changedFiles) !== JSON.stringify(['src/user.js'])) {
      errors.push('repair escaped assigned file ownership');
    }
  }

  if (!last || last === first) {
    errors.push('post-fix QA cycle is missing');
  } else {
    if (last.directTest?.exitCode !== 0) errors.push('post-fix QA observed a failing focused test');
    if (!last.runs?.every((run) => run.output?.ok === true && (run.output?.findings || []).length === 0)) {
      errors.push('post-fix QA did not clear the defect');
    }
    if (repairs[0] && Number(last.startedAt) <= Number(repairs[0].runtime?.endedAt || 0)) {
      errors.push('post-fix QA did not run after the repair');
    }
  }

  const verifiers = Array.isArray(report.verifierRuns) ? report.verifierRuns : [];
  const finalVerifier = verifiers.at(-1);
  if (!finalVerifier) {
    errors.push('fresh final verifier is missing');
  } else {
    if (finalVerifier.output?.verdict !== 'PASS') errors.push('final verifier did not return PASS');
    if (finalVerifier.testCommandPassed !== true) errors.push('final verifier lacks passing command evidence');
    if (finalVerifier.delegationObserved === true) errors.push('final verifier recursively delegated');
    if (repairs[0] && Number(finalVerifier.startedAt) <= Number(repairs[0].runtime?.endedAt || 0)) {
      errors.push('final verifier did not run after repair');
    }
  }

  if (report.convergence?.ok !== true) errors.push('repair controller did not converge');
  if ((report.convergence?.repairCount || 0) > MAX_REPAIR_CYCLES) errors.push('repair controller exceeded cap');
  if (report.final?.snapshot === report.initial?.snapshot) errors.push('final snapshot did not change');
  if (report.final?.test?.exitCode !== 0) errors.push('final focused test is not passing');
  if (report.final?.behavior?.nullResult !== null) errors.push('final null behavior is incorrect');
  if (report.final?.behavior?.validName !== 'alice') errors.push('final valid-user normalization is incorrect');
  if ((report.final?.gitStatus || []).length !== 0) errors.push('final smoke repository is not clean');
  if (report.runtimeError) errors.push('runtime error: ' + report.runtimeError);

  for (const cycle of cycles) {
    for (const run of cycle.runs || []) {
      if (run.delegationObserved === true) errors.push(run.role + ' recursively delegated');
    }
  }

  return { ok: errors.length === 0, errors };
}

function completionReport(snapshot) {
  return {
    criteria: [CRITERION],
    planTasks: [{
      id: 'normalize-user',
      acceptance_criteria: [CRITERION],
    }],
    implementationEvidence: {
      'AC-001': { evidence: 'src/user.js normalizeUser implementation' },
    },
    verificationEvidence: {
      'AC-001': {
        status: 'VERIFIED',
        evidence: 'fresh independent focused test and behavior inspection',
      },
    },
    freshTestOutput: true,
    buildApplicable: false,
    typecheckApplicable: false,
    lintApplicable: false,
    specGoalAligned: true,
    snapshot,
  };
}

async function runQaRole({ role, codexBin, workspace, evidenceRoot, attempt, snapshot, timeoutMs }) {
  const id = role.replace(/-/g, '_') + '-attempt-' + attempt;
  const prompt = [
    'Act as the independent Hybrid ' + role + ' on integrated snapshot ' + snapshot + '.',
    'You are read-only. Do not modify files and do not spawn or delegate.',
    'Acceptance criterion: ' + CRITERION,
    'Run exactly: node --test tests/user.test.mjs',
    'Inspect src/user.js and the focused test.',
    'Return exactly one JSON object and no markdown.',
    'Shape: {"role":' + JSON.stringify(role) + ',"ok":true|false,"findings":[{"severity":"high|medium|low","category":"correctness","criterionId":"AC-001","criterion":' + JSON.stringify(CRITERION) + ',"file":"src/user.js","symbol":"normalizeUser","evidence":"specific observed evidence","expectedBehavior":"specific expected behavior","requiredVerification":"node --test tests/user.test.mjs"}]}',
    'If the focused test fails because null input throws, report that material defect. If all acceptance behavior passes, return ok=true and findings=[].',
  ].join('\n');

  return runJsonRole({
    id,
    role,
    codexBin,
    workspace,
    evidenceRoot,
    sandbox: 'read-only',
    model: 'gpt-6-luna',
    effort: role === 'code-reviewer' ? 'high' : 'medium',
    prompt,
    timeoutMs,
    expectFocusedTest: true,
  });
}

async function runVerifier({ codexBin, workspace, evidenceRoot, attempt, snapshot, timeoutMs }) {
  const prompt = [
    'Act as the independent final Hybrid verifier on post-repair snapshot ' + snapshot + '.',
    'You are read-only. Do not modify files and do not spawn or delegate.',
    'Acceptance criterion: ' + CRITERION,
    'Run exactly: node --test tests/user.test.mjs',
    'Return exactly one JSON object and no markdown.',
    'Shape: {"role":"verifier","verdict":"PASS|FAIL","findings":[],"evidence":"specific fresh command result"}',
    'PASS is allowed only when the focused test command succeeds and the criterion is satisfied.',
  ].join('\n');

  const run = await runJsonRole({
    id: 'verifier-attempt-' + attempt,
    role: 'verifier',
    codexBin,
    workspace,
    evidenceRoot,
    sandbox: 'read-only',
    model: 'gpt-6-luna',
    effort: 'medium',
    prompt,
    timeoutMs,
    expectFocusedTest: true,
  });
  return {
    ...run,
    testCommandPassed: passingFocusedTestCommand(run.stdout),
  };
}

async function runImplementerRepair({
  codexBin,
  workspace,
  evidenceRoot,
  attempt,
  snapshot,
  packet,
  route,
  timeoutMs,
}) {
  const prompt = [
    'Act as the Hybrid implementation owner performing targeted repair only.',
    'Do not spawn or delegate. Do not edit tests, planning files, config, or any file except src/user.js.',
    'Current snapshot: ' + snapshot,
    'Repair packet: ' + JSON.stringify(packet),
    'Fix only the reported defect while preserving valid-user normalization.',
    'Run node --test tests/user.test.mjs after the edit.',
    'Finish after the bounded repair and local verification.',
  ].join('\n');

  const args = [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    'workspace-write',
    '--cd',
    workspace,
  ];
  if (route.model) {
    args.push('-m', route.model);
    if (route.reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(route.reasoningEffort));
  }
  args.push(prompt);

  const startedAt = Date.now();
  const run = await runCodexExec(codexBin, args, { cwd: workspace, timeoutMs });
  const endedAt = Date.now();
  const eventsPath = path.join(evidenceRoot, 'implementer-repair-' + attempt + '.events.jsonl');
  const stderrPath = path.join(evidenceRoot, 'implementer-repair-' + attempt + '.stderr.log');
  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  return {
    role: 'implementer',
    startedAt,
    endedAt,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    delegationObserved: hasDelegationToolEvent(run.stdout),
    testCommandPassed: passingFocusedTestCommand(run.stdout),
    requestedModel: route.model,
    reasoningEffort: route.reasoningEffort,
    inheritSessionModel: route.inheritSessionModel,
    eventsPath,
    stderrPath,
  };
}

async function runJsonRole({
  id,
  role,
  codexBin,
  workspace,
  evidenceRoot,
  sandbox,
  model,
  effort,
  prompt,
  timeoutMs,
  expectFocusedTest = false,
}) {
  const startedAt = Date.now();
  const run = await runCodexExec(codexBin, [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    sandbox,
    '--cd',
    workspace,
    '-m',
    model,
    '-c',
    'model_reasoning_effort=' + JSON.stringify(effort),
    prompt,
  ], { cwd: workspace, timeoutMs });
  const endedAt = Date.now();

  const eventsPath = path.join(evidenceRoot, id + '.events.jsonl');
  const stderrPath = path.join(evidenceRoot, id + '.stderr.log');
  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  if (run.code !== 0 || run.timedOut) {
    throw new Error(id + ' Codex process failed');
  }

  const output = parseJsonMessage(lastAgentMessage(run.stdout));
  return {
    id,
    role,
    startedAt,
    endedAt,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    requestedModel: model,
    reasoningEffort: effort,
    delegationObserved: hasDelegationToolEvent(run.stdout),
    testCommandObserved: expectFocusedTest ? focusedTestCommandObserved(run.stdout) : false,
    output,
    eventsPath,
    stderrPath,
    stdout: run.stdout,
  };
}

async function seedWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'hybrid-repair-runtime-smoke',
    private: true,
    type: 'module',
  }, null, 2) + '\n');
  await fs.writeFile(
    path.join(workspace, 'src', 'user.js'),
    [
      'export function normalizeUser(user) {',
      '  return { ...user, name: user.name.trim().toLowerCase() };',
      '}',
      '',
    ].join('\n')
  );
  await fs.writeFile(
    path.join(workspace, 'tests', 'user.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { normalizeUser } from '../src/user.js';",
      "",
      "test('valid user is normalized', () => {",
      "  assert.deepEqual(normalizeUser({ name: ' Alice ' }), { name: 'alice' });",
      "});",
      "",
      "test('null user returns null', () => {",
      "  assert.equal(normalizeUser(null), null);",
      "});",
      '',
    ].join('\n')
  );
}

async function runFocusedTest(workspace) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--test', 'tests/user.test.mjs'],
      { cwd: workspace, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || error.message || ''),
    };
  }
}

async function inspectFinalBehavior(workspace) {
  const script = [
    "import { normalizeUser } from './src/user.js';",
    "const n = normalizeUser(null);",
    "const v = normalizeUser({name:' Alice '});",
    "console.log(JSON.stringify({nullResult:n,validName:v.name}));",
  ].join('');
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: workspace,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

async function commitAll(workspace, message) {
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', message], { cwd: workspace });
}

async function gitHead(workspace) {
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
}

function summarizeRoute(route) {
  return {
    routeLevel: route.routeLevel,
    modelTier: route.modelTier,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    inheritSessionModel: route.inheritSessionModel,
  };
}

function intervalsOverlap(runs) {
  if (!Array.isArray(runs) || runs.length < 2) return false;
  return Math.max(...runs.map((run) => run.startedAt)) <
    Math.min(...runs.map((run) => run.endedAt));
}

function focusedTestCommandObserved(stdout) {
  return commandEvents(stdout).some((item) =>
    String(item.command || item.cmd || '').includes('tests/user.test.mjs') ||
    String(item.aggregated_output || '').includes('user.test.mjs')
  );
}

function passingFocusedTestCommand(stdout) {
  return commandEvents(stdout).some((item) =>
    Number(item.exit_code) === 0 &&
    (
      String(item.command || item.cmd || '').includes('tests/user.test.mjs') ||
      String(item.aggregated_output || '').includes('user.test.mjs')
    )
  );
}

function commandEvents(stdout) {
  const events = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'item.completed' && event?.item?.type === 'command_execution') {
        events.push(event.item);
      }
    } catch {
      // Ignore diagnostics.
    }
  }
  return events;
}

function lastAgentMessage(stdout) {
  let last = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event?.type === 'item.completed' &&
        event?.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) last = event.item.text;
    } catch {
      // Ignore diagnostics.
    }
  }
  if (!last) throw new Error('Codex role returned no final agent_message');
  return last;
}

function parseJsonMessage(message) {
  const source = String(message || '').trim();
  const fenced = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(source);
  const candidate = fenced ? fenced[1] : source;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new Error('agent_message did not contain parseable JSON');
  }
}

function hasDelegationToolEvent(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (objectContainsDelegationTool(JSON.parse(line))) return true;
    } catch {
      // Ignore diagnostics.
    }
  }
  return false;
}

function objectContainsDelegationTool(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(objectContainsDelegationTool);
  for (const [key, child] of Object.entries(value)) {
    if (
      ['name', 'tool', 'tool_name', 'toolName'].includes(key) &&
      typeof child === 'string' &&
      /(?:^|\.)spawn_agent$/i.test(child)
    ) return true;
    if (objectContainsDelegationTool(child)) return true;
  }
  return false;
}

async function doctorStatus(codexBin) {
  try {
    const { stdout } = await execFileAsync(codexBin, ['doctor', '--json'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    const auth = report.checks?.['auth.credentials'];
    return {
      authStatus: auth?.status || 'unknown',
      summary: auth?.summary || '',
    };
  } catch (error) {
    return {
      authStatus: error.code === 'ENOENT' ? 'missing-cli' : 'unknown',
      summary: String(error.stderr || error.message || error),
    };
  }
}

function lines(value) {
  const text = String(value || '').trim();
  return text ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify(preflightRepairSmoke(), null, 2));
  } else {
    const result = await runAuthenticatedRepairSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'completed') process.exitCode = 1;
  }
}
