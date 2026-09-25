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

export function validateDecisionProvenanceEvidence(input = {}) {
  const { decisions = [], events = [] } = input;
  const errors = [];
  if (JSON.stringify(input) !== JSON.stringify(sanitizeStructuredMetadata(input))) errors.push('PROHIBITED_METADATA');
  if (!input.audit || input.audit.ok !== true) errors.push('MISSING_OR_FAILED_AUDIT');
  const audit = auditDecisionTrace({ decisions, events });
  errors.push(...audit.findings.map(f => f.code));
  if (JSON.stringify({ decisions, events }) !== JSON.stringify(sanitizeStructuredMetadata({ decisions, events }))) errors.push('PROHIBITED_METADATA');
  if (!decisions.some(d => d.decision === 'classify_tier_0' && d.facts?.tier === 0)) errors.push('MISSING_TIER0');
  const direct = decisions.find(d => d.stage === 'dispatch' && d.decision === 'lead_direct_execution' && d.intendedAction?.type === 'file_mutation' && d.reasonCodes?.includes('TIER0_TRIVIAL'));
  if (!direct || !events.some(e => e.decisionId === direct.decisionId && e.action === 'file_mutation' && e.files?.includes('README.md') && ['observed', 'derived'].includes(e.attribution))) errors.push('MISSING_DIRECT_ACTION');
  for (const action of ['lightweight-verify', 'completion']) if (!events.some(e => e.action === action && e.outcome === 'pass' && decisions.some(d => d.decisionId === e.decisionId && d.stage === (action === 'completion' ? 'completion' : 'review')))) errors.push('MISSING_' + action.toUpperCase());
  if (events.some(e => (e.actorRole || e.role) !== 'lead' || e.agentRunId || e.sourceAttribution === 'reported')) errors.push('FABRICATED_ATTRIBUTION');
  if (input.fixtureValid !== true) errors.push('FIXTURE_MISMATCH');
  return { ok: !errors.length, errors, audit };
}
function synthetic() {
  const decisions = [
    buildDecision({ runId, stage: 'classification', decision: 'classify_tier_0', facts: { tier: 0 }, policy: { rule: 'classification.tier' }, discriminator: 'synthetic' }),
    ...['file_mutation', 'lightweight-verify', 'completion'].map(action => buildDecision({ runId, stage: { file_mutation: 'dispatch', 'lightweight-verify': 'review', completion: 'completion' }[action], policy: { rule: action === 'completion' ? 'completion.evidence-gate' : 'execution.task-owner' }, decision: action === 'file_mutation' ? 'lead_direct_execution' : action, reasonCodes: ['TIER0_TRIVIAL'], intendedAction: { type: action, role: 'lead' } })),
  ];
  return { decisions, events: decisions.filter(d => d.intendedAction).map(d => ({ runId, decisionId: d.decisionId, action: d.intendedAction.type, actorRole: 'lead', role: 'lead', attribution: 'observed', files: ['README.md'], outcome: 'pass' })), fixtureValid: true, audit: { ok: true } };
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
    const api = await import(pathToFileURL(path.join(root, '.hybrid/core/provenance/index.mjs')));
    assert.equal(typeof api.createDecisionWriter, 'function');
    assert.match(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /Decision Provenance/);
    const orchestrator = await import(pathToFileURL(path.join(root, '.hybrid/core/orchestrator/index.mjs')));
    const prepared = orchestrator.prepareExecution({ request: 'Fix README.md typo', runId });
    assert.equal(prepared.classification.tier, 0);
    const positive = synthetic();
    positive.decisions.unshift(...prepared.decisionTrace);
    assert.equal(validateDecisionProvenanceEvidence(positive).ok, true);
    const negatives = {
      exitZeroWithoutDecisions: { ...positive, decisions: [], exitCode: 0 },
      missingAction: { ...positive, events: positive.events.slice(1) },
      orphanAction: { ...positive, events: [...positive.events, { ...positive.events[0], decisionId: 'missing' }] },
      idMismatch: { ...positive, decisions: positive.decisions.map((d, i) => i === 1 ? { ...d, decisionId: 'wrong' } : d) },
      fabricatedAttribution: { ...positive, events: positive.events.map(e => ({ ...e, attribution: 'reported' })) },
      missingAudit: { ...positive, audit: undefined },
      failedAudit: { ...positive, audit: { ok: false } },
      missingCompletion: { ...positive, events: positive.events.filter(e => e.action !== 'completion') },
    };
    for (const key of ['hiddenReasoning', 'prompt', 'rawSource']) negatives[key] = { ...positive, events: [{ ...positive.events[0], nested: { [key]: 'forbidden' } }, ...positive.events.slice(1)] };
    for (const [name, data] of Object.entries(negatives)) assert.equal(validateDecisionProvenanceEvidence(data).ok, false, name);
    return { status: 'preflight-passed', case: 'J', runtimeExecuted: false, negativeCases: Object.keys(negatives) };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
export async function runDecisionProvenanceRuntimeSmoke(options = {}) {
  const preflight = await preflightDecisionProvenanceSmoke();
  const bin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await runCodexDoctor(bin);
  if (doctor.authStatus !== 'ok') return { status: 'runtime-validation-pending', case: 'J', preflight, reason: doctor.summary };
  const root = await project('live');
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['-c', 'user.name=Hybrid', '-c', 'user.email=hybrid@example.invalid', 'commit', '-qm', 'Case J baseline'], { cwd: root });
  const script = `.planning/decision-action.mjs`;
  // The Lead must author and execute this action against the installed API.
  const prompt = `You are the installed Hybrid Lead in ${root}. Read AGENTS.md and installed hybrid skill. Do not delegate or spawn workers. Make the cheap Tier0 README.md change from ${JSON.stringify(initial)} to ${JSON.stringify(final)}. Create ${script} and execute it with node from the project root. Import prepareExecution from ../.hybrid/core/orchestrator/index.mjs, buildDecision, createDecisionWriter, auditDecisionTrace and writeAuditArtifact from ../.hybrid/core/provenance/index.mjs, and appendRuntimeEvent from ../.hybrid/core/observability/index.mjs. Use runId case-j and runtimeRoot .planning/runtime-events. Call prepareExecution with task {request:'Fix README.md typo',files:['README.md'],acceptanceCriteria:['README wording corrected']} and runId. Write its decisionTrace using createDecisionWriter({role:'lead',runId,runtimeRoot}). Use buildDecision to create a stage dispatch decision lead_direct_execution with policy {rule:'execution.task-owner'}, discriminator 'actual-mutation', and reasonCodes ['TIER0_TRIVIAL'] and intendedAction {type:'file_mutation',role:'lead'}. Write this decision, actually mutate README.md via fs, then append the file_mutation event linked to its decisionId, runId, files ['README.md'], actorRole lead, role lead, attribution observed. Read README.md and assert exact expected bytes for lightweight verification; create and write linked decisions/events for lightweight-verify (decision stage review, policy rule proof.cheapest-adequate-proof, intendedAction type lightweight-verify) and completion (decision stage completion, policy rule completion.evidence-gate, reasonCodes ALL_AC_VERIFIED, intendedAction type completion) with outcome pass, actorRole lead, role lead, attribution observed. Keep event stage names lightweight-verify and completion. Read decisions.jsonl and events.jsonl, run auditDecisionTrace on those raw records and write audit.json using installed writeAuditArtifact(audit,{runId,runtimeRoot}). Use schema APIs, never fabricate artifacts. Do not modify installed core. Do not commit. No agentRunId; no prompts, reasoning, source or diffs in artifacts.`;
  const run = await runCodexExec(bin, ['exec', '--strict-config', '--json', '--sandbox', 'workspace-write', '--cd', root, prompt], { cwd: root, timeoutMs: options.timeoutMs || 240000 });
  const directory = path.join(root, '.planning/runtime-events/runs/case-j');
  async function read(name) { try { return (await fs.readFile(path.join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } }
  const decisions = await read('decisions.jsonl');
  const events = await read('events.jsonl');
  const [audit] = await read('audit.json');
  const semantic = validateDecisionProvenanceEvidence({ decisions, events, audit, fixtureValid: await fs.readFile(path.join(root, 'README.md'), 'utf8') === final });
  const source = await fs.readFile(path.join(root, script), 'utf8').catch(() => '');
  if ([...source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)].some(match => match[2].includes('/core/') && !match[2].startsWith('../.hybrid/core/'))) semantic.errors.push('FRAMEWORK_SOURCE_BYPASS');
  if (!source.includes('../.hybrid/core/provenance/index.mjs') || !source.includes('../.hybrid/core/orchestrator/index.mjs') || !source.includes('prepareExecution(')) semantic.errors.push('INSTALLED_API_NOT_USED');
  if (!String(run.stdout).split('\n').some(line => { try { const row = JSON.parse(line); return /command_execution/.test(JSON.stringify(row)) && JSON.stringify(row).includes('node') && JSON.stringify(row).includes(script); } catch { return false; } })) semantic.errors.push('MISSING_EXECUTED_ACTION');
  if (/"(?:tool_name|name|type)"\s*:\s*"[^"\n]*(?:spawn_agent|delegate|collab)/i.test(run.stdout || '')) semantic.errors.push('DELEGATION');
  const changedCore = await exec('git', ['diff', 'HEAD', '--name-only', '--', '.hybrid/core'], { cwd: root });
  if (changedCore.stdout.trim()) semantic.errors.push('INSTALLED_CORE_CHANGED');
  if (run.code !== 0 || run.timedOut) semantic.errors.push('CODEX_FAILED');
  semantic.ok = !semantic.errors.length;
  await fs.writeFile(path.join(root, '.planning/decision-runtime-report.json'), JSON.stringify(semantic, null, 2));
  return { status: semantic.ok ? 'completed' : 'failed', case: 'J', workspace: root, semantic };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await (process.argv.includes('--preflight') ? preflightDecisionProvenanceSmoke() : runDecisionProvenanceRuntimeSmoke());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ['completed', 'preflight-passed'].includes(result.status) ? 0 : result.status === 'runtime-validation-pending' ? 2 : 1;
}
