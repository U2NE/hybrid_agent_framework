#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRoleRouting } from '../core/routing/index.mjs';
import { runCodexExec, validateCodexExecInvocation } from './runtime-smoke.mjs';

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

export function buildCodexProbeArgs({ model, reasoningEffort, cwd }) {
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
  if (reasoningEffort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(reasoningEffort));
  args.push('Reply with exactly the single word OK.');
  return args;
}

export async function runWithFailClosedModel({
  codexBin = process.env.CODEX_BIN || 'codex',
  workspace,
  model,
  reasoningEffort,
  runner = runCodexExec,
}) {
  const args = buildCodexProbeArgs({ model, reasoningEffort, cwd: workspace });
  try {
    validateCodexExecInvocation(args);
  } catch (error) {
    return {
      ok: false,
      localRejected: true,
      runnerCalled: false,
      fallbackUsed: false,
      rejectionCode: error.code || 'MODEL_POLICY_VIOLATION',
      error: String(error.message || error),
      attemptedModel: model ?? null,
      attemptedReasoningEffort: reasoningEffort ?? null,
      result: null,
    };
  }

  const result = await runner(codexBin, args, { cwd: workspace });
  return {
    ok: result.code === 0,
    localRejected: false,
    runnerCalled: true,
    fallbackUsed: false,
    rejectionCode: result.code === 0 ? null : 'MODEL_OVERRIDE_REJECTED',
    attemptedModel: model,
    attemptedReasoningEffort: reasoningEffort,
    result,
  };
}

export async function runAuthenticatedRoutingSmoke(options = {}) {
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const workspace = options.workspace || await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-routing-smoke-'));
  await ensureGitRepo(workspace);

  const preflight = routingEffortPreflight();
  const runner = options.runner || runCodexExec;
  const effortResults = [];

  for (const effort of ['high', 'xhigh', 'max']) {
    const result = await runWithFailClosedModel({
      codexBin,
      workspace,
      model: 'gpt-6-luna',
      reasoningEffort: effort,
      runner,
    });
    effortResults.push({
      effort,
      overrideRequestAccepted: result.ok,
      fallbackUsed: result.fallbackUsed,
      exitCode: result.result?.code ?? null,
      error: result.result?.code === 0 ? null : compactError(result.result) || result.error || null,
    });
  }

  const invalid = await runWithFailClosedModel({
    codexBin,
    workspace,
    model: options.invalidModel || 'gpt-6-hybrid-intentionally-invalid',
    reasoningEffort: 'medium',
    runner,
  });

  return {
    workspace,
    preflight,
    effortResults,
    invalidModel: {
      localRejected: invalid.localRejected,
      runnerCalled: invalid.runnerCalled,
      fallbackUsed: invalid.fallbackUsed,
      rejectionCode: invalid.rejectionCode,
      attemptedModel: invalid.attemptedModel,
    },
    claims: {
      modelIdentityAttested: false,
      interpretation: 'Successful probes prove the explicit allowlisted model/reasoning request was accepted by Codex; they do not independently attest the backend serving-model identity.',
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
      !result.invalidModel.localRejected ||
      result.invalidModel.runnerCalled ||
      result.invalidModel.fallbackUsed
    ) {
      process.exitCode = 1;
    }
  }
}
