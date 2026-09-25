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

export function validateParallelProvenanceEvidence(input = {}) {
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const actorArtifacts = Array.isArray(input.actorArtifacts) ? input.actorArtifacts : [];
  const errors = [];
  if (JSON.stringify(input) !== JSON.stringify(sanitizeStructuredMetadata(input))) errors.push('PROHIBITED_METADATA');
  if (!input.audit || input.audit.ok !== true) errors.push('AUDIT_MISSING_OR_FAILED');
  const audit = auditDecisionTrace({ decisions, events, actorArtifacts, taskOwnership: ownership });
  errors.push(...audit.findings.map(f => f.code));

  const parent = decisions.find(d => d.decision === 'parallel_wave' && d.stage === 'scheduling');
  if (!parent) errors.push('PARALLEL_PARENT_MISSING');
  const children = decisions.filter(d => d.decision === 'spawn_implementer' && ['A', 'B'].includes(d.taskId));
  if (children.length !== 2) errors.push('CHILD_DECISION_MISSING');
  if (parent && children.some(d => d.parentDecisionId !== parent.decisionId)) errors.push('PARENT_LINK_MISMATCH');
  if (parent && children.some(d => d.waveId !== parent.waveId)) errors.push('WAVE_LINK_MISMATCH');
  if (new Set(children.map(d => d.taskId)).size !== 2) errors.push('TASK_ID_COLLISION');
  if (children.some(d => !d.agentRunId) || new Set(children.map(d => d.agentRunId)).size !== 2) errors.push('WORKER_IDENTITY_INVALID');
  if (children.some(d => !['native-observed', 'framework-logical'].includes(d.facts?.agentIdentityKind))) errors.push('WORKER_IDENTITY_KIND_INVALID');

  if (actorArtifacts.some(a => !decisions.some(d => d.decisionId === a.decisionId) || !['A', 'B'].includes(a.taskId))) errors.push('ORPHAN_ACTOR_ARTIFACT');

  for (const child of children) {
    const linked = events.filter(e => e.decisionId === child.decisionId);
    if (!linked.some(e => e.action === 'spawn' && e.targetRole === 'implementer')) errors.push('SPAWN_ACTION_MISSING');
    if (!linked.some(e => e.action === 'complete' && e.targetRole === 'implementer')) errors.push('COMPLETE_ACTION_MISSING');
    const actor = actorArtifacts.find(a => a.agentRunId === child.agentRunId && a.taskId === child.taskId);
    if (!actor) errors.push('ACTOR_ARTIFACT_MISSING');
    else {
      if (actor.attribution !== 'reported') errors.push('ACTOR_ATTRIBUTION_INVALID');
      const allowed = ownership[child.taskId].files;
      if ((actor.files || []).some(file => !allowed.includes(file))) errors.push('FILE_OWNERSHIP_MISMATCH');
    }
  }

  if (events.filter(e => e.decisionId || e.action).some(e => e.actorRole !== 'lead' || e.role !== 'lead')) errors.push('CENTRAL_WRITER_VIOLATION');
  if (events.some(e => e.action === 'file_mutation' && e.actorRole === 'lead' && ['A', 'B'].includes(e.taskId))) errors.push('LEAD_IMPLEMENTATION_BYPASS');
  if (input.actualSiblingWorkersObserved !== true) errors.push('SIBLING_WORKERS_NOT_OBSERVED');
  if (input.fixtureValid !== true) errors.push('FIXTURE_MISMATCH');
  if (input.installedCoreUnchanged !== true) errors.push('INSTALLED_CORE_CHANGED');
  if (input.installedApiUsed !== true) errors.push('INSTALLED_API_NOT_USED');
  if (input.frameworkSourceBypass === true) errors.push('FRAMEWORK_SOURCE_BYPASS');
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
    const eventFor = (d, action) => ({ runId, decisionId: d.decisionId, action, taskId: d.taskId, waveId: d.waveId, agentRunId: d.agentRunId, actorRole: 'lead', role: 'lead', targetRole: 'implementer', attribution: 'derived', files: ownership[d.taskId].files });
    const events = [
      eventFor(childA, 'spawn'),
      eventFor(childB, 'spawn'),
      eventFor(childB, 'complete'),
      eventFor(childA, 'complete'),
    ];
    const actorArtifacts = children.map(d => ({ runId, taskId: d.taskId, waveId: d.waveId, decisionId: d.decisionId, agentRunId: d.agentRunId, action: 'file_mutation', attribution: 'reported', files: ownership[d.taskId].files }));
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
    };
    assert.equal(validateParallelProvenanceEvidence(positive).ok, true);

    const negatives = {
      exitZeroNoDecisions: { ...positive, decisions: [] },
      oneChildMissing: { ...positive, decisions: prepared.decisionTrace.filter(d => d.taskId !== 'B') },
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
    'You are the installed Hybrid Lead in ' + root + '.',
    'Before changing files, read AGENTS.md and the installed .agents/skills/hybrid/SKILL.md and .agents/skills/execute/SKILL.md contracts.',
    'Execute the already-approved Hybrid plan in this repository using runtime run id case-k.',
    'Complete the implementation and verification through the installed Hybrid contract. If either required Implementer cannot be spawned, fail closed without editing its owned file.',
    'Do not modify .hybrid core. Do not commit.',
  ].join('\n');
  const run = await runCodexExec(bin, ['exec', '--strict-config', '--json', '--sandbox', 'workspace-write', '--cd', root, prompt], {
    cwd: root,
    timeoutMs: options.timeoutMs || 360000,
  });

  await fs.writeFile(path.join(root, '.planning/case-k-codex.events.jsonl'), run.stdout || '', 'utf8');
  await fs.writeFile(path.join(root, '.planning/case-k-codex.stderr.log'), run.stderr || '', 'utf8');
  const runtime = await import(pathToFileURL(path.join(root, '.hybrid/core/runtime/index.mjs')));
  const dir = path.join(runtime.resolveHybridRuntimeRoot(root), 'runs', runId);
  const decisions = await readJsonLines(path.join(dir, 'decisions.jsonl'));
  const events = await readJsonLines(path.join(dir, 'events.jsonl'));
  const actorArtifacts = await readActorArtifacts(path.join(dir, 'actors'));
  const audit = await readJson(path.join(dir, 'audit.json'));
  const changedCore = await exec('git', ['diff', 'HEAD', '--name-only', '--', '.hybrid/core'], { cwd: root });
  const semantic = validateParallelProvenanceEvidence({
    decisions,
    events,
    actorArtifacts,
    audit,
    actualSiblingWorkersObserved: delegationCalls(run.stdout).length >= 2,
    fixtureValid:
      await fs.readFile(path.join(root, 'src/a.txt'), 'utf8').catch(() => '') === 'A1\n' &&
      await fs.readFile(path.join(root, 'src/b.txt'), 'utf8').catch(() => '') === 'B1\n',
    installedCoreUnchanged: !changedCore.stdout.trim(),
    installedApiUsed: (await inspectRuntimeSource(root)).installedApiUsed || String(run.stdout).includes('prepareExecutionWithProvenance'),
    frameworkSourceBypass: (await inspectRuntimeSource(root)).frameworkSourceBypass,
  });
  if (run.code !== 0 || run.timedOut) semantic.errors.push('CODEX_FAILED');
  semantic.ok = !semantic.errors.length;
  await fs.writeFile(path.join(root, '.planning/parallel-provenance-runtime-report.json'), JSON.stringify(semantic, null, 2) + '\n');
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
  return root;
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
