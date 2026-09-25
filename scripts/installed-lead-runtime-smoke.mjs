#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installProject } from './install-project.mjs';
import { runCodexDoctor, runCodexExec } from './runtime-smoke.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), '..');
const CASE_ID = 'case-i';
const ACTION_RELATIVE_PATH = '.planning/lead-quality-closure.mjs';
const EVENT_RELATIVE_PATH = '.planning/runtime-events/runs/case-i/events.jsonl';
const INITIAL_FIXTURE = 'export const value = 0;\n';
const FINAL_FIXTURE = 'export const value = 1;\n';
const SNAPSHOT = 'sha256:' + createHash('sha256').update(FINAL_FIXTURE).digest('hex');

export async function preflightInstalledLeadSmoke() {
  const workspace = await createDisposableProject('preflight');
  await seedFixture(workspace);
  await installProject(workspace, { skipCodexValidation: true });

  const installed = await inspectInstalledContract(workspace);
  assert.equal(installed.fixture.initialValid, true);
  assert.equal(installed.coreIntegrity, true);
  const synthetic = makeSyntheticEvidence(workspace, installed);
  const positive = validateInstalledLeadRuntimeEvidence(synthetic);
  assert.equal(positive.ok, true, positive.errors.join('; '));

  const noEvents = validateInstalledLeadRuntimeEvidence({
    ...synthetic,
    runtimeEvents: [],
  });
  assert.equal(noEvents.ok, false);
  assert.ok(noEvents.errors.some((error) => /runtime lifecycle events/.test(error)));

  const missingCompletion = validateInstalledLeadRuntimeEvidence({
    ...synthetic,
    runtimeEvents: synthetic.runtimeEvents.filter((event) => event.stage !== 'completion'),
  });
  assert.equal(missingCompletion.ok, false);
  assert.ok(missingCompletion.errors.some((error) => /completion PASS/.test(error)));

  const directBypass = validateInstalledLeadRuntimeEvidence({
    ...synthetic,
    leadAction: {
      ...synthetic.leadAction,
      source: synthetic.leadAction.source.replace(
        "'../.hybrid/core/orchestrator/index.mjs'",
        "'../../core/orchestrator/index.mjs'"
      ),
    },
  });
  assert.equal(directBypass.ok, false);
  assert.ok(directBypass.errors.some((error) => /installed orchestrator/.test(error)));
  assert.ok(directBypass.errors.some((error) => /framework-source-direct bypass/.test(error)));

  return {
    status: 'preflight-passed',
    case: 'I',
    workspace,
    installed: {
      manifest: installed.manifestExists,
      orchestrator: installed.orchestratorExists,
      export: installed.orchestratorExport,
      agentsContract: installed.agentsContract,
      skillContract: installed.skillContract,
      coreIntegrity: installed.coreIntegrity,
    },
    fixture: installed.fixture,
    validator: {
      positiveSyntheticEvidence: positive.ok,
      rejectsFakeSuccessWithoutEvents: !noEvents.ok,
      rejectsMissingCompletion: !missingCompletion.ok,
      rejectsFrameworkSourceBypass: !directBypass.ok,
      runtimeExecuted: false,
    },
  };
}

export async function runInstalledLeadRuntimeSmoke(options = {}) {
  const preflight = await preflightInstalledLeadSmoke();
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await runCodexDoctor(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: 'I',
      reason: doctor.summary || 'Codex credentials are not ready',
      codexVersion: doctor.codexVersion,
      preflight,
    };
  }

  const workspace = await createDisposableProject('live');
  await seedFixture(workspace);
  await installProject(workspace, { skipCodexValidation: true });
  const installed = await inspectInstalledContract(workspace);
  await commitBaseline(workspace);

  const runtimeRoot = path.join(workspace, '.planning', 'runtime-events');
  const actionPath = path.join(workspace, ACTION_RELATIVE_PATH);
  const prompt = leadPrompt({ workspace, runtimeRoot });
  const codexArgs = [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    options.sandbox || 'workspace-write',
    '--cd',
    workspace,
    prompt,
  ];
  const run = await runCodexExec(codexBin, codexArgs, {
    cwd: workspace,
    timeoutMs: options.timeoutMs || 240000,
  });

  const actionSource = await fs.readFile(actionPath, 'utf8').catch(() => '');
  const runtimeEvents = await readJsonLines(path.join(workspace, EVENT_RELATIVE_PATH));
  const finalInstalledCoreDigest = await digestTree(path.join(workspace, '.hybrid', 'core'));
  const finalFixture = await fixtureState(workspace);
  await fs.writeFile(path.join(workspace, '.planning', 'installed-lead-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(workspace, '.planning', 'installed-lead-codex.stderr.log'), run.stderr || '', 'utf8');
  const evidence = {
    workspace,
    leadCwd: workspace,
    leadAction: {
      path: actionPath,
      source: actionSource,
      cwd: workspace,
    },
    installed: {
      installed: installed.manifestExists && installed.orchestratorExists,
      ...installed,
      coreIntegrityAfterRun: installed.installedCoreDigest === finalInstalledCoreDigest,
    },
    fixture: {
      initialValid: installed.fixture.initialValid,
      finalValid: finalFixture.finalValid,
    },
    authentication: doctor,
    codex: {
      code: run.code,
      timedOut: run.timedOut === true,
      stdout: run.stdout || '',
      args: codexArgs,
      cwd: workspace,
      commandExecutions: extractCommandExecutions(run.stdout || ''),
    },
    runtimeEvents,
    expected: {
      runId: CASE_ID,
      snapshot: SNAPSHOT,
      actionRelativePath: ACTION_RELATIVE_PATH,
    },
  };
  const semantic = validateInstalledLeadRuntimeEvidence(evidence);
  const reportPath = path.join(workspace, '.planning', 'installed-lead-runtime-smoke-report.json');
  await fs.writeFile(reportPath, JSON.stringify({ case: 'I', semantic, evidence: {
    leadActionPath: actionPath,
    codexExitCode: run.code,
    runtimeEventCount: runtimeEvents.length,
    installedCoreIntegrity: evidence.installed.coreIntegrityAfterRun,
    fixture: evidence.fixture,
  } }, null, 2) + '\n', 'utf8');

  return {
    status: semantic.ok ? 'completed' : 'failed',
    case: 'I',
    workspace,
    eventsPath: path.join(workspace, EVENT_RELATIVE_PATH),
    actionPath,
    reportPath,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    semantic,
    ...(semantic.ok ? {} : { error: semantic.errors.join('; ') }),
  };
}

export function validateInstalledLeadRuntimeEvidence(input = {}) {
  const errors = [];
  const workspace = path.resolve(String(input.workspace || ''));
  const actionRelativePath = input.expected?.actionRelativePath || ACTION_RELATIVE_PATH;
  const actionPath = path.resolve(String(input.leadAction?.path || ''));
  const expectedActionPath = path.join(workspace, actionRelativePath);

  if (!input.workspace || actionPath !== expectedActionPath) {
    errors.push('Lead action file is not inside the disposable project');
  }
  if (path.resolve(String(input.leadCwd || '')) !== workspace || path.resolve(String(input.leadAction?.cwd || '')) !== workspace) {
    errors.push('Lead cwd is not the disposable project root');
  }

  const installed = input.installed || {};
  if (installed.installed !== true || installed.manifestExists !== true) {
    errors.push('.hybrid installed manifest is missing');
  }
  if (installed.orchestratorExists !== true || installed.orchestratorExport !== true) {
    errors.push('installed orchestrator/export contract is missing');
  }
  if (installed.agentsContract !== true || installed.skillContract !== true) {
    errors.push('installed AGENTS/skill contract does not mention runQualityClosure');
  }
  if (installed.coreIntegrity !== true || installed.coreIntegrityAfterRun !== true) {
    errors.push('installed .hybrid/core source changed or did not match installer source');
  }
  if (input.fixture?.initialValid !== true || input.fixture?.finalValid !== true) {
    errors.push('deterministic fixture shape or final behavior is invalid');
  }

  const authentication = input.authentication || {};
  const codex = input.codex || {};
  if (authentication.authStatus !== 'ok') errors.push('Codex authentication was not confirmed by doctor');
  if (codex.code !== 0 || codex.timedOut === true) {
    errors.push('authenticated Codex Lead execution did not complete successfully');
  }
  const args = Array.isArray(codex.args) ? codex.args : [];
  const cdIndex = args.indexOf('--cd');
  if (cdIndex < 0 || path.resolve(String(args[cdIndex + 1] || '')) !== workspace || path.resolve(String(codex.cwd || '')) !== workspace) {
    errors.push('Codex Lead was not launched from the disposable project root');
  }

  const commandExecutions = Array.isArray(codex.commandExecutions) ? codex.commandExecutions : [];
  const actionWasRun = commandExecutions.some((item) =>
    typeof item.command === 'string' &&
    item.command.includes(actionRelativePath) &&
    /(?:^|[\s'"])(?:[^\s'"]*\/)?node(?:\.exe)?(?:\s|$|["'])/i.test(item.command) &&
    item.exitCode === 0 &&
    (!item.cwd || path.resolve(item.cwd) === workspace)
  );
  if (!actionWasRun) errors.push('Codex JSON has no successful command execution for the Lead action script');

  const actionSource = String(input.leadAction?.source || '');
  const importSpecifiers = extractImportSpecifiers(actionSource);
  const installedOrchestrator = path.join(workspace, '.hybrid', 'core', 'orchestrator', 'index.mjs');
  const installedImport = importSpecifiers.some((specifier) =>
    path.resolve(path.dirname(actionPath), specifier) === installedOrchestrator
  );
  if (!installedImport || !/\brunQualityClosure\s*\(/.test(actionSource)) {
    errors.push('Lead action does not invoke the installed orchestrator export');
  }
  if (!/\btier\s*:\s*0\b/.test(actionSource) || !/\bqa\s*:/.test(actionSource) || !/\bverifier\s*:/.test(actionSource)) {
    errors.push('Lead action does not use the normal Tier 0 closure callbacks');
  }
  if (!/\bexecFileSync\s*\(/.test(actionSource) || !/assert(?:\.equal)?/.test(actionSource) || !/src\/value\.mjs/.test(actionSource)) {
    errors.push('Lead verifier callback does not execute the focused fixture assertion');
  }
  if (!/\b(?:result|closure)\.(?:pass|completion)\b/.test(actionSource)) {
    errors.push('Lead action does not check the generic closure result');
  }
  if (/\b(?:spawn_agent|spawnAgent|runCodexExec)\b/.test(actionSource)) {
    errors.push('Lead action contains recursive worker delegation');
  }

  const hasDirectSourceBypass = input.frameworkSourceBypass === true || hasFrameworkSourceBypass({
    actionPath,
    actionSource,
    commandExecutions,
  });
  if (hasDirectSourceBypass) errors.push('framework-source-direct bypass detected');

  const events = Array.isArray(input.runtimeEvents) ? input.runtimeEvents : [];
  const caseEvents = events.filter((event) =>
    event && event.runId === (input.expected?.runId || CASE_ID) &&
    event.taskId === (input.expected?.runId || CASE_ID) &&
    event.primitive === 'runQualityClosure'
  );
  if (!caseEvents.length) errors.push('generic primitive runtime lifecycle events are missing');
  const eventSnapshot = input.expected?.snapshot || SNAPSHOT;
  if (caseEvents.some((event) => event.snapshot !== eventSnapshot)) {
    errors.push('generic primitive lifecycle events do not bind to the baseline snapshot');
  }
  const qaStart = caseEvents.findIndex((event) => event.stage === 'qa' && event.lifecycle === 'start');
  const qaEnd = caseEvents.findIndex((event) => event.stage === 'qa' && event.lifecycle === 'end');
  const verifierStart = caseEvents.findIndex((event) => event.stage === 'verifier' && event.lifecycle === 'start');
  const verifierEnd = caseEvents.findIndex((event) => event.stage === 'verifier' && event.lifecycle === 'end');
  const completionPass = caseEvents.findIndex((event) => event.stage === 'completion' && event.outcome === 'pass');
  if (qaStart < 0 || qaEnd <= qaStart || verifierStart <= qaEnd || verifierEnd <= verifierStart) {
    errors.push('generic primitive QA/verifier lifecycle is incomplete or out of order');
  }
  if (caseEvents.some((event) =>
    (event.stage === 'qa' || event.stage === 'verifier') &&
    event.lifecycle === 'end' && event.outcome !== 'pass'
  )) errors.push('generic primitive QA or verifier did not pass');
  if (caseEvents.some((event) => ['repair', 'proof-acquisition'].includes(event.stage))) {
    errors.push('normal Tier 0 closure unexpectedly entered repair or proof acquisition');
  }
  if (completionPass <= verifierEnd) errors.push('generic primitive completion PASS is missing or out of order');
  if (caseEvents.some((event) => event.stage === 'completion' && event.outcome !== 'pass')) {
    errors.push('generic primitive emitted a completion failure');
  }

  const delegationSignals = findDelegationSignals(codex.stdout || '');
  if (delegationSignals.length || /\b(?:spawn_agent|spawnAgent|runCodexExec)\b/.test(actionSource)) {
    errors.push('recursive worker delegation was observed or requested');
  }

  return { ok: errors.length === 0, errors };
}

async function inspectInstalledContract(workspace) {
  const manifestPath = path.join(workspace, '.hybrid', 'manifest.json');
  const orchestratorPath = path.join(workspace, '.hybrid', 'core', 'orchestrator', 'index.mjs');
  const agentsPath = path.join(workspace, 'AGENTS.md');
  const skillPath = path.join(workspace, '.agents', 'skills', 'hybrid', 'SKILL.md');
  const [manifestExists, orchestratorExists, agents, skill, sourceDigest, installedDigest] = await Promise.all([
    exists(manifestPath),
    exists(orchestratorPath),
    readOptional(agentsPath),
    readOptional(skillPath),
    digestTree(path.join(sourceRoot, 'core')),
    digestTree(path.join(workspace, '.hybrid', 'core')),
  ]);
  let orchestratorExport = false;
  if (orchestratorExists) {
    const installedModule = await import(pathToFileURL(orchestratorPath).href + '?preflight=' + Date.now());
    orchestratorExport = typeof installedModule.runQualityClosure === 'function';
  }

  return {
    installed: manifestExists && orchestratorExists,
    manifestExists,
    orchestratorExists,
    orchestratorExport,
    agentsContract: /runQualityClosure/.test(agents),
    skillContract: /runQualityClosure/.test(skill),
    coreIntegrity: Boolean(sourceDigest) && sourceDigest === installedDigest,
    installedCoreDigest: installedDigest,
    fixture: await fixtureState(workspace),
  };
}

function makeSyntheticEvidence(workspace, installed) {
  const source = syntheticActionSource();
  return {
    workspace,
    leadCwd: workspace,
    leadAction: {
      path: path.join(workspace, ACTION_RELATIVE_PATH),
      source,
      cwd: workspace,
    },
    installed: {
      ...installed,
      installed: true,
      coreIntegrityAfterRun: true,
    },
    fixture: { initialValid: true, finalValid: true },
    authentication: { authStatus: 'ok' },
    codex: {
      code: 0,
      timedOut: false,
      cwd: workspace,
      args: ['exec', '--cd', workspace],
      stdout: '',
      commandExecutions: [{
        command: 'node .planning/lead-quality-closure.mjs',
        cwd: workspace,
        exitCode: 0,
      }],
    },
    runtimeEvents: syntheticLifecycleEvents(),
    expected: { runId: CASE_ID, snapshot: SNAPSHOT, actionRelativePath: ACTION_RELATIVE_PATH },
  };
}

function syntheticActionSource() {
  return [
    "import { runQualityClosure } from '../.hybrid/core/orchestrator/index.mjs';",
    "import { execFileSync } from 'node:child_process';",
    "import assert from 'node:assert/strict';",
    'const result = await runQualityClosure({ tier: 0, qa: async () => ({ ok: true }), verifier: async ({ snapshot }) => { execFileSync(process.execPath, ["--input-type=module", "-e", "import assert from \\\"node:assert/strict\\\"; import { value } from \\\"./src/value.mjs\\\"; assert.equal(value, 1)"], { cwd: process.cwd() }); assert.equal(true, true); return { ok: true, report: { snapshot, lightweightVerificationEvidence: { kind: "test", fresh: true, success: true } } }; } });',
    'if (!result.pass || !result.completion?.pass) throw new Error("closure failed");',
  ].join('\n');
}

function syntheticLifecycleEvents() {
  return [
    { runId: CASE_ID, taskId: CASE_ID, stage: 'qa', lifecycle: 'start', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: CASE_ID, taskId: CASE_ID, stage: 'qa', lifecycle: 'end', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: CASE_ID, taskId: CASE_ID, stage: 'verifier', lifecycle: 'start', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: CASE_ID, taskId: CASE_ID, stage: 'verifier', lifecycle: 'end', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
    { runId: CASE_ID, taskId: CASE_ID, stage: 'completion', outcome: 'pass', snapshot: SNAPSHOT, primitive: 'runQualityClosure' },
  ];
}

function leadPrompt({ workspace, runtimeRoot }) {
  return [
    'You are the installed Hybrid Lead in a disposable project. Read the installed AGENTS.md and .agents/skills/hybrid/SKILL.md contract and follow them.',
    'This is a tiny Tier 0 change. Do not spawn or delegate to any workers or agents.',
    'Change src/value.mjs from `export const value = 0;` to `export const value = 1;`.',
    'Run the focused deterministic check with Node and assert the imported value is exactly 1.',
    'After the integrated snapshot exists, as the Lead action required by the installed contract, create `.planning/lead-quality-closure.mjs` and execute it from the project root with Node.',
    'That action file must import `{ runQualityClosure }` from exactly `../.hybrid/core/orchestrator/index.mjs`, then invoke the imported function. Do not import anything from the framework source checkout.',
    'Call the generic primitive with repoRoot: process.cwd(), runId: "case-i", taskId: "case-i", snapshot: ' + JSON.stringify(SNAPSHOT) + ', tier: 0, and runtimeRoot: ' + JSON.stringify(runtimeRoot) + '.',
    'Provide direct async qa and verifier callbacks without spawning agents. QA returns `{ ok: true, findings: [] }`. Verifier must use execFileSync(process.execPath, ...) to rerun the focused assertion with assert.equal(value, 1) against src/value.mjs, then return `{ ok: true, verdict: "PASS", reason: "VERIFIED", report: { snapshot, lightweightVerificationEvidence: { kind: "test", fresh: true, success: true, source: "focused Node assertion" } } }`. Do not return a static pass.',
    'The action must throw or exit nonzero unless both result.pass and result.completion.pass are true. Do not fabricate or append runtime lifecycle events yourself; the generic primitive writes them.',
    'No other changes are needed. Do not modify .hybrid. The action must be actually executed with `node .planning/lead-quality-closure.mjs` from this disposable project root.',
    'Project root: ' + workspace,
  ].join('\n');
}

async function createDisposableProject(label) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-installed-lead-' + label + '-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.name', 'Hybrid Runtime Smoke'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'hybrid-smoke@example.invalid'], { cwd: workspace });
  return workspace;
}

async function seedFixture(workspace) {
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'value.mjs'), INITIAL_FIXTURE, 'utf8');
}

async function fixtureState(workspace) {
  const source = await fs.readFile(path.join(workspace, 'src', 'value.mjs'), 'utf8').catch(() => '');
  return {
    initialValid: source === INITIAL_FIXTURE,
    finalValid: source === FINAL_FIXTURE,
  };
}

async function commitBaseline(workspace) {
  await execFileAsync('git', ['add', '-A'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-q', '-m', 'Case I installed lead smoke baseline'], { cwd: workspace });
  const headRef = (await fs.readFile(path.join(workspace, '.git', 'HEAD'), 'utf8')).trim();
  const match = /^ref: (.+)$/.exec(headRef);
  if (!match) throw new Error('baseline commit left detached HEAD');
  const revision = (await fs.readFile(path.join(workspace, '.git', match[1]), 'utf8')).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error('baseline commit was not created');
}

async function digestTree(root) {
  const hash = createHash('sha256');
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return null;
  async function addTree(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const childRelative = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
      if (entry.isDirectory()) {
        hash.update('dir\0' + childRelative + '\0');
        await addTree(absolute, childRelative);
      } else if (entry.isFile()) {
        hash.update('file\0' + childRelative + '\0');
        hash.update(await fs.readFile(absolute));
      }
    }
  }
  await addTree(root);
  return hash.digest('hex');
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return [];
    }
  }
  return events;
}

function extractCommandExecutions(stdout) {
  const found = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    visit(row);
  }
  return found;

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const type = String(value.type || value.kind || '').toLowerCase();
    const command = typeof value.command === 'string' ? value.command : null;
    const exitCode = value.exit_code ?? value.exitCode ?? value.code;
    if (command && /command[_-]execution|exec_command/.test(type)) {
      found.push({
        command,
        cwd: value.cwd || value.working_directory || null,
        exitCode,
        type,
      });
    }
    for (const child of Object.values(value)) visit(child);
  }
}

function extractImportSpecifiers(source) {
  const values = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\()\s*(['"])([^'"]+)\1/g;
  let match;
  while ((match = pattern.exec(source))) values.push(match[2]);
  return values;
}

function hasFrameworkSourceBypass({ actionPath, actionSource, commandExecutions }) {
  const specs = extractImportSpecifiers(actionSource);
  if (specs.some((specifier) => {
    if (!/(?:^|\/)core\/orchestrator\/(?:index|quality-closure)\.mjs$/.test(specifier)) return false;
    return path.resolve(path.dirname(actionPath), specifier) !==
      path.join(path.dirname(actionPath), '..', '.hybrid', 'core', 'orchestrator', 'index.mjs');
  })) return true;

  return commandExecutions.some((item) =>
    typeof item.command === 'string' &&
    (item.command.includes(sourceRoot) || /(?:^|\s)(?:\.\.\/)+core\/orchestrator\//.test(item.command))
  );
}

function findDelegationSignals(stdout) {
  const signals = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    visit(row);
  }
  return signals;

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const type = [value.type, value.kind, value.name, value.tool, value.tool_name, value.toolName, value.method]
      .filter((item) => item != null)
      .join(' ')
      .toLowerCase();
    if (/(?:spawn[_-]?agent|agent[_-]?spawn|delegate|handoff_to_agent|collab.*(?:spawn|delegate))/.test(type)) signals.push(type);
    for (const child of Object.values(value)) visit(child);
  }
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function readOptional(filePath) {
  return fs.readFile(filePath, 'utf8').catch(() => '');
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  const mode = process.argv.includes('--preflight') ? 'preflight' : 'live';
  try {
    const result = mode === 'preflight'
      ? await preflightInstalledLeadSmoke()
      : await runInstalledLeadRuntimeSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'preflight-passed' && result.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    console.error('installed-lead-runtime-smoke:', error.message);
    process.exitCode = 1;
  }
}
