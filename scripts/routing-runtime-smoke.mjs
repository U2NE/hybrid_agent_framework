#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoleRouting } from '../core/routing/index.mjs';

const scriptPath = fileURLToPath(import.meta.url);

export function routingEffortPreflight() {
  const cases = [
    ['routine', resolveRoleRouting('implementer')],
    ['moderate', resolveRoleRouting('implementer', { context: { moderateImplementation: true } })],
    ['hard', resolveRoleRouting('implementer', { context: { hardImplementation: true } })],
    ['very-hard', resolveRoleRouting('implementer', { context: { veryHardImplementation: true } })],
    ['luna-exhausted', resolveRoleRouting('implementer', { context: { lunaExhausted: true } })],
  ];

  return cases.map(([name, route]) => ({
    name,
    routeLevel: route.routeLevel,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
  }));
}

export function buildCodexProbeArgs({ model = null, reasoningEffort = null, cwd }) {
  const args = [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
  ];
  if (model) args.push('-m', model);
  if (reasoningEffort) {
    args.push('-c', 'model_reasoning_effort=' + JSON.stringify(reasoningEffort));
  }
  args.push('Reply with exactly the single word OK.');
  return args;
}

export async function runWithSessionFallback({
  codexBin = process.env.CODEX_BIN || 'codex',
  workspace,
  model,
  reasoningEffort,
  runner = runProcess,
}) {
  const firstArgs = buildCodexProbeArgs({ model, reasoningEffort, cwd: workspace });
  const first = await runner(codexBin, firstArgs, { cwd: workspace });

  if (first.code === 0) {
    return {
      ok: true,
      fallbackUsed: false,
      first,
      second: null,
      attemptedModel: model,
      attemptedReasoningEffort: reasoningEffort,
    };
  }

  const secondArgs = buildCodexProbeArgs({ cwd: workspace });
  const second = await runner(codexBin, secondArgs, { cwd: workspace });

  return {
    ok: second.code === 0,
    fallbackUsed: true,
    firstRejected: true,
    first,
    second,
    attemptedModel: model,
    attemptedReasoningEffort: reasoningEffort,
    fallback: 'session-inheritance',
  };
}

export async function runAuthenticatedRoutingSmoke(options = {}) {
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const workspace = options.workspace || await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-routing-smoke-'));
  await ensureGitRepo(workspace);

  const preflight = routingEffortPreflight();
  const effortResults = [];

  for (const effort of ['high', 'xhigh', 'max']) {
    const result = await runWithSessionFallback({
      codexBin,
      workspace,
      model: 'gpt-6-luna',
      reasoningEffort: effort,
      runner: options.runner || runProcess,
    });
    effortResults.push({
      effort,
      overrideRequestAccepted: result.first.code === 0,
      fallbackUsed: result.fallbackUsed,
      exitCode: result.first.code,
      error: result.first.code === 0 ? null : compactError(result.first),
    });
  }

  const fallback = await runWithSessionFallback({
    codexBin,
    workspace,
    model: options.invalidModel || 'gpt-6-hybrid-intentionally-invalid',
    reasoningEffort: 'medium',
    runner: options.runner || runProcess,
  });

  return {
    workspace,
    preflight,
    effortResults,
    fallback: {
      firstRejected: fallback.first.code !== 0,
      fallbackUsed: fallback.fallbackUsed,
      fallbackSucceeded: fallback.ok && fallback.second?.code === 0,
      firstExitCode: fallback.first.code,
      secondExitCode: fallback.second?.code ?? null,
      policy: fallback.fallback || null,
      firstError: compactError(fallback.first),
    },
    claims: {
      modelIdentityAttested: false,
      interpretation: 'Successful probes prove the explicit model/reasoning override request was accepted by Codex; they do not independently attest the underlying serving model identity.',
    },
  };
}

async function ensureGitRepo(workspace) {
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fs.access(path.join(workspace, '.git'));
  } catch {
    const result = await runProcess('git', ['init', '-q', workspace], { cwd: workspace });
    if (result.code !== 0) throw new Error('unable to initialize routing smoke workspace: ' + compactError(result));
  }
}

function compactError(result) {
  const text = String(result?.stderr || result?.stdout || result?.error || '').trim();
  return text.slice(0, 800);
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
        error: code === 0 ? null : ('process exited with code ' + code),
      });
    });
  });
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify(routingEffortPreflight(), null, 2));
  } else {
    const result = await runAuthenticatedRoutingSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (
      result.effortResults.some((item) => !item.overrideRequestAccepted) ||
      !result.fallback.firstRejected ||
      !result.fallback.fallbackSucceeded
    ) {
      process.exitCode = 1;
    }
  }
}
