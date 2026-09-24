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
import { evaluateCompletionGate } from '../core/verification/index.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const CRITERION = 'CLI invocation --name Alice prints exactly "hello Alice" and exits successfully';

export function preflightProofGapSmoke() {
  const first = evaluateCompletionGate({
    tier: 1,
    report: baseReport(),
    requiredProofByCriterion: { 'AC-001': 'cli' },
    evidence: [],
  });
  assert.equal(first.pass, false);
  assert.equal(first.reason, 'PROOF_GAP');
  assert.deepEqual(first.proofGaps.map((gap) => gap.requiredKind), ['cli']);
  return {
    case: 'H',
    title: 'authenticated proof-gap acquisition and verifier reassessment',
    initialVerdict: first.verdict,
    initialReason: first.reason,
    requiredKind: 'cli',
    qeAgentRequired: false,
    browserRequired: false,
  };
}

export async function runAuthenticatedProofGapSmoke(options = {}) {
  const preflight = preflightProofGapSmoke();
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await doctorStatus(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: 'H',
      reason: doctor.summary || 'Codex credentials are not ready',
      preflight,
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-proof-smoke-main-'));
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-proof-smoke-evidence-'));
  await execFileAsync('git', ['init', '-q'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'Hybrid Runtime Smoke'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'hybrid-smoke@example.invalid'], { cwd: workspace });
  await seedWorkspace(workspace);
  await installProject(workspace, { skipCodexValidation: true });
  await commitAll(workspace, 'proof gap smoke baseline');

  const initialHead = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })
  ).stdout.trim();

  const verifierRuns = [];
  let runtimeError = null;
  let closure = null;

  try {
    closure = await runQualityClosure({
      repoRoot: workspace,
      runtimeRoot: evidenceRoot,
      runId: 'case-h',
      taskId: 'cli-proof',
      snapshot: initialHead,
      tier: 1,
      task: {
        id: 'cli',
        goal: 'Expose the requested CLI behavior.',
        files_modified: ['bin/hybrid-smoke-cli.mjs'],
        acceptance_criteria: [CRITERION],
        owner: 'implementer',
      },
      requiredProofByCriterion: { 'AC-001': 'cli' },
      proofRequests: {
        'AC-001': {
          command: [process.execPath, 'bin/hybrid-smoke-cli.mjs', '--name', 'Alice'],
        },
      },
      proofOptions: {
        cwd: workspace,
        timeoutMs: 10000,
      },
      qa: async () => ({ ok: true, findings: [] }),
      verifier: async ({ phase, evidence, snapshot }) => {
        const expected = phase === 'proof-reassessment' ? 'PASS' : 'PROOF_GAP';
        const run = await runEvidenceVerifier({
          phase: phase === 'proof-reassessment' ? 'after-proof' : 'before-proof',
          codexBin,
          workspace,
          evidenceRoot,
          evidence,
          expected,
          timeoutMs: options.verifierTimeoutMs || 180000,
        });
        verifierRuns.push(run);

        const verdict = run.output.verdict;
        const verified = verdict === 'PASS' && run.output.reason === 'VERIFIED';
        return {
          ok: verified,
          verdict,
          reason: run.output.reason,
          findings: [],
          report: {
            ...baseReport(),
            snapshot,
          },
          assessments: phase === 'proof-reassessment'
            ? [{
                criterionId: 'AC-001',
                kind: 'cli',
                evidenceIds: Array.isArray(run.output.consumedEvidenceIds)
                  ? run.output.consumedEvidenceIds
                  : [],
                verified,
                verifier: 'verifier',
                snapshot,
              }]
            : [],
        };
      },
    });
  } catch (error) {
    runtimeError = String(error?.message || error);
  }

  const firstGate = closure?.gates?.find((item) => item.phase === 'pre-proof')?.gate || null;
  const secondGate = closure?.gates?.find((item) => item.phase === 'post-proof')?.gate || null;
  const firstVerifier = verifierRuns[0] || null;
  const secondVerifier = verifierRuns[1] || null;
  const acquisition = closure?.acquisitions?.[0] || null;
  const assessedEvidence = acquisition?.evidence?.evidenceId
    ? closure?.evidence?.find((item) => item.evidenceId === acquisition.evidence.evidenceId) || null
    : null;

  const directCli = await runCli(workspace);
  const finalStatus = lines(
    (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout
  );

  const report = {
    schema: 'hybrid-proof-gap-runtime-smoke/v1',
    case: 'H',
    preflight,
    workspace,
    evidenceRoot,
    productionPrimitive: 'runQualityClosure',
    firstGate: firstGate ? summarizeGate(firstGate) : null,
    firstVerifier,
    acquisition,
    secondGate: secondGate ? summarizeGate(secondGate) : null,
    secondVerifier,
    assessedEvidence,
    qualityClosure: closure
      ? {
          pass: closure.pass,
          verdict: closure.verdict,
          reason: closure.reason,
          completion: closure.completion,
          gates: closure.gates,
          events: closure.events,
        }
      : null,
    directCli,
    qeAgentsSpawned: 0,
    browserUsed: false,
    finalGitStatus: finalStatus,
    runtimeError,
  };
  const semantic = validateProofGapSmokeReport(report);
  const reportPath = path.join(evidenceRoot, 'proof-gap-runtime-smoke-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  return {
    status: semantic.ok && !runtimeError ? 'completed' : 'failed',
    case: 'H',
    workspace,
    evidenceRoot,
    reportPath,
    semantic,
    report,
  };
}

export function validateProofGapSmokeReport(report = {}) {
  const errors = [];

  if (report.productionPrimitive !== 'runQualityClosure') {
    errors.push('Case H did not consume the generic runQualityClosure production primitive');
  }
  if (report.qualityClosure?.pass !== true || report.qualityClosure?.completion?.pass !== true) {
    errors.push('generic quality closure did not reach completion PASS');
  }

  if (report.firstGate?.pass !== false || report.firstGate?.reason !== 'PROOF_GAP') {
    errors.push('first completion gate falsely accepted missing runtime proof');
  }
  if (!report.firstGate?.proofGaps?.some((gap) => gap.requiredKind === 'cli')) {
    errors.push('first gate did not identify CLI proof gap');
  }

  if (!report.firstVerifier) {
    errors.push('first authenticated verifier is missing');
  } else {
    if (report.firstVerifier.output?.verdict !== 'FAIL') {
      errors.push('first verifier did not fail on missing proof');
    }
    if (report.firstVerifier.output?.reason !== 'PROOF_GAP') {
      errors.push('first verifier did not distinguish proof gap from defect');
    }
    if (report.firstVerifier.commandExecutionCount !== 0) {
      errors.push('first verifier acquired proof instead of assessing the supplied evidence');
    }
    if (report.firstVerifier.delegationObserved === true) {
      errors.push('first verifier recursively delegated');
    }
  }

  const evidence = report.acquisition?.evidence;
  if (report.acquisition?.acquired !== true || report.acquisition?.available !== true) {
    errors.push('actual proof acquisition did not occur');
  }
  if (
    evidence?.kind !== 'cli' ||
    evidence?.fresh !== true ||
    evidence?.success !== true ||
    evidence?.acquired !== true ||
    evidence?.assessed !== false ||
    evidence?.verified !== false ||
    !evidence?.evidenceId ||
    Number(evidence?.exitCode) !== 0 ||
    evidence?.stdout !== 'hello Alice'
  ) {
    errors.push('acquired CLI process evidence is incomplete, semantically wrong, or prematurely verified');
  }

  if (report.secondGate?.pass !== true || report.secondGate?.reason != null) {
    errors.push('second completion gate did not consume proof into PASS');
  }

  if (!report.secondVerifier) {
    errors.push('second authenticated verifier is missing');
  } else {
    if (report.secondVerifier.output?.verdict !== 'PASS') {
      errors.push('second verifier did not PASS after proof acquisition');
    }
    const consumed = Array.isArray(report.secondVerifier.output?.consumedEvidenceIds)
      ? report.secondVerifier.output.consumedEvidenceIds
      : [];
    if (!evidence?.evidenceId || !consumed.includes(evidence.evidenceId)) {
      errors.push('second verifier did not consume the exact acquired evidence id');
    }
    if (report.secondVerifier.delegationObserved === true) {
      errors.push('second verifier recursively delegated');
    }
    if (Number(report.secondVerifier.startedAt) <= Number(report.firstVerifier?.endedAt || 0)) {
      errors.push('second verifier did not run after the first verifier');
    }
  }

  if (
    report.assessedEvidence?.evidenceId !== evidence?.evidenceId ||
    report.assessedEvidence?.assessed !== true ||
    report.assessedEvidence?.verified !== true ||
    report.assessedEvidence?.verifier !== 'verifier'
  ) {
    errors.push('acquired proof was not semantically assessed and verified before completion');
  }

  const events = Array.isArray(report.qualityClosure?.events) ? report.qualityClosure.events : [];
  const firstVerifierEnd = events.findIndex((event) =>
    event.stage === 'verifier' && event.lifecycle === 'end' && event.phase === 'verification'
  );
  const proofEnd = events.findIndex((event) =>
    event.stage === 'proof-acquisition' && event.lifecycle === 'end'
  );
  const secondVerifierStart = events.findIndex((event) =>
    event.stage === 'verifier' && event.lifecycle === 'start' && event.phase === 'proof-reassessment'
  );
  const completionPass = events.findIndex((event) =>
    event.stage === 'completion' && event.outcome === 'pass'
  );
  if (
    firstVerifierEnd < 0 ||
    proofEnd <= firstVerifierEnd ||
    secondVerifierStart <= proofEnd ||
    completionPass <= secondVerifierStart
  ) {
    errors.push('proof lifecycle ordering is not verifier-gap -> acquisition -> reassessment -> completion');
  }

  if (report.qeAgentsSpawned !== 0) errors.push('QE spawned an agent');
  if (report.browserUsed !== false) errors.push('browser was used for CLI proof');
  if (report.directCli?.exitCode !== 0 || report.directCli?.stdout !== 'hello Alice') {
    errors.push('direct CLI behavior is not objectively correct');
  }
  if ((report.finalGitStatus || []).length !== 0) errors.push('proof smoke repository is not clean');
  if (report.runtimeError) errors.push('runtime error: ' + report.runtimeError);

  return { ok: errors.length === 0, errors };
}

async function runEvidenceVerifier({
  phase,
  codexBin,
  workspace,
  evidenceRoot,
  evidence,
  expected,
  timeoutMs,
}) {
  const prompt = [
    'Act as the independent Hybrid verifier. Do not modify files and do not spawn or delegate.',
    'Do not execute commands or acquire new proof in this verification pass.',
    'Acceptance criterion: ' + CRITERION,
    'Implementation is present. Evaluate ONLY the supplied evidence below.',
    'Required proof kind: cli',
    'Supplied runtime evidence: ' + JSON.stringify(evidence),
    expected === 'PROOF_GAP'
      ? 'Because no CLI runtime evidence is supplied, return FAIL with reason PROOF_GAP. Do not claim the criterion VERIFIED.'
      : 'The supplied fresh CLI evidence is the proof to evaluate. Return PASS only if it shows exit 0 and stdout exactly "hello Alice".',
    'When evidence is supplied, consumedEvidenceIds must contain the exact evidenceId values you semantically assessed. Do not invent IDs and do not claim VERIFIED without consuming the relevant acquired evidence.',
    'Return exactly one JSON object and no markdown.',
    'Shape: {"role":"verifier","verdict":"PASS|FAIL","reason":"PROOF_GAP|VERIFIED|FAILURE","criterionId":"AC-001","consumedEvidenceIds":[],"consumedEvidenceKinds":["cli"],"evidenceAssessment":"short factual assessment"}',
  ].join('\n');

  const startedAt = Date.now();
  const run = await runCodexExec(codexBin, [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    workspace,
    '-m',
    'gpt-6-luna',
    '-c',
    'model_reasoning_effort="medium"',
    prompt,
  ], { cwd: workspace, timeoutMs });
  const endedAt = Date.now();

  const eventsPath = path.join(evidenceRoot, 'verifier-' + phase + '.events.jsonl');
  const stderrPath = path.join(evidenceRoot, 'verifier-' + phase + '.stderr.log');
  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  if (run.code !== 0 || run.timedOut) throw new Error('proof-gap verifier process failed: ' + phase);

  return {
    phase,
    startedAt,
    endedAt,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    requestedModel: 'gpt-6-luna',
    reasoningEffort: 'medium',
    delegationObserved: hasDelegationToolEvent(run.stdout),
    commandExecutionCount: commandEvents(run.stdout).length,
    output: parseJsonMessage(lastAgentMessage(run.stdout)),
    eventsPath,
    stderrPath,
  };
}

function baseReport() {
  return {
    criteria: [CRITERION],
    planTasks: [{ id: 'cli', acceptance_criteria: [CRITERION] }],
    implementationEvidence: {
      'AC-001': { evidence: 'bin/hybrid-smoke-cli.mjs implements --name' },
    },
    verificationEvidence: {
      'AC-001': { status: 'VERIFIED', evidence: 'static implementation shape inspected' },
    },
    freshTestOutput: true,
    buildApplicable: false,
    typecheckApplicable: false,
    lintApplicable: false,
    specGoalAligned: true,
  };
}

async function seedWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, 'bin'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'hybrid-proof-gap-runtime-smoke',
    private: true,
    type: 'module',
  }, null, 2) + '\n');
  await fs.writeFile(
    path.join(workspace, 'bin', 'hybrid-smoke-cli.mjs'),
    [
      "const args = process.argv.slice(2);",
      "const index = args.indexOf('--name');",
      "const name = index >= 0 ? args[index + 1] : null;",
      "if (!name) {",
      "  console.error('missing --name');",
      "  process.exit(2);",
      "}",
      "process.stdout.write('hello ' + name);",
      '',
    ].join('\n')
  );
}

async function runCli(workspace) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['bin/hybrid-smoke-cli.mjs', '--name', 'Alice'],
      { cwd: workspace, encoding: 'utf8' }
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

function summarizeGate(gate) {
  return {
    pass: gate.pass,
    verdict: gate.verdict,
    reason: gate.reason,
    proofGaps: gate.proofGaps,
    evidencePolicy: gate.evidencePolicy,
  };
}

async function commitAll(workspace, message) {
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', message], { cwd: workspace });
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
  if (!last) throw new Error('Codex verifier returned no final agent_message');
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
    console.log(JSON.stringify(preflightProofGapSmoke(), null, 2));
  } else {
    const result = await runAuthenticatedProofGapSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'completed') process.exitCode = 1;
  }
}
