#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { installProject } from './install-project.mjs';
import { runCodexDoctor, runCodexExec } from './runtime-smoke.mjs';
import { auditDecisionTrace, buildDecision } from '../core/provenance/index.mjs';
import { sanitizeStructuredMetadata } from '../core/observability/index.mjs';

const exec = promisify(execFile);
const initial = '# Case J\n';
const final = '# Case J verified\n';
const runId = 'case-j';
const taskId = 'readme';
const logicalAgentRunId = 'case-j-implementer';

function jsonl(text) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function delegationCalls(stdout = '') {
  const calls = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    try { walk(JSON.parse(line), calls); } catch {}
  }
  return calls;
}
function walk(value, calls) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, calls);
    return;
  }
  const name = value.tool_name || value.toolName || value.tool || value.name;
  if (typeof name === 'string' && /(?:^|\.)spawn_agent$/i.test(name)) calls.push(value);
  for (const child of Object.values(value)) walk(child, calls);
}
function hasInstalledCoreBypass(text = '') {
  const sources = [...String(text).matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].map(m => m[2]);
  return sources.some(source => source.includes('/core/') && !source.includes('.hybrid/core/'));
}

export function validateDecisionProvenanceEvidence(input = {}) {
  const { decisions = [], events = [], actorArtifacts = [] } = input;
  const errors = [];
  const sanitized = sanitizeStructuredMetadata({ decisions, events, actorArtifacts });
  if (JSON.stringify({ decisions, events, actorArtifacts }) !== JSON.stringify(sanitized)) errors.push('PROHIBITED_METADATA');
  if (!input.audit || input.audit.ok !== true) errors.push('MISSING_OR_FAILED_AUDIT');

  const candidateSpawn = decisions.find(d => d.decision === 'spawn_implementer' && d.files?.includes('README.md'));
  const actualTaskId = candidateSpawn?.taskId || taskId;
  const audit = auditDecisionTrace({
    decisions,
    events,
    actorArtifacts,
    taskOwnership: { [actualTaskId]: ['README.md'] },
  });
  errors.push(...audit.findings.map(f => f.code));

  if (!decisions.some(d => d.decision === 'classify_tier_0' && d.facts?.tier === 0)) errors.push('MISSING_TIER0');
  if (decisions.some(d => d.decision === 'lead_direct_execution')) errors.push('TIER0_LEAD_DIRECT_CONTRADICTION');
  if (!decisions.some(d => d.decision === 'activate' && d.facts?.targetRole === 'implementer' && d.facts?.activated === true)) errors.push('MISSING_IMPLEMENTER_ACTIVATION');

  const spawn = decisions.find(d =>
    d.decision === 'spawn_implementer' &&
    d.files?.includes('README.md') &&
    d.intendedAction?.type === 'spawn' &&
    d.intendedAction?.role === 'implementer'
  );
  if (!spawn) errors.push('MISSING_IMPLEMENTER_DECISION');
  if (spawn && !events.some(e =>
    e.decisionId === spawn.decisionId &&
    e.action === 'spawn' &&
    e.taskId === spawn.taskId &&
    e.targetRole === 'implementer' &&
    ['observed', 'derived'].includes(e.attribution)
  )) errors.push('MISSING_IMPLEMENTER_SPAWN_ACTION');

  if (spawn && !events.some(e =>
    e.decisionId === spawn.decisionId &&
    e.action === 'complete' &&
    e.taskId === spawn.taskId &&
    e.targetRole === 'implementer' &&
    ['observed', 'derived'].includes(e.attribution)
  )) errors.push('MISSING_IMPLEMENTER_COMPLETE_ACTION');

  const actor = actorArtifacts.find(a => a.taskId === spawn?.taskId && a.agentRunId === spawn?.agentRunId);
  if (!actor || actor.attribution !== 'reported' || !actor.files?.includes('README.md')) errors.push('MISSING_REPORTED_ACTOR_ARTIFACT');

  const verify = decisions.find(d => d.stage === 'review' && d.decision === 'lightweight_verify' && d.intendedAction?.type === 'lightweight-verify');
  if (!verify || !events.some(e => e.decisionId === verify.decisionId && e.action === 'lightweight-verify' && e.outcome === 'pass')) errors.push('MISSING_LIGHTWEIGHT_VERIFY');

  const completion = decisions.find(d => d.stage === 'completion' && d.intendedAction?.type === 'completion');
  if (!completion || !events.some(e => e.decisionId === completion.decisionId && e.action === 'completion' && e.outcome === 'pass')) errors.push('MISSING_COMPLETION');

  if (events.some(e => (e.actorRole || e.role) !== 'lead')) errors.push('CENTRAL_EVENT_NOT_LEAD');
  if (events.some(e => e.action === 'file_mutation' && (e.actorRole || e.role) === 'lead' && e.files?.includes('README.md'))) errors.push('LEAD_IMPLEMENTATION_BYPASS');
  if (actorArtifacts.some(a => a.attribution !== 'reported')) errors.push('ACTOR_NOT_REPORTED');
  if (input.fixtureValid !== true) errors.push('FIXTURE_MISMATCH');
  if (input.delegationCount != null && input.delegationCount < 1) errors.push('MISSING_ACTUAL_IMPLEMENTER_DELEGATION');
  if (input.installedApiUsed === false) errors.push('INSTALLED_API_NOT_USED');
  if (input.frameworkSourceBypass === true) errors.push('FRAMEWORK_SOURCE_BYPASS');
  if (input.installedCoreChanged === true) errors.push('INSTALLED_CORE_CHANGED');
  return { ok: !errors.length, errors: [...new Set(errors)], audit };
}

function synthetic() {
  const classification = buildDecision({
    runId, stage: 'classification', decision: 'classify_tier_0',
    facts: { tier: 0 }, policy: { rule: 'classification.tier' }, discriminator: 'synthetic-classification',
  });
  const activation = buildDecision({
    runId, stage: 'dispatch', decision: 'activate', parentDecisionId: classification.decisionId,
    facts: { targetRole: 'implementer', activated: true, tier: 0 },
    policy: { rule: 'pipeline.role-activation' }, discriminator: 'implementer',
  });
  const wave = buildDecision({
    runId, stage: 'scheduling', waveId: 'wave-1', decision: 'schedule_wave',
    facts: { wave: 1, taskIds: [taskId], mode: 'current-workspace' },
    policy: { rule: 'scheduler.dependency-and-file-ownership' },
    intendedAction: { type: 'dispatch-wave', waveId: 'wave-1', taskIds: [taskId], expectsEvent: false },
  });
  const spawn = buildDecision({
    runId, stage: 'dispatch', taskId, waveId: 'wave-1', agentRunId: logicalAgentRunId,
    decision: 'spawn_implementer', parentDecisionId: wave.decisionId,
    policy: { rule: 'execution.task-owner' }, reasonCodes: ['TASK_OWNER_IMPLEMENTER'],
    facts: { dependsOn: [], agentIdentityKind: 'framework-logical' },
    files: ['README.md'], intendedAction: { type: 'spawn', role: 'implementer', taskId },
  });
  const verify = buildDecision({
    runId, stage: 'review', taskId, decision: 'lightweight_verify',
    policy: { rule: 'proof.cheapest-adequate-proof' }, reasonCodes: ['TIER0_LIGHTWEIGHT_VERIFY'],
    files: ['README.md'], intendedAction: { type: 'lightweight-verify', role: 'lead' },
  });
  const completion = buildDecision({
    runId, stage: 'completion', taskId, decision: 'complete',
    policy: { rule: 'completion.evidence-gate' }, reasonCodes: ['ALL_AC_VERIFIED'],
    files: ['README.md'], intendedAction: { type: 'completion', role: 'lead' },
  });
  const events = [
    { runId, decisionId: spawn.decisionId, action: 'spawn', taskId, waveId: 'wave-1', agentRunId: logicalAgentRunId, targetRole: 'implementer', actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'] },
    { runId, decisionId: spawn.decisionId, action: 'complete', taskId, waveId: 'wave-1', agentRunId: logicalAgentRunId, targetRole: 'implementer', actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' },
    { runId, decisionId: verify.decisionId, action: 'lightweight-verify', taskId, actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' },
    { runId, decisionId: completion.decisionId, action: 'completion', taskId, actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' },
  ];
  const actorArtifacts = [{
    runId, decisionId: spawn.decisionId, action: 'file_mutation', taskId,
    agentRunId: logicalAgentRunId, attribution: 'reported', files: ['README.md'], outcome: 'pass',
  }];
  const decisions = [classification, activation, wave, spawn, verify, completion];
  const audit = auditDecisionTrace({ decisions, events, actorArtifacts, taskOwnership: { [taskId]: ['README.md'] } });
  return {
    decisions, events, actorArtifacts, audit, fixtureValid: true, delegationCount: 1,
    installedApiUsed: true, frameworkSourceBypass: false, installedCoreChanged: false,
  };
}

async function project(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-case-j-' + label + '-'));
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), initial);
  await installProject(root, { skipCodexValidation: true });
  return root;
}

export async function preflightDecisionProvenanceSmoke() {
  const root = await project('preflight');
  try {
    const provenance = await import(pathToFileURL(path.join(root, '.hybrid/core/provenance/index.mjs')));
    const observability = await import(pathToFileURL(path.join(root, '.hybrid/core/observability/index.mjs')));
    const orchestrator = await import(pathToFileURL(path.join(root, '.hybrid/core/orchestrator/index.mjs')));
    assert.equal(typeof provenance.createLeadProvenanceSession, 'function');
    assert.equal(typeof observability.createOrchestrationEventWriter, 'function');
    assert.equal(typeof orchestrator.prepareExecutionWithProvenance, 'function');
    assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /prepareExecutionWithProvenance/);

    const runtimeRoot = path.join(root, '.planning/runtime-events');
    const prepared = await orchestrator.prepareExecutionWithProvenance({
      runId, request: 'Fix README.md typo',
      task: { id: taskId, request: 'Fix README.md typo', files: ['README.md'], acceptanceCriteria: ['README wording corrected'] },
      tasks: [{ id: taskId, owner: 'implementer', files_modified: ['README.md'], depends_on: [], agentRunId: logicalAgentRunId, agentIdentityKind: 'framework-logical' }],
    }, { runId, repoRoot: root, runtimeRoot });
    assert.equal(prepared.classification.tier, 0);
    assert.deepEqual(prepared.pipeline, ['implementer', 'lightweight-verify']);
    assert.equal(prepared.provenance.persisted, true);
    assert.ok(prepared.decisionTrace.some(d => d.decision === 'spawn_implementer'));
    assert.ok(!prepared.decisionTrace.some(d => d.decision === 'lead_direct_execution'));

    const positive = synthetic();
    assert.equal(validateDecisionProvenanceEvidence(positive).ok, true);
    const negatives = {
      exitZeroWithoutDecisions: { ...positive, decisions: [], exitCode: 0 },
      missingAction: { ...positive, events: positive.events.filter(e => e.action !== 'spawn') },
      orphanAction: { ...positive, events: [...positive.events, { ...positive.events[0], decisionId: 'missing' }] },
      idMismatch: { ...positive, decisions: positive.decisions.map(d => d.decision === 'spawn_implementer' ? { ...d, decisionId: 'wrong' } : d) },
      fabricatedAttribution: { ...positive, events: positive.events.map(e => e.action === 'spawn' ? { ...e, attribution: 'reported' } : e) },
      missingAudit: { ...positive, audit: undefined },
      failedAudit: { ...positive, audit: { ok: false } },
      missingCompletion: { ...positive, events: positive.events.filter(e => e.action !== 'completion') },
      leadImplementationBypass: { ...positive, events: [...positive.events, { runId, decisionId: positive.decisions.find(d => d.decision === 'spawn_implementer').decisionId, action: 'file_mutation', actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'] }] },
      actorObserved: { ...positive, actorArtifacts: positive.actorArtifacts.map(a => ({ ...a, attribution: 'observed' })) },
      noDelegation: { ...positive, delegationCount: 0 },
      frameworkSourceBypass: { ...positive, frameworkSourceBypass: true },
      installedCoreChanged: { ...positive, installedCoreChanged: true },
    };
    for (const key of ['hiddenReasoning', 'prompt', 'rawSource']) {
      negatives[key] = { ...positive, events: [{ ...positive.events[0], nested: { [key]: 'forbidden' } }, ...positive.events.slice(1)] };
    }
    for (const [name, data] of Object.entries(negatives)) {
      assert.equal(validateDecisionProvenanceEvidence(data).ok, false, name);
    }
    return { status: 'preflight-passed', case: 'J', runtimeExecuted: false, negativeCases: Object.keys(negatives) };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readRun(root) {
  const runtime = await import(pathToFileURL(path.join(root, '.hybrid/core/runtime/index.mjs')));
  const directory = path.join(runtime.resolveHybridRuntimeRoot(root), 'runs', runId);
  const readLines = async name => {
    try { return jsonl(await fs.readFile(path.join(directory, name), 'utf8')); } catch { return []; }
  };
  const decisions = await readLines('decisions.jsonl');
  const events = await readLines('events.jsonl');
  const actorsDir = path.join(directory, 'actors');
  const actorArtifacts = [];
  try {
    for (const name of await fs.readdir(actorsDir)) {
      if (!name.endsWith('.jsonl')) continue;
      actorArtifacts.push(...jsonl(await fs.readFile(path.join(actorsDir, name), 'utf8')));
    }
  } catch {}
  let audit = null;
  try { audit = JSON.parse(await fs.readFile(path.join(directory, 'audit.json'), 'utf8')); } catch {}
  return { decisions, events, actorArtifacts, audit };
}

async function inspectRuntimeSource(root) {
  const files = [];
  async function visit(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(?:mjs|js|cjs)$/.test(entry.name)) files.push(full);
    }
  }
  await visit(path.join(root, '.planning'));
  let installedApiUsed = false;
  let frameworkSourceBypass = false;
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    installedApiUsed ||= source.includes('prepareExecutionWithProvenance') && source.includes('.hybrid/core/');
    frameworkSourceBypass ||= hasInstalledCoreBypass(source);
  }
  return { installedApiUsed, frameworkSourceBypass };
}

export async function runDecisionProvenanceRuntimeSmoke(options = {}) {
  const preflight = await preflightDecisionProvenanceSmoke();
  const bin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await runCodexDoctor(bin);
  if (doctor.authStatus !== 'ok') {
    return { status: 'runtime-validation-pending', case: 'J', preflight, reason: doctor.summary };
  }

  const root = await project('live');
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['-c', 'user.name=Hybrid', '-c', 'user.email=hybrid@example.invalid', 'commit', '-qm', 'Case J baseline'], { cwd: root });

  const prompt = [
    '$hybrid',
    'You are the installed Hybrid Lead in ' + root + '.',
    'Before changing files, read AGENTS.md and the installed .agents/skills/hybrid/SKILL.md, .agents/skills/execute/SKILL.md, and .agents/skills/review/SKILL.md contracts.',
    'Perform this trivial Tier 0 task: change README.md from "# Case J" to "# Case J verified".',
    'Use run id case-j. Completion must follow the installed Hybrid contract; if a required Implementer cannot be spawned, fail rather than substituting the Lead.',
    'Do not modify .hybrid/core. Do not commit.',
  ].join('\n');

  const run = await runCodexExec(bin, [
    'exec', '--strict-config', '--json', '--sandbox', 'workspace-write', '--cd', root, prompt,
  ], { cwd: root, timeoutMs: options.timeoutMs || 300000 });

  await fs.writeFile(path.join(root, '.planning/case-j-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/case-j-codex.stderr.log'), run.stderr || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/decision-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/decision-codex.stderr.log'), run.stderr || '', 'utf8');
  const evidence = await readRun(root);
  const runtimeSource = await inspectRuntimeSource(root);
  const changedCore = await exec('git', ['diff', 'HEAD', '--name-only', '--', '.hybrid/core'], { cwd: root });
  const semantic = validateDecisionProvenanceEvidence({
    ...evidence,
    fixtureValid: await fs.readFile(path.join(root, 'README.md'), 'utf8') === final,
    delegationCount: delegationCalls(run.stdout).length,
    installedApiUsed: runtimeSource.installedApiUsed || String(run.stdout).includes('prepareExecutionWithProvenance'),
    frameworkSourceBypass: runtimeSource.frameworkSourceBypass,
    installedCoreChanged: Boolean(changedCore.stdout.trim()),
  });
  if (run.code !== 0 || run.timedOut) semantic.errors.push('CODEX_FAILED');
  semantic.ok = !semantic.errors.length;
  await fs.writeFile(path.join(root, '.planning/decision-runtime-report.json'), JSON.stringify({
    semantic, delegationCount: delegationCalls(run.stdout).length, codexCode: run.code, timedOut: run.timedOut,
  }, null, 2));
  return { status: semantic.ok ? 'completed' : 'failed', case: 'J', workspace: root, semantic };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await (process.argv.includes('--preflight')
    ? preflightDecisionProvenanceSmoke()
    : runDecisionProvenanceRuntimeSmoke());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['completed', 'preflight-passed'].includes(result.status)
    ? 0
    : result.status === 'runtime-validation-pending' ? 2 : 1;
}
