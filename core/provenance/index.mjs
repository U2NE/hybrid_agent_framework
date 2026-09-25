import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createOrchestrationEventWriter, sanitizeStructuredMetadata } from '../observability/index.mjs';
import { resolveHybridRuntimeRoot } from '../runtime/index.mjs';

export const DECISION_STAGES = Object.freeze(['classification', 'planning', 'scheduling', 'dispatch', 'routing', 'review', 'repair', 'proof', 'completion']);
export const DECISION_SCHEMA = 'hybrid-decision/v1';
const identityFields = ['runId', 'stage', 'taskId', 'waveId', 'snapshot', 'decision', 'revision', 'attempt', 'discriminator'];
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
}
export function decisionId(input = {}) {
  return 'decision-' + createHash('sha256').update(canonical(Object.fromEntries(identityFields.map(key => [key, input[key] ?? null])))).digest('hex');
}
export function buildDecision(input = {}) {
  const safe = sanitizeStructuredMetadata(input);
  if (safe.metadata) safe.metadata = boundedMetadata(safe.metadata);
  const record = { ...safe, timestamp: safe.timestamp ?? null, parentDecisionId: safe.parentDecisionId ?? null,
    waveId: safe.waveId ?? null, taskId: safe.taskId ?? null, agentRunId: safe.agentRunId ?? null,
    actor: safe.actor ?? { role: 'lead' }, snapshot: safe.snapshot ?? null,
    facts: boundedMetadata(safe.facts ?? {}), policy: safe.policy ?? null,
    reasonCodes: safe.reasonCodes ?? [], intendedAction: safe.intendedAction ?? null,
    evidenceRefs: safe.evidenceRefs ?? [], schema: DECISION_SCHEMA, decisionId: decisionId(safe) };
  const validation = validateDecision(record);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  return record;
}
// Only metadata is bounded: identity and ownership fields must remain exact.
function boundedMetadata(value, depth = 0) {
  if (depth > 8) return '[OMITTED]';
  if (typeof value === 'string') return value.slice(0, 1024);
  if (Array.isArray(value)) return value.slice(0, 64).map(item => boundedMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, boundedMetadata(item, depth + 1)]));
}
export function validateDecision(record = {}) {
  const errors = [];
  if (record.schema !== DECISION_SCHEMA) errors.push('invalid schema');
  for (const key of ['runId', 'stage', 'decision']) if (typeof record[key] !== 'string' || !record[key]) errors.push('missing ' + key);
  if (!DECISION_STAGES.includes(record.stage)) errors.push('invalid stage');
  if (record.actor?.role !== 'lead') errors.push('central actor must be lead');
  for (const key of ['timestamp', 'parentDecisionId', 'waveId', 'taskId', 'agentRunId', 'snapshot', 'facts', 'policy', 'reasonCodes', 'intendedAction', 'evidenceRefs']) if (!(key in record)) errors.push('missing ' + key);
  if (!record.facts || typeof record.facts !== 'object' || Array.isArray(record.facts)) errors.push('invalid facts');
  if (record.policy !== null && (typeof record.policy?.rule !== 'string' || !record.policy.rule)) errors.push('invalid policy');
  for (const key of ['reasonCodes', 'evidenceRefs']) if (!Array.isArray(record[key])) errors.push('invalid ' + key);
  if (record.intendedAction !== null && (typeof record.intendedAction !== 'object' || Array.isArray(record.intendedAction))) errors.push('invalid intendedAction');
  if (record.timestamp != null && (typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)))) errors.push('invalid timestamp');
  if (record.decisionId !== decisionId(record)) errors.push('decisionId mismatch');
  if (canonical(record) !== canonical(sanitizeStructuredMetadata(record))) errors.push('unsafe metadata');
  return { ok: !errors.length, errors };
}
function segment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)) throw new TypeError('invalid artifact identity');
  return value;
}
function runDirectory(options) {
  return path.join(options.runtimeRoot || resolveHybridRuntimeRoot(options.repoRoot || '.', options), 'runs', segment(options.runId));
}
async function write(file, value, options, append = true) {
  try {
    const safe = sanitizeStructuredMetadata(value);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs[append ? 'appendFile' : 'writeFile'](file, JSON.stringify(safe) + '\n', 'utf8');
    return { ok: true, path: file };
  } catch (error) {
    if (options.strict) throw error;
    return { ok: false, error: String(error.message) };
  }
}
export function createDecisionWriter(options = {}) {
  if (options.role !== 'lead') throw new TypeError('central decisions require lead writer');
  const file = path.join(runDirectory(options), 'decisions.jsonl');
  return async record => {
    if (record.runId !== options.runId || !validateDecision(record).ok) throw new TypeError('invalid central decision');
    return write(file, { ...record, timestamp: record.timestamp ?? new Date().toISOString() }, options);
  };
}
export function createActorArtifactWriter(options = {}) {
  const agentRunId = segment(options.agentRunId);
  const file = path.join(runDirectory(options), 'actors', agentRunId + '.jsonl');
  return async record => {
    if (record.agentRunId !== agentRunId || record.runId !== options.runId || record.schema === DECISION_SCHEMA || record.decision || record.intendedAction) throw new TypeError('actor writer cannot write central decisions or another actor');
    // A worker's self-report cannot attest observed attribution.
    return write(file, { ...record, attribution: 'reported' }, options);
  };
}
export async function writeAuditArtifact(audit, options = {}) {
  try { return await write(path.join(runDirectory(options), 'audit.json'), audit, options, false); }
  catch (error) { if (options.strict) throw error; return { ok: false, error: String(error.message) }; }
}

export function actionForDecision(decision, input = {}) {
  if (!validateDecision(decision).ok) throw new TypeError('valid decision required for linked action');
  const action = input.action || decision.intendedAction?.type;
  if (!action) throw new TypeError('linked action type required');
  return {
    ...input,
    runId: decision.runId,
    decisionId: decision.decisionId,
    action,
    stage: input.stage || decision.stage,
    taskId: decision.taskId,
    waveId: decision.waveId,
    agentRunId: decision.agentRunId,
    files: input.files || decision.files || [],
    targetRole: input.targetRole ?? decision.intendedAction?.role ?? null,
    requestedModel: input.requestedModel ?? decision.facts?.requestedModel ?? null,
    requestedReasoningEffort: input.requestedReasoningEffort ?? decision.facts?.requestedReasoningEffort ?? null,
    attribution: input.attribution || 'derived',
    actorRole: 'lead',
    role: 'lead',
  };
}

export function createLeadProvenanceSession(options = {}) {
  if (options.role && options.role !== 'lead') throw new TypeError('lead provenance session requires lead role');
  const base = { ...options, role: 'lead' };
  const writeDecision = createDecisionWriter(base);
  const writeAction = createOrchestrationEventWriter(base);
  return Object.freeze({
    writeDecision,
    writeAction,
    writeActionForDecision: (decision, input = {}) => writeAction(actionForDecision(decision, input)),
    writeAudit: audit => writeAuditArtifact(audit, base),
    createActorWriter: agentRunId => createActorArtifactWriter({ ...base, agentRunId }),
  });
}

export function auditDecisionTrace({ decisions = [], events = [], actorArtifacts = [], expectedSnapshot, taskOwnership = {} } = {}) {
  const findings = [];
  const add = (code, item = {}) => findings.push({ code, decisionId: item.decisionId ?? null, taskId: item.taskId ?? null });
  const byId = new Map(decisions.map(d => [d.decisionId, d]));
  if (byId.size !== decisions.length) add('DECISION_ACTION_MISMATCH');
  if (!decisions.length) add('MISSING_DECISION');
  for (const d of decisions) {
    if (!validateDecision(d).ok) add('DECISION_ACTION_MISMATCH', d);
    if (d.parentDecisionId && !byId.has(d.parentDecisionId)) add('MISSING_DECISION', d);
    const seen = new Set([d.decisionId]);
    let parent = byId.get(d.parentDecisionId);
    while (parent) {
      if (seen.has(parent.decisionId)) { add('DECISION_ACTION_MISMATCH', d); break; }
      seen.add(parent.decisionId); parent = byId.get(parent.parentDecisionId);
    }
    if (d.intendedAction && d.intendedAction.expectsEvent !== false && !events.some(e => matches(d, e))) add('MISSING_EXPECTED_ACTION', d);
  }
  for (const e of events) {
    if (canonical(e) !== canonical(sanitizeStructuredMetadata(e))) add('DECISION_ACTION_MISMATCH', e);
    if (!e.action && !e.decisionId) continue;
    const d = byId.get(e.decisionId);
    if (!d) { add('ORPHAN_ACTION', e); add('MISSING_DECISION', e); continue; }
    if (!matches(d, e) && !(e.action === 'complete' && d.intendedAction?.type === 'spawn' && matches(d, { ...e, action: 'spawn' }))) add('DECISION_ACTION_MISMATCH', e);
    const owner = taskOwnership[e.taskId] || {};
    const ownershipRole = owner.role || owner.owner || (typeof owner === 'string' ? owner : null);
    const implementationAction = ['spawn', 'complete', 'dispatch', 'file_mutation'].includes(e.action);
    const role = d.intendedAction?.role || d.owner || (implementationAction ? ownershipRole : null);
    if (role && eventRole(e) !== role) add('ROLE_OWNERSHIP_MISMATCH', e);
    const files = owner.files_modified || owner.files || d.files;
    if (d.files && (e.files || []).some(file => !d.files.includes(file))) add('FILE_OWNERSHIP_MISMATCH', e);
    if (files && files !== d.files && (e.files || []).some(file => !files.includes(file))) add('FILE_OWNERSHIP_MISMATCH', e);
    if ((expectedSnapshot !== undefined && canonical(e.snapshot) !== canonical(expectedSnapshot)) || (d.snapshot != null && canonical(e.snapshot) !== canonical(d.snapshot))) add('STALE_SNAPSHOT_ACTION', e);
    if (!['observed', 'derived'].includes(e.attribution) || e.sourceAttribution === 'reported') add('UNVERIFIED_ATTRIBUTION', e);
    if (actorArtifacts.some(a => a.agentRunId === e.agentRunId && a.agentRunId && a.decisionId === e.decisionId && (!a.action || a.action === e.action) && a.attribution === 'reported') && e.attribution === 'observed' && !(['spawn', 'complete'].includes(e.action) && (e.actorRole || e.role) === 'lead') && !e.evidenceRefs?.length && !e.observedEvidence?.length) add('UNVERIFIED_ATTRIBUTION', e);
  }
  for (const a of actorArtifacts) {
    // Actor artifacts are self-reports regardless of their claimed attribution.
    if (a.attribution !== 'reported') add('UNVERIFIED_ATTRIBUTION', a);
    if (canonical(a) !== canonical(sanitizeStructuredMetadata(a))) add('DECISION_ACTION_MISMATCH', a);
    const d = byId.get(a.decisionId);
    if (!d) { add('MISSING_DECISION', a); continue; }
    const owner = taskOwnership[a.taskId] || {};
    const files = owner.files_modified || owner.files || d?.files;
    if (files && (a.files || []).some(file => !files.includes(file))) add('FILE_OWNERSHIP_MISMATCH', a);
    if (d?.agentRunId && a.agentRunId !== d.agentRunId) add('ROLE_OWNERSHIP_MISMATCH', a);
  }
  findings.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { schema: 'hybrid-decision-audit/v1', ok: !findings.length, findings };
}
function matches(d, e) {
  const action = d.intendedAction;
  return e.decisionId === d.decisionId && e.runId === d.runId && (!action ? !e.action : e.action === action.type && (!action.role || eventRole(e) === action.role)) && ['taskId', 'waveId', 'agentRunId'].every(key => d[key] == null || d[key] === e[key]);
}

function eventRole(event) {
  return ['spawn', 'complete', 'dispatch', 'redispatch_planner'].includes(event.action)
    ? (event.targetRole || event.actorRole || event.role)
    : (event.actorRole || event.role);
}
