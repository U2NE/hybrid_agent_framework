#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareExecution } from '../core/orchestrator/index.mjs';
import {
  cleanupWorktreeWave,
  collectWorktreeResults,
  createWorktreeWave,
  integrateWorktreeResults,
  listGitWorktrees,
} from '../core/worktree/index.mjs';
import { installProject } from './install-project.mjs';
import { runCodexExec } from './runtime-smoke.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

const TASKS = Object.freeze([
  {
    id: 'alpha',
    attemptId: 'attempt-alpha',
    leaseId: 'lease-alpha',
    files_modified: ['src/alpha.js'],
    expected: 'export const alpha = 1;\n',
  },
  {
    id: 'beta',
    attemptId: 'attempt-beta',
    leaseId: 'lease-beta',
    files_modified: ['src/beta.js'],
    expected: 'export const beta = 2;\n',
  },
]);

export function preflightWorktreeSmoke() {
  const result = prepareExecution({
    task: {
      request: 'Update two independent files with forced worktree isolation',
      files: ['src/alpha.js', 'src/beta.js'],
      bounded: true,
    },
    request: 'Update two independent files with forced worktree isolation',
    forceWorktree: true,
    worktreeAvailable: true,
    tasks: TASKS.map(({ id, files_modified }) => ({
      id,
      depends_on: [],
      files_modified,
    })),
  });

  const waves = result.waves.map((wave) => wave.map((task) => task.id));
  assert.deepEqual(waves, [['alpha', 'beta']]);
  assert.equal(result.isolationPlan.isolation.length, 1);
  assert.equal(result.isolationPlan.isolation[0].mode, 'worktree');
  assert.match(result.isolationPlan.isolation[0].reason, /explicit/);

  return {
    case: 'E',
    title: 'authenticated worktree isolation and integration',
    waves,
    isolation: result.isolationPlan.isolation,
  };
}

export async function runAuthenticatedWorktreeSmoke(options = {}) {
  const preflight = preflightWorktreeSmoke();
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await doctorStatus(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: 'E',
      reason: doctor.summary || 'Codex credentials are not ready',
      preflight,
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-worktree-smoke-main-'));
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-worktree-smoke-evidence-'));
  await execFileAsync('git', ['init', '-q', workspace]);
  await execFileAsync('git', ['config', 'user.name', 'Hybrid Runtime Smoke'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'hybrid-smoke@example.invalid'], { cwd: workspace });
  await seedWorkspace(workspace);
  await installProject(workspace, { skipCodexValidation: true });
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', 'worktree smoke baseline'], { cwd: workspace });

  const baselineHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim();
  const initialWorktrees = await listGitWorktrees(workspace);
  let handle = null;
  let collected = null;
  let integrated = null;
  let workers = [];
  let verifier = null;
  let cleanup = null;
  let caught = null;
  let duringWorktrees = [];

  try {
    handle = await createWorktreeWave({
      repoRoot: workspace,
      tasks: TASKS,
    });
    duringWorktrees = await listGitWorktrees(workspace);

    workers = await Promise.all(
      handle.worktrees.map((worktree) =>
        runWorker({
          codexBin,
          evidenceRoot,
          worktree,
          timeoutMs: options.workerTimeoutMs || 180000,
        })
      )
    );

    const failedWorker = workers.find((worker) => worker.exitCode !== 0 || worker.timedOut);
    if (failedWorker) {
      throw new Error('worktree worker failed: ' + failedWorker.taskId);
    }

    collected = await collectWorktreeResults(handle);
    integrated = await integrateWorktreeResults(collected);

    const direct = await verifyIntegratedFiles(workspace);
    if (!direct.ok) throw new Error('deterministic integrated-file verification failed');

    verifier = await runVerifier({
      codexBin,
      workspace,
      evidenceRoot,
      timeoutMs: options.verifierTimeoutMs || 120000,
    });
    if (verifier.exitCode !== 0 || verifier.timedOut) {
      throw new Error('authenticated verifier failed');
    }
  } catch (error) {
    caught = error;
  } finally {
    if (handle) {
      cleanup = await cleanupWorktreeWave(integrated || collected || handle, { suppressErrors: true });
    }
  }

  const finalWorktrees = await listGitWorktrees(workspace).catch(() => []);
  const finalStatus = lines(
    (await execFileAsync('git', ['status', '--short'], { cwd: workspace })).stdout
  );
  const finalFiles = {
    alpha: await readMaybe(path.join(workspace, 'src', 'alpha.js')),
    beta: await readMaybe(path.join(workspace, 'src', 'beta.js')),
  };
  const worktreeRootExists = handle?.root ? await exists(handle.root) : null;

  const report = {
    schema: 'hybrid-worktree-runtime-smoke/v1',
    case: 'E',
    preflight,
    workspace,
    evidenceRoot,
    baselineHead,
    initialWorktrees,
    duringWorktrees,
    workers: workers.map((worker) => ({
      taskId: worker.taskId,
      worktreePath: worker.worktreePath,
      startedAt: worker.startedAt,
      endedAt: worker.endedAt,
      exitCode: worker.exitCode,
      timedOut: worker.timedOut,
      requestedModel: 'gpt-6-luna',
      reasoningEffort: 'medium',
      delegationObserved: worker.delegationObserved,
      eventsPath: worker.eventsPath,
    })),
    parallelOverlap: intervalsOverlap(workers),
    handoff: collected?.results || [],
    integration: integrated?.integrated || [],
    finalFiles,
    verifier,
    cleanup: {
      removed: cleanup?.removed || [],
      errors: cleanup?.errors || [],
      finalWorktrees,
      worktreeRootExists,
    },
    finalGitStatus: finalStatus,
    runtimeError: caught ? {
      message: String(caught.message || caught),
      code: caught.code || null,
    } : null,
  };

  const semantic = validateWorktreeSmokeReport(report);
  const reportPath = path.join(evidenceRoot, 'worktree-runtime-smoke-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  return {
    status: semantic.ok && !caught ? 'completed' : 'failed',
    case: 'E',
    workspace,
    evidenceRoot,
    reportPath,
    semantic,
    report,
    ...(caught ? { error: String(caught.message || caught) } : {}),
  };
}

export function validateWorktreeSmokeReport(report) {
  const errors = [];
  const isolation = report?.preflight?.isolation?.[0];

  if (isolation?.mode !== 'worktree') errors.push('scheduler did not select worktree mode');
  if (!Array.isArray(report.duringWorktrees) || report.duringWorktrees.length !== 3) {
    errors.push('two additional git worktrees were not observed');
  }

  const workers = Array.isArray(report.workers) ? report.workers : [];
  if (workers.length !== 2) errors.push('expected two worktree workers');
  const paths = workers.map((worker) => worker.worktreePath);
  if (new Set(paths).size !== 2) errors.push('workers did not execute in distinct worktree paths');

  for (const worker of workers) {
    if (worker.exitCode !== 0 || worker.timedOut) errors.push(worker.taskId + ' worker did not complete');
    if (worker.delegationObserved === true) errors.push(worker.taskId + ' recursively delegated');
    if (!report.duringWorktrees?.some((entry) => entry.path === worker.worktreePath)) {
      errors.push(worker.taskId + ' path was not an observed git worktree');
    }
  }

  if (report.parallelOverlap !== true) errors.push('worktree workers did not overlap');

  const handoff = Array.isArray(report.handoff) ? report.handoff : [];
  for (const task of TASKS) {
    const result = handoff.find((item) => item.taskId === task.id);
    if (!result) {
      errors.push('missing patch handoff for ' + task.id);
      continue;
    }
    if (!Array.isArray(result.changedFiles) || result.changedFiles.length !== 1 || result.changedFiles[0] !== task.files_modified[0]) {
      errors.push('patch handoff ownership mismatch for ' + task.id);
    }
    if (!(result.patchBytes > 0)) errors.push('empty patch handoff for ' + task.id);
  }

  if ((report.integration || []).length !== 2) errors.push('both worktree results were not integrated');
  if (report.finalFiles?.alpha !== TASKS[0].expected) errors.push('integrated alpha output is incorrect');
  if (report.finalFiles?.beta !== TASKS[1].expected) errors.push('integrated beta output is incorrect');

  if (report.verifier?.exitCode !== 0 || report.verifier?.timedOut) {
    errors.push('authenticated final verifier did not complete');
  }
  if (report.verifier?.commandEvidence !== true) {
    errors.push('fresh verifier command evidence missing');
  }
  if (report.verifier?.delegationObserved === true) {
    errors.push('verifier recursively delegated');
  }

  if (report.cleanup?.errors?.length) errors.push('worktree cleanup reported errors');
  if (report.cleanup?.worktreeRootExists !== false) errors.push('temporary worktree root remains');
  if (
    !Array.isArray(report.cleanup?.finalWorktrees) ||
    report.cleanup.finalWorktrees.length !== 1 ||
    report.cleanup.finalWorktrees[0].path !== report.workspace
  ) {
    errors.push('orphan worktree remains after cleanup');
  }

  const expectedStatus = new Set([' M src/alpha.js', ' M src/beta.js']);
  const actualStatus = new Set(report.finalGitStatus || []);
  if (
    actualStatus.size !== expectedStatus.size ||
    [...expectedStatus].some((item) => !actualStatus.has(item))
  ) {
    errors.push('main workspace final git status is not the expected integrated state');
  }

  if (report.runtimeError) errors.push('runtime error: ' + report.runtimeError.message);

  return { ok: errors.length === 0, errors };
}

async function runWorker({ codexBin, evidenceRoot, worktree, timeoutMs }) {
  const task = TASKS.find((item) => item.id === worktree.taskId);
  const eventsPath = path.join(evidenceRoot, worktree.taskId + '.events.jsonl');
  const stderrPath = path.join(evidenceRoot, worktree.taskId + '.stderr.log');
  const startedAt = Date.now();

  const prompt = [
    'You are an isolated implementation worker, not the lead.',
    'Do not spawn or delegate to any subagent.',
    'Work only in the current git worktree.',
    'Modify only ' + task.files_modified[0] + '.',
    'Make its entire content exactly: ' + JSON.stringify(task.expected),
    'Do not edit planning files, config files, docs, tests, or any other file.',
    'Verify the file content locally and finish.',
  ].join('\n');

  const run = await runCodexExec(codexBin, [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    'workspace-write',
    '--cd',
    worktree.path,
    '-m',
    'gpt-6-luna',
    '-c',
    'model_reasoning_effort="medium"',
    prompt,
  ], {
    cwd: worktree.path,
    timeoutMs,
  });

  const endedAt = Date.now();
  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  return {
    taskId: task.id,
    worktreePath: worktree.path,
    startedAt,
    endedAt,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    delegationObserved: hasDelegationToolEvent(run.stdout),
    eventsPath,
    stderrPath,
  };
}

async function runVerifier({ codexBin, workspace, evidenceRoot, timeoutMs }) {
  const eventsPath = path.join(evidenceRoot, 'verifier.events.jsonl');
  const stderrPath = path.join(evidenceRoot, 'verifier.stderr.log');
  const verifyCommand = [
    'node --input-type=module -e',
    JSON.stringify(
      "const a=await import('./src/alpha.js?verify='+Date.now());" +
      "const b=await import('./src/beta.js?verify='+Date.now());" +
      "if(a.alpha!==1||b.beta!==2) process.exit(1);" +
      "console.log('WORKTREE_VERIFY_PASS')"
    ),
  ].join(' ');

  const prompt = [
    'Act as the independent final verifier.',
    'Do not modify any file and do not spawn or delegate.',
    'Run exactly this verification command:',
    verifyCommand,
    'Also inspect git status to confirm only src/alpha.js and src/beta.js are modified.',
    'Report the factual verification result and finish.',
  ].join('\n');

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
  ], {
    cwd: workspace,
    timeoutMs,
  });

  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  return {
    role: 'verifier',
    requestedModel: 'gpt-6-luna',
    reasoningEffort: 'medium',
    exitCode: run.code,
    timedOut: run.timedOut === true,
    delegationObserved: hasDelegationToolEvent(run.stdout),
    commandEvidence: hasPassingVerifierCommand(run.stdout),
    eventsPath,
    stderrPath,
  };
}

async function verifyIntegratedFiles(workspace) {
  const alpha = await readMaybe(path.join(workspace, 'src', 'alpha.js'));
  const beta = await readMaybe(path.join(workspace, 'src', 'beta.js'));
  return {
    ok: alpha === TASKS[0].expected && beta === TASKS[1].expected,
    alpha,
    beta,
  };
}

function hasPassingVerifierCommand(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const item = event?.item;
      if (
        event?.type === 'item.completed' &&
        item?.type === 'command_execution' &&
        Number(item?.exit_code) === 0 &&
        String(item?.aggregated_output || '').includes('WORKTREE_VERIFY_PASS')
      ) return true;
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return false;
}

function hasDelegationToolEvent(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (objectContainsDelegationTool(event)) return true;
    } catch {
      // Ignore non-JSON diagnostic lines.
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

function intervalsOverlap(workers) {
  if (!Array.isArray(workers) || workers.length < 2) return false;
  const latestStart = Math.max(...workers.map((worker) => worker.startedAt || 0));
  const earliestEnd = Math.min(...workers.map((worker) => worker.endedAt || 0));
  return latestStart < earliestEnd;
}

async function seedWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({
    name: 'hybrid-worktree-smoke',
    private: true,
    type: 'module',
  }, null, 2) + '\n');
  await fs.writeFile(path.join(workspace, 'src', 'alpha.js'), 'export const alpha = 0;\n');
  await fs.writeFile(path.join(workspace, 'src', 'beta.js'), 'export const beta = 0;\n');
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

async function readMaybe(target) {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function lines(value) {
  const text = String(value || '').trimEnd();
  return text ? text.split(/\r?\n/) : [];
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify(preflightWorktreeSmoke(), null, 2));
  } else {
    const result = await runAuthenticatedWorktreeSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'completed') process.exitCode = 1;
  }
}
