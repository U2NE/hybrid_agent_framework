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

function commandExecutions(stdout = '') {
  const commands = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    try {
      const row = JSON.parse(line);
      const item = row.item || {};
      if (item.type === 'command_execution' && typeof item.command === 'string') commands.add(item.command);
    } catch {}
  }
  return [...commands];
}
function hasLeadTargetMutation(stdout, targets = []) {
  return commandExecutions(stdout).some(command => targets.some(target => {
    for (const candidate of [target, './' + target]) {
      const quoted = ["'" + candidate + "'", '"' + candidate + '"', '`' + candidate + '`'];
      for (const q of quoted) {
        if (command.includes('writeFile(' + q) ||
            command.includes('writeFileSync(' + q) ||
            command.includes('appendFile(' + q) ||
            command.includes('appendFileSync(' + q) ||
            command.includes('> ' + q) ||
            command.includes('tee ' + q) ||
            command.includes('open(' + q + ", 'w'") ||
            command.includes('open(' + q + ', "w"')) return true;
      }
      if (command.includes('> ' + candidate) || command.includes('tee ' + candidate)) return true;
    }
    return (command.includes('sed -i') || command.includes('perl -pi')) && command.includes(target);
  }));
}
function artifactBackedImplementerExecution({ decisions = [], events = [], actorArtifacts = [] } = {}) {
  const spawn = decisions.find(d =>
    d.decision === 'spawn_implementer' &&
    d.files?.includes('README.md') &&
    d.intendedAction?.role === 'implementer'
  );
  if (!spawn) return false;
  const linked = events.filter(e => e.decisionId === spawn.decisionId);
  const actor = actorArtifacts.find(a =>
    a.decisionId === spawn.decisionId &&
    a.taskId === spawn.taskId &&
    a.agentRunId === spawn.agentRunId &&
    a.attribution === 'reported'
  );
  return Boolean(
    actor &&
    linked.some(e => e.action === 'spawn' && e.targetRole === 'implementer' && ['observed', 'derived'].includes(e.attribution)) &&
    linked.some(e => e.action === 'complete' && e.targetRole === 'implementer' && ['observed', 'derived'].includes(e.attribution))
  );
}
function usageLimitReason(run = {}) {
  const text = String(run.stdout || '') + '\n' + String(run.stderr || '');
  const match = text.match(/[^\n]*(?:usage limit|try again at)[^\n]*/i);
  return match ? match[0].replace(/^.*?"message":"?/, '').replace(/["}]+$/, '') : null;
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
  if (spawn && (spawn.facts?.requestedModel !== 'gpt-6-luna' || spawn.facts?.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
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
  if (!actor || actor.attribution !== 'reported' || actor.decisionId !== spawn?.decisionId) errors.push('MISSING_REPORTED_ACTOR_ARTIFACT');
  if (actor && (actor.requestedModel != null || actor.requestedReasoningEffort != null) &&
      (actor.requestedModel !== 'gpt-6-luna' || actor.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
  if (spawn) {
    const linkedSpawn = events.find(e => e.decisionId === spawn.decisionId && e.action === 'spawn' && e.targetRole === 'implementer');
    if (!linkedSpawn || linkedSpawn.requestedModel !== 'gpt-6-luna' || linkedSpawn.requestedReasoningEffort !== 'medium') errors.push('WORKER_MODEL_POLICY_MISMATCH');
    const linkedComplete = events.find(e => e.decisionId === spawn.decisionId && e.action === 'complete' && e.targetRole === 'implementer');
    if (linkedComplete && (linkedComplete.requestedModel != null || linkedComplete.requestedReasoningEffort != null) &&
        (linkedComplete.requestedModel !== 'gpt-6-luna' || linkedComplete.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
  }

  const verify = decisions.find(d =>
    d.stage === 'review' &&
    d.intendedAction?.type === 'lightweight-verify' &&
    (d.facts?.contentMatches === true || /lightweight.*verif/i.test(String(d.decision)))
  );
  const verifyEvent = verify && events.find(e => e.decisionId === verify.decisionId && e.action === 'lightweight-verify');
  if (!verify || !verifyEvent || verifyEvent.outcome === 'fail') errors.push('MISSING_LIGHTWEIGHT_VERIFY');

  const completion = decisions.find(d =>
    d.stage === 'completion' &&
    ['completion', 'complete'].includes(d.intendedAction?.type)
  );
  const completionEvent = completion && events.find(e =>
    e.decisionId === completion.decisionId &&
    e.action === completion.intendedAction?.type
  );
  if (!completion || !completionEvent || completionEvent.outcome === 'fail') errors.push('MISSING_COMPLETION');

  if (events.some(e => (e.actorRole || e.role) !== 'lead')) errors.push('CENTRAL_EVENT_NOT_LEAD');
  if (events.some(e => e.action === 'file_mutation' && (e.actorRole || e.role) === 'lead' && e.files?.includes('README.md'))) errors.push('LEAD_IMPLEMENTATION_BYPASS');
  if (actorArtifacts.some(a => a.attribution !== 'reported')) errors.push('ACTOR_NOT_REPORTED');
  if (input.fixtureValid !== true) errors.push('FIXTURE_MISMATCH');
  if (input.workerExecutionObserved !== true) errors.push('MISSING_ACTUAL_IMPLEMENTER_EXECUTION');
  if (input.leadMutationObserved === true) errors.push('LEAD_IMPLEMENTATION_BYPASS');
  if (input.installedApiUsed === false) errors.push('INSTALLED_API_NOT_USED');
  if (input.frameworkSourceBypass === true) errors.push('FRAMEWORK_SOURCE_BYPASS');
  if (input.installedCoreChanged === true) errors.push('INSTALLED_CORE_CHANGED');
  if (input.outerRequestedModel !== 'gpt-6-luna' || input.outerRequestedReasoningEffort !== 'medium') errors.push('OUTER_MODEL_POLICY_MISMATCH');
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
    facts: { dependsOn: [], agentIdentityKind: 'framework-logical', requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium' },
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
    { runId, decisionId: spawn.decisionId, action: 'spawn', taskId, waveId: 'wave-1', agentRunId: logicalAgentRunId, targetRole: 'implementer', actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium' },
    { runId, decisionId: spawn.decisionId, action: 'complete', taskId, waveId: 'wave-1', agentRunId: logicalAgentRunId, targetRole: 'implementer', actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium', outcome: 'pass' },
    { runId, decisionId: verify.decisionId, action: 'lightweight-verify', taskId, actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' },
    { runId, decisionId: completion.decisionId, action: 'completion', taskId, actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' },
  ];
  const actorArtifacts = [{
    runId, decisionId: spawn.decisionId, action: 'file_mutation', taskId,
    agentRunId: logicalAgentRunId, attribution: 'reported', inspectedFiles: [], modifiedFiles: ['README.md'], requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium', outcome: 'pass',
  }];
  const decisions = [classification, activation, wave, spawn, verify, completion];
  const audit = auditDecisionTrace({ decisions, events, actorArtifacts, taskOwnership: { [taskId]: ['README.md'] } });
  return {
    decisions, events, actorArtifacts, audit, fixtureValid: true, workerExecutionObserved: true, leadMutationObserved: false,
    installedApiUsed: true, frameworkSourceBypass: false, installedCoreChanged: false,
    outerRequestedModel: 'gpt-6-luna', outerRequestedReasoningEffort: 'medium',
  };
}

async function project(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-case-j-' + label + '-'));
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), initial);
  await installProject(root, { skipCodexValidation: true });
  const fixture = {
    runId,
    revision: 1,
    request: 'Fix one-line typo in README.md',
    task: {
      id: taskId,
      request: 'Fix one-line typo in README.md',
      forceTier: 0,
      files: ['README.md'],
      acceptanceCriteria: ['README.md first line is # Case J verified'],
    },
    tasks: [{
      id: taskId,
      owner: 'implementer',
      files_modified: ['README.md'],
      depends_on: [],
      agentRunId: logicalAgentRunId,
      agentIdentityKind: 'framework-logical',
    }],
  };
  await fs.writeFile(path.join(root, '.planning/CASE-J.json'), JSON.stringify(fixture, null, 2) + '\n');
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
      noWorkerExecution: { ...positive, workerExecutionObserved: false },
      frameworkSourceBypass: { ...positive, frameworkSourceBypass: true },
      installedCoreChanged: { ...positive, installedCoreChanged: true },
      outerModelMissing: { ...positive, outerRequestedModel: null },
      workerModelMismatch: { ...positive, events: positive.events.map(e => e.action === 'spawn' ? { ...e, requestedModel: 'gpt-6-astra' } : e) },
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

async function readSettledRun(root, timeoutMs = 20000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let evidence = await readRun(root);
  while (Date.now() < deadline && !caseJArtifactsSettled(evidence)) {
    await new Promise(resolve => setTimeout(resolve, 250));
    evidence = await readRun(root);
  }
  return evidence;
}

function caseJArtifactsSettled({ decisions = [], events = [], actorArtifacts = [], audit } = {}) {
  const spawn = decisions.find(d => d.decision === 'spawn_implementer' && d.taskId === taskId);
  if (!spawn || audit?.ok !== true) return false;
  const actorReady = actorArtifacts.some(a =>
    a.decisionId === spawn.decisionId &&
    a.taskId === spawn.taskId &&
    a.agentRunId === spawn.agentRunId &&
    a.attribution === 'reported'
  );
  const completeReady = events.some(e =>
    e.decisionId === spawn.decisionId &&
    e.action === 'complete' &&
    e.outcome === 'pass'
  );
  const verifyReady = decisions.some(d => d.stage === 'review' && d.decision === 'lightweight_verify') &&
    events.some(e => e.action === 'lightweight-verify' && e.outcome === 'pass');
  const completionReady = decisions.some(d => d.stage === 'completion' && d.intendedAction?.type === 'completion') &&
    events.some(e => e.action === 'completion' && e.outcome === 'pass');
  return actorReady && completeReady && verifyReady && completionReady;
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
    'Execute the exact installed Case J fixture in .planning/CASE-J.json. Do not invent or renormalize a different preparation input.',
    'Read AGENTS.md and the Hybrid skill contract, but do not inspect .hybrid/core source unless an installed API call fails.',
    'First call pure prepareExecution() on the exact CASE-J object and require Tier 0 with pipeline implementer,lightweight-verify. Pure inspection must not write provenance.',
    'Then call prepareExecutionWithProvenance() on that exact same object exactly once. Do not persist trial preparations and do not replay decisionTrace manually.',
    'Keep the returned spawn_implementer decision as an object. Never transcribe or retype a decisionId.',
    'Spawn exactly one Implementer using the decision policy model gpt-6-luna and effort medium. The Lead must not edit README.md.',
    'After successful spawn, record the Lead spawn action with createLeadProvenanceSession().writeActionForDecision(spawnDecision,{action:"spawn",attribution:"derived"}).',
    'The Implementer must edit only README.md and write one reported actor artifact for its own agentRunId including taskId readme, waveId wave-1, inspectedFiles [], and modifiedFiles [README.md]. Do not emit a new legacy files field. It must locate the persisted spawn decision programmatically; do not hand-copy its decisionId.',
    'After the Implementer returns, record its completion with writeActionForDecision(spawnDecision,{action:"complete",attribution:"derived",outcome:"pass"}).',
    'Perform deterministic lightweight verification as Lead. Build one review decision named lightweight_verify with intendedAction {type:"lightweight-verify",role:"lead"} and facts.contentMatches=true, write it, then record its action via writeActionForDecision with outcome pass.',
    'Build one completion decision with stage completion, decision complete, intendedAction {type:"completion",role:"lead"}, write it, then record its action via writeActionForDecision with outcome pass.',
    'Run auditDecisionTrace over the persisted decisions/events/actor artifact and persist audit.json. Finish only if audit.ok is true and findings is empty.',
    'Use runtime run id case-j. Do not modify .hybrid/core. Do not commit.',
  ].join('\n');

  const run = await runCodexExec(bin, [
    'exec', '--strict-config', '--json', '--sandbox', 'workspace-write', '--cd', root,
    '-m', 'gpt-6-luna',
    '-c', 'model_reasoning_effort="medium"',
    prompt,
  ], { cwd: root, timeoutMs: options.timeoutMs || 360000 });

  await fs.writeFile(path.join(root, '.planning/case-j-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/case-j-codex.stderr.log'), run.stderr || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/decision-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/decision-codex.stderr.log'), run.stderr || '', 'utf8');
  const evidence = await readSettledRun(root, options.settleTimeoutMs ?? 20000);
  const runtimeSource = await inspectRuntimeSource(root);
  const changedCore = await exec('git', ['diff', 'HEAD', '--name-only', '--', '.hybrid/core'], { cwd: root });
  const semantic = validateDecisionProvenanceEvidence({
    ...evidence,
    fixtureValid: (await fs.readFile(path.join(root, 'README.md'), 'utf8')).trimEnd() === final.trimEnd(),
    workerExecutionObserved: artifactBackedImplementerExecution(evidence),
    leadMutationObserved: hasLeadTargetMutation(run.stdout, ['README.md']),
    installedApiUsed: runtimeSource.installedApiUsed || String(run.stdout).includes('prepareExecutionWithProvenance'),
    frameworkSourceBypass: runtimeSource.frameworkSourceBypass,
    installedCoreChanged: Boolean(changedCore.stdout.trim()),
    outerRequestedModel: run.requestedModel,
    outerRequestedReasoningEffort: run.requestedReasoningEffort,
  });
  const usageLimit = usageLimitReason(run);
  if (run.code !== 0 || run.timedOut) semantic.errors.push('CODEX_FAILED');
  semantic.ok = !semantic.errors.length;
  const report = {
    semantic,
    workerExecutionObserved: artifactBackedImplementerExecution(evidence),
    nativeDelegationSignals: delegationCalls(run.stdout).length,
    leadMutationObserved: hasLeadTargetMutation(run.stdout, ['README.md']),
    outerRequestedModel: run.requestedModel,
    outerRequestedReasoningEffort: run.requestedReasoningEffort,
    codexCode: run.code,
    timedOut: run.timedOut,
    usageLimit,
  };
  await fs.writeFile(path.join(root, '.planning/decision-runtime-report.json'), JSON.stringify(report, null, 2));
  if (usageLimit) {
    return { status: 'runtime-validation-pending', case: 'J', workspace: root, reason: usageLimit, semantic };
  }
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
