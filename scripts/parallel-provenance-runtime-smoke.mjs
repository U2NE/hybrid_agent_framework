#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { installProject } from './install-project.mjs';
import { runCodexDoctor, runCodexExec } from './runtime-smoke.mjs';
import { auditDecisionTrace } from '../core/provenance/index.mjs';
import { sanitizeStructuredMetadata } from '../core/observability/index.mjs';

const exec = promisify(execFile);
const runId = 'case-k';
const tasks = [
  { id: 'A', owner: 'implementer', files_modified: ['src/a.txt'], depends_on: [] },
  { id: 'B', owner: 'implementer', files_modified: ['src/b.txt'], depends_on: [] },
];
const ownership = {
  A: { owner: 'implementer', files: ['src/a.txt'] },
  B: { owner: 'implementer', files: ['src/b.txt'] },
};
const CASE_K_TARGET_FILES = Object.freeze(['src/a.txt', 'src/b.txt']);

function caseKImplementerChildren(decisions = [], parent = null) {
  const candidates = decisions.filter(d =>
    d.decision === 'spawn_implementer' &&
    d.intendedAction?.role === 'implementer' &&
    Array.isArray(d.files) &&
    d.files.length > 0 &&
    d.files.every(file => CASE_K_TARGET_FILES.includes(file)) &&
    d.files.some(file => CASE_K_TARGET_FILES.includes(file))
  );
  return parent ? candidates.filter(d => d.parentDecisionId === parent.decisionId) : candidates;
}

export function validateParallelProvenanceEvidence(input = {}) {
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const actorArtifacts = Array.isArray(input.actorArtifacts) ? input.actorArtifacts : [];
  const errors = [];
  if (JSON.stringify(input) !== JSON.stringify(sanitizeStructuredMetadata(input))) errors.push('PROHIBITED_METADATA');
  if (!input.audit || input.audit.ok !== true) errors.push('AUDIT_MISSING_OR_FAILED');

  const parent = decisions.find(d => d.decision === 'parallel_wave' && d.stage === 'scheduling');
  if (!parent) errors.push('PARALLEL_PARENT_MISSING');
  const children = caseKImplementerChildren(decisions, parent);
  const childIds = new Set(children.map(d => d.taskId));
  const childDecisionIds = new Set(children.map(d => d.decisionId));
  const dynamicOwnership = Object.fromEntries(children.map(d => [
    d.taskId,
    { owner: 'implementer', files: [...(d.files || [])] },
  ]));
  const audit = auditDecisionTrace({ decisions, events, actorArtifacts, taskOwnership: dynamicOwnership });
  errors.push(...audit.findings.map(f => f.code));

  if (children.length !== 2) errors.push('CHILD_DECISION_MISSING');
  if (parent && children.some(d => d.parentDecisionId !== parent.decisionId)) errors.push('PARENT_LINK_MISMATCH');
  if (parent && children.some(d => d.waveId !== parent.waveId)) errors.push('WAVE_LINK_MISMATCH');
  if (new Set(children.map(d => d.taskId)).size !== 2) errors.push('TASK_ID_COLLISION');
  if (children.some(d => !d.agentRunId) || new Set(children.map(d => d.agentRunId)).size !== 2) errors.push('WORKER_IDENTITY_INVALID');
  if (children.some(d => d.facts?.requestedModel !== 'gpt-6-luna' || d.facts?.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
  const ownedFiles = children.flatMap(d => d.files || []);
  if (new Set(ownedFiles).size !== 2 || !CASE_K_TARGET_FILES.every(file => ownedFiles.includes(file))) errors.push('FILE_OWNERSHIP_MISMATCH');

  const actionEvents = events.filter(e => ['spawn', 'complete'].includes(e.action) && childIds.has(e.taskId));
  const firstComplete = actionEvents.findIndex(e => e.action === 'complete');
  if (firstComplete < 0 || actionEvents.slice(0, firstComplete).filter(e => e.action === 'spawn').length !== 2) errors.push('PARALLEL_DISPATCH_NOT_OBSERVED');
  if (children.some(d => !['native-observed', 'framework-logical'].includes(d.facts?.agentIdentityKind))) errors.push('WORKER_IDENTITY_KIND_INVALID');

  if (actorArtifacts.some(a =>
    CASE_K_TARGET_FILES.some(file => (a.files || []).includes(file)) &&
    (!childDecisionIds.has(a.decisionId) || !childIds.has(a.taskId))
  )) errors.push('ORPHAN_ACTOR_ARTIFACT');

  for (const child of children) {
    const linked = events.filter(e => e.decisionId === child.decisionId);
    if (!linked.some(e => e.action === 'spawn' && e.targetRole === 'implementer')) errors.push('SPAWN_ACTION_MISSING');
    if (!linked.some(e => e.action === 'complete' && e.targetRole === 'implementer')) errors.push('COMPLETE_ACTION_MISSING');
    const actor = actorArtifacts.find(a => a.decisionId === child.decisionId && a.agentRunId === child.agentRunId && a.taskId === child.taskId);
    if (!actor) errors.push('ACTOR_ARTIFACT_MISSING');
    else {
      if (actor.attribution !== 'reported') errors.push('ACTOR_ATTRIBUTION_INVALID');
      if ((actor.requestedModel != null || actor.requestedReasoningEffort != null) &&
          (actor.requestedModel !== 'gpt-6-luna' || actor.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
      const spawnEvent = linked.find(e => e.action === 'spawn' && e.targetRole === 'implementer');
      if (!spawnEvent || spawnEvent.requestedModel !== 'gpt-6-luna' || spawnEvent.requestedReasoningEffort !== 'medium') errors.push('WORKER_MODEL_POLICY_MISMATCH');
      const completeEvent = linked.find(e => e.action === 'complete' && e.targetRole === 'implementer');
      if (completeEvent && (completeEvent.requestedModel != null || completeEvent.requestedReasoningEffort != null) &&
          (completeEvent.requestedModel !== 'gpt-6-luna' || completeEvent.requestedReasoningEffort !== 'medium')) errors.push('WORKER_MODEL_POLICY_MISMATCH');
      const allowed = child.files || [];
      if ((actor.files || []).some(file => !allowed.includes(file))) errors.push('FILE_OWNERSHIP_MISMATCH');
    }
  }

  if (events.filter(e => e.decisionId || e.action).some(e => e.actorRole !== 'lead' || e.role !== 'lead')) errors.push('CENTRAL_WRITER_VIOLATION');
  if (events.some(e =>
    e.action === 'file_mutation' &&
    e.actorRole === 'lead' &&
    (e.files || []).some(file => CASE_K_TARGET_FILES.includes(file))
  )) errors.push('LEAD_IMPLEMENTATION_BYPASS');
  if (input.actualSiblingWorkersObserved !== true) errors.push('SIBLING_WORKERS_NOT_OBSERVED');
  if (input.fixtureValid !== true) errors.push('FIXTURE_MISMATCH');
  if (input.installedCoreUnchanged !== true) errors.push('INSTALLED_CORE_CHANGED');
  if (input.installedApiUsed !== true) errors.push('INSTALLED_API_NOT_USED');
  if (input.frameworkSourceBypass === true) errors.push('FRAMEWORK_SOURCE_BYPASS');
  if (input.outerRequestedModel !== 'gpt-6-luna' || input.outerRequestedReasoningEffort !== 'medium') errors.push('OUTER_MODEL_POLICY_MISMATCH');
  return { ok: !errors.length, errors: [...new Set(errors)], audit };
}

export async function preflightParallelProvenanceSmoke() {
  const root = await project('preflight');
  try {
    const orchestrator = await import(pathToFileURL(path.join(root, '.hybrid/core/orchestrator/index.mjs')));
    const provenance = await import(pathToFileURL(path.join(root, '.hybrid/core/provenance/index.mjs')));
    const observability = await import(pathToFileURL(path.join(root, '.hybrid/core/observability/index.mjs')));
    const runtimeRoot = path.join(root, '.planning/runtime-events');
    const prepared = await orchestrator.prepareExecutionWithProvenance({
      runId,
      request: 'Execute approved independent plan',
      tasks: tasks.map(task => ({ ...task, agentRunId: 'logical-' + task.id, agentIdentityKind: 'framework-logical' })),
    }, { repoRoot: root, runtimeRoot });
    const parent = prepared.decisionTrace.find(d => d.decision === 'parallel_wave');
    const children = prepared.decisionTrace.filter(d => d.decision === 'spawn_implementer');
    assert.ok(parent);
    assert.equal(children.length, 2);
    assert.ok(children.every(d => d.parentDecisionId === parent.decisionId && d.waveId === parent.waveId));

    assert.throws(() => provenance.createDecisionWriter({ role: 'worker', runId, runtimeRoot }));
    await assert.rejects(observability.appendRuntimeEvent({ runId, event: { decisionId: 'x', action: 'spawn', actorRole: 'worker' } }, { runtimeRoot }));

    const [childA, childB] = children;
    const eventFor = (d, action) => ({ runId, decisionId: d.decisionId, action, taskId: d.taskId, waveId: d.waveId, agentRunId: d.agentRunId, actorRole: 'lead', role: 'lead', targetRole: 'implementer', attribution: 'derived', files: ownership[d.taskId].files, requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium' });
    const events = [
      eventFor(childA, 'spawn'),
      eventFor(childB, 'spawn'),
      eventFor(childB, 'complete'),
      eventFor(childA, 'complete'),
    ];
    const actorArtifacts = children.map(d => ({ runId, taskId: d.taskId, waveId: d.waveId, decisionId: d.decisionId, agentRunId: d.agentRunId, action: 'file_mutation', attribution: 'reported', files: ownership[d.taskId].files, requestedModel: 'gpt-6-luna', requestedReasoningEffort: 'medium' }));
    const positive = {
      decisions: prepared.decisionTrace,
      events,
      actorArtifacts,
      audit: { ok: true },
      actualSiblingWorkersObserved: true,
      fixtureValid: true,
      installedCoreUnchanged: true,
      installedApiUsed: true,
      frameworkSourceBypass: false,
      outerRequestedModel: 'gpt-6-luna',
      outerRequestedReasoningEffort: 'medium',
    };
    assert.equal(validateParallelProvenanceEvidence(positive).ok, true);

    const negatives = {
      exitZeroNoDecisions: { ...positive, decisions: [] },
      oneChildMissing: { ...positive, decisions: prepared.decisionTrace.filter(d => d.taskId !== 'B') },
      serializedDispatch: { ...positive, events: [eventFor(childA, 'spawn'), eventFor(childA, 'complete'), eventFor(childB, 'spawn'), eventFor(childB, 'complete')] },
      spawnWithoutDecision: { ...positive, events: [...events, { ...events[0], decisionId: 'missing' }] },
      orphanWorker: { ...positive, actorArtifacts: [...actorArtifacts, { ...actorArtifacts[0], taskId: 'orphan', decisionId: 'missing', agentRunId: 'logical-orphan' }] },
      leadEdits: { ...positive, events: [...events, { ...events[0], action: 'file_mutation', taskId: 'A', actorRole: 'lead', role: 'lead' }] },
      crossWrite: { ...positive, actorArtifacts: actorArtifacts.map(a => a.taskId === 'A' ? { ...a, files: ['src/b.txt'] } : a) },
      workerCentralDecision: { ...positive, decisions: [{ ...prepared.decisionTrace[0], actor: { role: 'worker' } }, ...prepared.decisionTrace.slice(1)] },
      workerCentralAction: { ...positive, events: events.map((e, i) => i === 0 ? { ...e, actorRole: 'worker', role: 'worker' } : e) },
      actorObserved: { ...positive, actorArtifacts: actorArtifacts.map((a, i) => i === 0 ? { ...a, attribution: 'observed' } : a) },
      auditMissing: { ...positive, audit: undefined },
      auditFailed: { ...positive, audit: { ok: false } },
      installedApiMissing: { ...positive, installedApiUsed: false },
      frameworkBypass: { ...positive, frameworkSourceBypass: true },
      installedCoreModified: { ...positive, installedCoreUnchanged: false },
      outerModelMissing: { ...positive, outerRequestedModel: null },
      workerModelMismatch: { ...positive, events: events.map((e, i) => i === 0 ? { ...e, requestedModel: 'gpt-6-astra' } : e) },
    };
    for (const [name, data] of Object.entries(negatives)) assert.equal(validateParallelProvenanceEvidence(data).ok, false, name);
    return { status: 'preflight-passed', case: 'K', runtimeExecuted: false, negativeCases: Object.keys(negatives) };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function runParallelProvenanceRuntimeSmoke(options = {}) {
  const preflight = await preflightParallelProvenanceSmoke();
  const bin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await runCodexDoctor(bin);
  if (doctor.authStatus !== 'ok') return { status: 'runtime-validation-pending', case: 'K', preflight, reason: doctor.summary };

  const root = await project('live');
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['-c', 'user.name=Hybrid', '-c', 'user.email=hybrid@example.invalid', 'commit', '-qm', 'Case K baseline'], { cwd: root });
  const prompt = [
    '$hybrid',
    'Execute the exact approved Case K fixture in .planning/CASE-K.json and .planning/PLAN.md. Do not invent a different preparation input.',
    'Read AGENTS.md and the Hybrid skill contract, but do not inspect .hybrid/core source unless an installed API call fails.',
    'First call pure prepareExecution() on CASE-K.json and require one parallel wave containing Task A and Task B. Pure inspection must not write provenance.',
    'Then call prepareExecutionWithProvenance() on that exact same object exactly once. In that SAME Node process use exactly: const children = wired.decisionTrace.filter(d => d.decision === "spawn_implementer" && ["A","B"].includes(d.taskId)); do not look in wired.children, wired.dispatch, wired.decisions, and do not filter by discriminator. Require exactly two children and write those exact objects, unchanged, to .planning/CASE-K-DISPATCH.json. If coordination-file creation itself fails after the wired call, recover the exact persisted objects by using resolveHybridRuntimeRoot(process.cwd()) and reading runs/case-k/decisions.jsonl; do not search only inside the repository. Do not call prepareExecutionWithProvenance() again, do not replay decisionTrace manually, and never transcribe or retype a decisionId.',
    'Treat .planning/CASE-K-DISPATCH.json as transient Lead coordination state. Whenever a linked action is recorded, parse that file and pass the selected child object itself to createLeadProvenanceSession({runId:"case-k",repoRoot:process.cwd()}).writeActionForDecision(...).',
    'Spawn both sibling Implementers with explicit gpt-6-luna / medium before waiting for either worker. Task A owns only src/a.txt; Task B owns only src/b.txt. The Lead must edit neither file.',
    'Immediately after each successful native spawn, parse the exact matching A/B child object from CASE-K-DISPATCH.json and record its Lead spawn action with writeActionForDecision(child,{action:"spawn",attribution:"derived"}). Both spawn actions must be persisted before the first completion action.',
    'Each worker edits only its owned file. After editing, the worker must parse CASE-K-DISPATCH.json, select its own child by decision === "spawn_implementer" and its taskId, and use createActorArtifactWriter({runId:"case-k",repoRoot:process.cwd(),agentRunId:child.agentRunId}) to write one reported completion record containing runId, taskId, waveId, agentRunId, decisionId, action:"complete", outcome:"pass", exact owned files, requestedModel:"gpt-6-luna", and requestedReasoningEffort:"medium". Never hand-copy a decisionId.',
    'After each worker returns, the Lead parses that same exact child object from CASE-K-DISPATCH.json and records completion with writeActionForDecision(child,{action:"complete",attribution:"derived",outcome:"pass"}). Completion order may vary.',
    'Do not spawn Tester, Code Reviewer, Verifier, or any other role. Case K validates exactly the two sibling Implementers plus deterministic audit.',
    'Verify src/a.txt has exactly textual content A1 and src/b.txt has exactly textual content B1. The fixture accepts either no final line terminator or one final LF/CRLF, but no other trailing whitespace or content. To audit, compute the run directory with resolveHybridRuntimeRoot(process.cwd()) from .hybrid/core/runtime/index.mjs, read runs/case-k/decisions.jsonl, events.jsonl and actors/*.jsonl, run auditDecisionTrace with exact ownership A->src/a.txt and B->src/b.txt, and persist it with createLeadProvenanceSession({runId:"case-k",repoRoot:process.cwd()}).writeAudit(audit).',
    'Finish only if audit.ok is true and findings is empty. Use runtime run id case-k. Do not modify .hybrid/core. Do not commit.',
  ].join('\n');
  const run = await runCodexExec(bin, [
    'exec', '--strict-config', '--json', '--sandbox', 'workspace-write', '--cd', root,
    '-m', 'gpt-6-luna',
    '-c', 'model_reasoning_effort="medium"',
    prompt,
  ], {
    cwd: root,
    timeoutMs: options.timeoutMs || 360000,
  });

  await fs.writeFile(path.join(root, '.planning/case-k-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/case-k-codex.stderr.log'), run.stderr || '', 'utf8');
  const runtime = await import(pathToFileURL(path.join(root, '.hybrid/core/runtime/index.mjs')));
  const dir = path.join(runtime.resolveHybridRuntimeRoot(root), 'runs', runId);
  const { decisions, events, actorArtifacts, audit } =
    await readSettledParallelEvidence(dir, options.settleTimeoutMs ?? 20000);
  const changedCore = await exec('git', ['diff', 'HEAD', '--name-only', '--', '.hybrid/core'], { cwd: root });
  const semantic = validateParallelProvenanceEvidence({
    decisions,
    events,
    actorArtifacts,
    audit,
    actualSiblingWorkersObserved: artifactBackedSiblingExecution({ decisions, events, actorArtifacts }) && !hasLeadTargetMutation(run.stdout, ['src/a.txt', 'src/b.txt']),
    fixtureValid:
      matchesCaseKFixture(await fs.readFile(path.join(root, 'src/a.txt'), 'utf8').catch(() => ''), 'A1') &&
      matchesCaseKFixture(await fs.readFile(path.join(root, 'src/b.txt'), 'utf8').catch(() => ''), 'B1'),
    installedCoreUnchanged: !changedCore.stdout.trim(),
    installedApiUsed: (await inspectRuntimeSource(root)).installedApiUsed || String(run.stdout).includes('prepareExecutionWithProvenance'),
    frameworkSourceBypass: (await inspectRuntimeSource(root)).frameworkSourceBypass,
    outerRequestedModel: run.requestedModel,
    outerRequestedReasoningEffort: run.requestedReasoningEffort,
  });
  const usageLimit = usageLimitReason(run);
  if (run.code !== 0 || run.timedOut) semantic.errors.push('CODEX_FAILED');
  semantic.ok = !semantic.errors.length;
  const report = {
    semantic,
    artifactBackedSiblingExecution: artifactBackedSiblingExecution({ decisions, events, actorArtifacts }),
    nativeDelegationSignals: delegationCalls(run.stdout).length,
    leadMutationObserved: hasLeadTargetMutation(run.stdout, ['src/a.txt', 'src/b.txt']),
    outerRequestedModel: run.requestedModel,
    outerRequestedReasoningEffort: run.requestedReasoningEffort,
    codexCode: run.code,
    timedOut: run.timedOut,
    usageLimit,
  };
  await fs.writeFile(path.join(root, '.planning/parallel-provenance-runtime-report.json'), JSON.stringify(report, null, 2) + '\n');
  if (usageLimit) {
    return { status: 'runtime-validation-pending', case: 'K', workspace: root, reason: usageLimit, exitCode: run.code, semantic };
  }
  return { status: semantic.ok ? 'completed' : 'failed', case: 'K', workspace: root, exitCode: run.code, semantic };
}

async function project(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-case-k-' + label + '-'));
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.planning'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.txt'), 'A0\n');
  await fs.writeFile(path.join(root, 'src/b.txt'), 'B0\n');
  await fs.writeFile(path.join(root, '.planning/PLAN.md'), '# Approved Plan\n\nStatus: APPROVED\n\n## Task A\n- owner: implementer\n- files_modified: src/a.txt\n- depends_on: []\n- change: replace A0 with A1\n\n## Task B\n- owner: implementer\n- files_modified: src/b.txt\n- depends_on: []\n- change: replace B0 with B1\n\nThe two tasks are independent and approved for one parallel wave.\n');
  await installProject(root, { skipCodexValidation: true });
  const fixture = {
    runId,
    revision: 1,
    request: 'Execute approved independent Task A and Task B in one parallel wave',
    tasks: tasks.map(task => ({
      ...task,
      agentRunId: 'logical-' + task.id,
      agentIdentityKind: 'framework-logical',
    })),
  };
  await fs.writeFile(path.join(root, '.planning/CASE-K.json'), JSON.stringify(fixture, null, 2) + '\n');
  return root;
}
export function matchesCaseKFixture(actual, expected) {
  return actual === expected || actual === expected + '\n' || actual === expected + '\r\n';
}

async function readSettledParallelEvidence(dir, timeoutMs = 20000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let evidence = await readParallelEvidence(dir);
  while (Date.now() < deadline && !parallelArtifactsSettled(evidence)) {
    await new Promise(resolve => setTimeout(resolve, 250));
    evidence = await readParallelEvidence(dir);
  }
  return evidence;
}

async function readParallelEvidence(dir) {
  return {
    decisions: await readJsonLines(path.join(dir, 'decisions.jsonl')),
    events: await readJsonLines(path.join(dir, 'events.jsonl')),
    actorArtifacts: await readActorArtifacts(path.join(dir, 'actors')),
    audit: await readJson(path.join(dir, 'audit.json')),
  };
}

function parallelArtifactsSettled({ decisions = [], events = [], actorArtifacts = [], audit } = {}) {
  const parent = decisions.find(d => d.decision === 'parallel_wave' && d.stage === 'scheduling');
  const children = caseKImplementerChildren(decisions, parent);
  if (children.length !== 2 || audit?.ok !== true) return false;
  return children.every(child =>
    events.some(e => e.decisionId === child.decisionId && e.action === 'complete') &&
    actorArtifacts.some(a =>
      a.decisionId === child.decisionId &&
      a.taskId === child.taskId &&
      a.agentRunId === child.agentRunId &&
      a.attribution === 'reported'
    )
  );
}

async function readJsonLines(file) {
  try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return null; }
}
async function readActorArtifacts(dir) {
  try {
    const files = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl')).sort();
    return (await Promise.all(files.map(name => readJsonLines(path.join(dir, name))))).flat();
  } catch { return []; }
}
function delegationCalls(stdout = '') {
  const calls = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    try { walkDelegation(JSON.parse(line), calls); } catch {}
  }
  return calls;
}
function walkDelegation(value, calls) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkDelegation(item, calls);
    return;
  }
  const name = value.tool_name || value.toolName || value.tool || value.name;
  if (typeof name === 'string' && /(?:^|\.)spawn_agent$/i.test(name)) calls.push(value);
  for (const child of Object.values(value)) walkDelegation(child, calls);
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
function artifactBackedSiblingExecution({ decisions = [], events = [], actorArtifacts = [] } = {}) {
  const parent = decisions.find(d => d.decision === 'parallel_wave' && d.stage === 'scheduling');
  const children = caseKImplementerChildren(decisions, parent);
  if (!parent || children.length !== 2) return false;
  const actionEvents = events.filter(e =>
    ['spawn', 'complete'].includes(e.action) &&
    children.some(child => child.taskId === e.taskId)
  );
  const firstComplete = actionEvents.findIndex(e => e.action === 'complete');
  if (firstComplete < 0 || actionEvents.slice(0, firstComplete).filter(e => e.action === 'spawn').length !== 2) return false;
  return children.every(child => {
    const linked = events.filter(e => e.decisionId === child.decisionId);
    const actor = actorArtifacts.find(a =>
      a.decisionId === child.decisionId &&
      a.taskId === child.taskId &&
      a.agentRunId === child.agentRunId &&
      a.attribution === 'reported' &&
      (a.files || []).every(file => (child.files || []).includes(file))
    );
    return Boolean(
      actor &&
      linked.some(e => e.action === 'spawn' && e.targetRole === 'implementer' && ['observed', 'derived'].includes(e.attribution)) &&
      linked.some(e => e.action === 'complete' && e.targetRole === 'implementer' && ['observed', 'derived'].includes(e.attribution))
    );
  });
}

function usageLimitReason(run = {}) {
  const text = String(run.stdout || '') + '\n' + String(run.stderr || '');
  const match = text.match(/[^\n]*(?:usage limit|try again at)[^\n]*/i);
  return match ? match[0].replace(/^.*?"message":"?/, '').replace(/["}]+$/, '') : null;
}
async function inspectRuntimeSource(root) {
  const sources = await planningSources(root);
  return {
    installedApiUsed: sources.some(source => source.includes('prepareExecutionWithProvenance') && source.includes('.hybrid/core/')),
    frameworkSourceBypass: hasFrameworkSourceBypass(sources),
  };
}
async function planningSources(root) {
  const dir = path.join(root, '.planning');
  const out = [];
  async function walk(current) {
    let entries = [];
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:mjs|js)$/.test(entry.name)) out.push(await fs.readFile(full, 'utf8'));
    }
  }
  await walk(dir);
  return out;
}
function hasFrameworkSourceBypass(sources) {
  return sources.some(source => [...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)]
    .some(match => match[2].includes('/core/') && !match[2].includes('.hybrid/core/')));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await (process.argv.includes('--preflight') ? preflightParallelProvenanceSmoke() : runParallelProvenanceRuntimeSmoke());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['completed', 'preflight-passed'].includes(result.status) ? 0 : result.status === 'runtime-validation-pending' ? 2 : 1;
}
