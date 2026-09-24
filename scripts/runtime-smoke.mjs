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
      'Record planned/observed waves, worker roles, routed model tiers/models, and any model fallback in .planning/runtime-smoke-report.json.',
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
      'The security reviewer must use the Sol routing tier; routine tester/verifier work should remain/downshift to Luna unless another escalation condition is present.',
      'Do not let workers delegate.',
      'Record planned/observed roles, security activation, routed model tiers/models, and any model fallback in .planning/runtime-smoke-report.json.',
    ].join('\n'),
  },
});

export function preflightSmokeCase(name) {
  const key = String(name || '').toUpperCase();
  const spec = SMOKE_CASES[key];
  if (!spec) throw new Error('unknown smoke case: ' + name);
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
    assert.equal(route(result, 'security-reviewer').model, 'gpt-6-sol');
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

export async function runLiveSmokeCase(name, options = {}) {
  const key = String(name || '').toUpperCase();
  const spec = SMOKE_CASES[key];
  if (!spec) throw new Error('unknown smoke case: ' + name);
  preflightSmokeCase(key);

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
  ], { cwd: workspace });

  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  return {
    status: run.code === 0 ? 'completed' : 'failed',
    case: key,
    workspace,
    eventsPath,
    stderrPath,
    elapsedMs: Date.now() - startedAt,
    exitCode: run.code,
    ...(run.code === 0 ? {} : { error: run.error || 'codex exec failed' }),
  };
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

async function runCodexExec(codexBin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(codexBin, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr, error: String(error.message || error) });
    });
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? -1,
        signal,
        stdout,
        stderr,
        error: code === 0 ? null : ('codex exited with code ' + code + (signal ? ' signal ' + signal : '')),
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
    const requested = args.includes('--preflight') ? ['A', 'B', 'C'] : [String(args[0] || 'A').toUpperCase()];
    console.log(JSON.stringify(requested.map(preflightSmokeCase), null, 2));
  }
}
