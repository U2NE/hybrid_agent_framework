import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDecision, validateDecision, createDecisionWriter, createActorArtifactWriter, writeAuditArtifact, auditDecisionTrace } from '../../core/provenance/index.mjs';
import { appendRuntimeEvent, sanitizeStructuredMetadata, createOrchestrationEventWriter } from '../../core/observability/index.mjs';
import { prepareExecution, prepareExecutionWithProvenance, runQualityClosure } from '../../core/orchestrator/index.mjs';
import { assessSecurityReview, requiresSecurityReview } from '../../core/verification/index.mjs';
import { buildPlanningDecision } from '../../core/planning/index.mjs';
const decision = (extra = {}) => buildDecision({ runId: 'r', stage: 'dispatch', taskId: 'A', waveId: 'w', agentRunId: 'a', decision: 'dispatch', snapshot: 's', intendedAction: { type: 'dispatch', role: 'implementer' }, files: ['a.js'], ...extra });
const action = d => ({ runId: d.runId, decisionId: d.decisionId, action: d.intendedAction.type, role: d.intendedAction.role, taskId: d.taskId, waveId: d.waveId, agentRunId: d.agentRunId, snapshot: d.snapshot, attribution: 'observed', files: ['a.js'] });
const codes = result => result.findings.map(f => f.code);

test('stable schema and structured identity; recursive shared privacy', () => {
  const d = decision({ metadata: { nested: [{ hiddenReasoning: 'no', prompt: 'no', rawSource: 'no', scratchpad: 'no', apiKey: 'no', safe: 1 }] } });
  assert.equal(d.schema, 'hybrid-decision/v1');
  assert.deepEqual(d.metadata.nested, [{ apiKey: '[REDACTED]', safe: 1 }]);
  assert.equal(d.decisionId, decision().decisionId);
  for (const key of ['runId', 'taskId', 'waveId', 'snapshot', 'decision', 'revision', 'attempt', 'discriminator']) assert.notEqual(d.decisionId, decision({ [key]: 'different' }).decisionId);
  assert.equal(validateDecision({ ...d, decisionId: 'fake' }).ok, false);
  assert.deepEqual(sanitizeStructuredMetadata({ conversation: 'x', fullPrompt: 'x', nested: { password: 'x', authorization: 'x', sourceCode: 'x' } }), { nested: { password: '[REDACTED]', authorization: '[REDACTED]' } });
});
test('Lead central writer, scoped worker artifacts, storage failure and strict', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-test-'));
  try {
    const options = { runtimeRoot: root, runId: 'r' };
    assert.throws(() => createDecisionWriter({ ...options, role: 'implementer' }));
    const writer = createDecisionWriter({ ...options, role: 'lead' });
    assert.equal((await writer(decision())).ok, true);
    const worker = createActorArtifactWriter({ ...options, agentRunId: 'a' });
    await assert.rejects(worker({ runId: 'r', agentRunId: 'b' }));
    await assert.rejects(worker(decision()));
    await worker({ runId: 'r', agentRunId: 'a', attribution: 'observed', action: 'mutation' });
    const artifact = JSON.parse(await fs.readFile(path.join(root, 'runs/r/actors/a.jsonl')));
    assert.equal(artifact.attribution, 'reported');
    const blocked = path.join(root, 'file'); await fs.writeFile(blocked, 'x');
    assert.equal((await createDecisionWriter({ ...options, runtimeRoot: blocked, role: 'lead' })(decision())).ok, false);
    await assert.rejects(createDecisionWriter({ ...options, runtimeRoot: blocked, role: 'lead', strict: true })(decision()));
    assert.equal((await writeAuditArtifact({}, { ...options, runtimeRoot: blocked })).ok, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('parallel DAG accepts reordered siblings and detects missing siblings/orphans', () => {
  const parent = buildDecision({ runId: 'r', stage: 'scheduling', decision: 'parallel', waveId: 'w' });
  const children = ['A', 'B', 'C'].map(taskId => decision({ taskId, agentRunId: taskId, parentDecisionId: parent.decisionId }));
  for (const order of [[2, 0, 1], [1, 2, 0]]) assert.equal(auditDecisionTrace({ decisions: [parent, ...children], events: order.map(i => action(children[i])) }).ok, true);
  assert.ok(codes(auditDecisionTrace({ decisions: children, events: children.slice(1).map(action) })).includes('MISSING_EXPECTED_ACTION'));
  assert.ok(codes(auditDecisionTrace({ decisions: [], events: [action(children[0])] })).includes('ORPHAN_ACTION'));
});
test('planner/implementer bypass, cross-write, stale snapshot and attribution', () => {
  for (const role of ['planner', 'implementer']) {
    const d = decision({ intendedAction: { type: 'dispatch', role } });
    const findings = codes(auditDecisionTrace({ decisions: [d], events: [{ ...action(d), role: 'lead' }] }));
    assert.ok(findings.includes('MISSING_EXPECTED_ACTION'));
    assert.ok(findings.includes('ROLE_OWNERSHIP_MISMATCH'));
  }
  const d = decision();
  for (const [patch, code] of [[{ files: ['b.js'] }, 'FILE_OWNERSHIP_MISMATCH'], [{ snapshot: 'old' }, 'STALE_SNAPSHOT_ACTION'], [{ attribution: 'reported' }, 'UNVERIFIED_ATTRIBUTION'], [{ sourceAttribution: 'reported' }, 'UNVERIFIED_ATTRIBUTION']]) assert.ok(codes(auditDecisionTrace({ decisions: [d], events: [{ ...action(d), ...patch }] })).includes(code));
  assert.ok(codes(auditDecisionTrace({ decisions: [d], events: [action(d)], actorArtifacts: [{ decisionId: d.decisionId, agentRunId: 'a', action: 'dispatch', attribution: 'reported' }] })).includes('UNVERIFIED_ATTRIBUTION'));
});
test('explicit lead-owned administrative decision remains representable and planner-only revision helper is pure', () => {
  const d = decision({ agentRunId: undefined, decision: 'lead_direct_execution', intendedAction: { type: 'file_mutation', role: 'lead' }, reasonCodes: ['TIER0_TRIVIAL'] });
  assert.equal(auditDecisionTrace({ decisions: [d], events: [action(d)] }).ok, true);
  const plan = buildPlanningDecision({ verdict: 'ITERATE', revision: 2 });
  assert.equal(plan.intendedAction.role, 'planner');
  assert.equal(plan.decision, 'redispatch_planner');
  assert.equal(buildPlanningDecision({ verdict: 'APPROVE' }), null);
});
test('prepareExecution records existing isolation/routing/security without modifying fast path', () => {
  const fast = prepareExecution({ request: 'Fix README.md typo' });
  assert.deepEqual(fast.pipeline, ['implementer', 'lightweight-verify']);
  assert.ok(fast.decisionTrace.some(d => d.reasonCodes?.includes('TIER0_TRIVIAL')));
  assert.ok(fast.decisionTrace.some(d => d.facts?.targetRole === 'implementer' && d.decision === 'activate'));
  assert.ok(!fast.decisionTrace.some(d => d.decision === 'lead_direct_execution'));
  const input = { request: 'Add authentication', lunaExhausted: true, tasks: [{ id: 'A', files_modified: ['a.js'], codegen: true }, { id: 'B', files_modified: ['b.js'] }] };
  for (const worktreeAvailable of [true, false]) {
    const result = prepareExecution({ ...input, worktreeAvailable });
    const schedule = result.decisionTrace.filter(d => d.stage === 'scheduling');
    assert.equal(schedule[0].facts.mode, worktreeAvailable ? 'worktree' : 'current-workspace');
    assert.ok(result.decisionTrace.some(d => d.facts.targetRole === 'security-reviewer' && d.reasonCodes.includes('SECURITY_AUTHORIZATION_CHANGE')));
    assert.equal(result.decisionTrace.find(d => d.decision === 'route').stage, 'routing');
    assert.ok(result.decisionTrace.some(d => d.decision === 'route' && d.facts.escalated && d.facts.escalationReasons.includes('luna-capability-exhausted')));
    assert.deepEqual(result.decisionTrace, prepareExecution({ ...input, worktreeAvailable }).decisionTrace);
  }
  const fallback = prepareExecution({ ...input, modelRouting: { supportedModels: [] } });
  assert.ok(fallback.decisionTrace.some(d => d.decision === 'route' && d.facts.fallbackReason === 'model-not-available' && d.facts.inheritSessionModel));
  const serialized = prepareExecution({ tasks: [{ id: 'A', files_modified: ['a.js'] }, { id: 'B', files_modified: ['a.js'] }] });
  assert.equal(serialized.waves.length, 2);
  assert.ok(serialized.decisionTrace.some(d => d.stage === 'scheduling' && d.facts.conflicts.length));
  for (const description of ['authentication', 'authorization', 'file upload', 'trust boundary']) assert.equal(assessSecurityReview({ description }).required, true);
  assert.equal(requiresSecurityReview({ description: 'document token vocabulary', files: ['docs/token.md'] }), false);
});
test('pure preparation does zero provenance I/O and wired preparation persists automatically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-wired-'));
  const runtimeRoot = path.join(root, 'runtime');
  try {
    const input = {
      runId: 'wired',
      request: 'Fix README.md typo',
      task: { id: 'A', request: 'Fix README.md typo', files: ['README.md'], acceptanceCriteria: ['wording corrected'] },
      tasks: [{ id: 'A', owner: 'implementer', files_modified: ['README.md'], depends_on: [], agentRunId: 'logical-A', agentIdentityKind: 'framework-logical' }],
    };
    const pure = prepareExecution(input);
    assert.equal(await fs.access(runtimeRoot).then(() => true, () => false), false);
    assert.ok(!pure.decisionTrace.some(d => d.decision === 'lead_direct_execution'));
    const wired = await prepareExecutionWithProvenance(input, { runtimeRoot, repoRoot: root });
    assert.deepEqual(wired.pipeline, ['implementer', 'lightweight-verify']);
    assert.equal(wired.provenance.persisted, true);
    assert.equal(wired.provenance.count, wired.decisionTrace.length);
    const saved = (await fs.readFile(path.join(runtimeRoot, 'runs/wired/decisions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(saved.map(d => d.decisionId), wired.decisionTrace.map(d => d.decisionId));
    const spawn = saved.find(d => d.decision === 'spawn_implementer' && d.taskId === 'A');
    assert.ok(spawn);
    assert.equal(spawn.parentDecisionId, saved.find(d => d.decision === 'schedule_wave').decisionId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('wired preparation persistence failure is non-fatal and leaves prepared semantics intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-fail-'));
  const blocked = path.join(root, 'file');
  await fs.writeFile(blocked, 'x');
  try {
    const input = { runId: 'fail', request: 'Fix README.md typo' };
    const pure = prepareExecution(input);
    const wired = await prepareExecutionWithProvenance(input, { runtimeRoot: blocked });
    assert.deepEqual(wired.classification, pure.classification);
    assert.deepEqual(wired.pipeline, pure.pipeline);
    assert.deepEqual(wired.decisionTrace, pure.decisionTrace);
    assert.equal(wired.provenance.persisted, false);
    assert.ok(wired.provenance.error);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('public passive event append cannot bypass Lead-owned central action writer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'central-event-'));
  try {
    assert.equal((await appendRuntimeEvent({ runId: 'r', event: { stage: 'cache', outcome: 'hit' } }, { runtimeRoot: root })).ok, true);
    await assert.rejects(appendRuntimeEvent({ runId: 'r', event: { decisionId: 'd', action: 'spawn', actorRole: 'lead' } }, { runtimeRoot: root }), /central action events/);
    const writer = createOrchestrationEventWriter({ role: 'lead', runId: 'r', runtimeRoot: root });
    assert.equal((await writer({ decisionId: 'd', action: 'spawn', targetRole: 'implementer', attribution: 'observed', nested: { apiKey: 'secret' } })).ok, true);
    const rows = (await fs.readFile(path.join(root, 'runs/r/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].actorRole, 'lead');
    assert.equal(rows[1].nested.apiKey, '[REDACTED]');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('quality closure default path persists decisions and linked action events without injection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-default-provenance-'));
  try {
    const result = await runQualityClosure({
      runId: 'q',
      runtimeRoot: root,
      tier: 0,
      snapshot: 's',
      qa: async () => ({ ok: true }),
      verifier: async () => ({ ok: true, report: { criteria: [] } }),
    });
    const decisions = (await fs.readFile(path.join(root, 'runs/q/decisions.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const events = (await fs.readFile(path.join(root, 'runs/q/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(decisions.some(d => d.decision === 'repair_skip'));
    const completion = events.find(e => e.stage === 'completion' && e.action === 'completion');
    assert.ok(completion);
    assert.ok(decisions.some(d => d.decisionId === completion.decisionId && d.stage === 'completion'));
    assert.equal(completion.actorRole, 'lead');
    assert.ok(result.events.some(e => e.stage === 'completion'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('quality closure links completion and keeps logging optional/nonfatal', async () => {
  const records = [];
  const result = await runQualityClosure({ tier: 0, snapshot: 's', qa: async () => ({ ok: true }), verifier: async () => ({ ok: true, report: { criteria: [] } }), appendRuntimeEvent: async () => { throw Error('offline'); }, decisionWriter: async d => { records.push(d); throw Error('offline'); } });
  assert.ok(records.some(d => d.decision === 'repair_skip'));
  const completion = result.events.find(e => e.stage === 'completion');
  assert.ok(records.some(d => d.decisionId === completion.decisionId && ['complete', 'block'].includes(d.decision)));
});

test('canonical schema, Lead actor, persisted time and central event ownership', async () => {
  const stages = ['classification', 'planning', 'scheduling', 'dispatch', 'routing', 'review', 'repair', 'proof', 'completion'];
  for (const stage of stages) assert.equal(validateDecision(decision({ stage })).ok, true);
  for (const stage of ['execution', 'scheduler', 'repair-policy', 'proof-acquisition', 'file_mutation', 'lightweight-verify', 'implementer']) assert.throws(() => decision({ stage }));
  assert.throws(() => decision({ actor: { role: 'implementer' } }));
  const d = decision();
  for (const key of ['timestamp', 'runId', 'decisionId', 'parentDecisionId', 'waveId', 'taskId', 'agentRunId', 'stage', 'actor', 'snapshot', 'facts', 'policy', 'decision', 'reasonCodes', 'intendedAction', 'evidenceRefs']) {
    assert.ok(key in d, key);
    const incomplete = { ...d }; delete incomplete[key];
    assert.equal(validateDecision(incomplete).ok, false, key);
  }
  assert.equal(d.timestamp, null);
  assert.equal(decision({ timestamp: '2026-01-01T00:00:00.000Z' }).decisionId, d.decisionId);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provenance-time-'));
  try {
    const options = { runtimeRoot: root, runId: 'r', role: 'lead' };
    await createDecisionWriter(options)(d);
    const saved = JSON.parse(await fs.readFile(path.join(root, 'runs/r/decisions.jsonl')));
    assert.ok(Number.isFinite(Date.parse(saved.timestamp)));
    assert.equal(saved.decisionId, d.decisionId);
    assert.equal(d.timestamp, null);
    assert.throws(() => createOrchestrationEventWriter({ ...options, role: 'implementer' }));
    const writer = createOrchestrationEventWriter(options);
    await assert.rejects(writer({ actorRole: 'implementer' }));
    await assert.rejects(writer({ nested: { prompt: 'forbidden' } }));
    assert.equal((await writer({ action: 'spawn', targetRole: 'implementer', attribution: 'observed' })).ok, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('reported sibling artifacts coexist with observed orchestration and out-of-order completions', () => {
  const parent = buildDecision({ runId: 'r', stage: 'scheduling', decision: 'parallel_wave', intendedAction: { type: 'parallel-dispatch', expectsEvent: false } });
  const children = ['A', 'B', 'C'].map(taskId => decision({ taskId, agentRunId: null, parentDecisionId: parent.decisionId, intendedAction: { type: 'spawn', role: 'implementer' } }));
  const spawns = children.map(d => ({ ...action(d), agentRunId: d.taskId, actorRole: 'lead', role: 'lead', targetRole: 'implementer' }));
  const completed = [2, 0, 1].map(i => ({ ...spawns[i], action: 'complete' }));
  const actorArtifacts = children.map(d => ({ runId: 'r', taskId: d.taskId, decisionId: d.decisionId, agentRunId: d.taskId, action: 'file_mutation', attribution: 'reported', files: ['a.js'] }));
  assert.equal(auditDecisionTrace({ decisions: [parent, ...children], events: [...spawns, ...completed], actorArtifacts }).ok, true);
  assert.ok(codes(auditDecisionTrace({ decisions: [parent, ...children], events: [...spawns.slice(1), ...completed], actorArtifacts })).includes('MISSING_EXPECTED_ACTION'));
  const d = decision({ intendedAction: { type: 'file_mutation', role: 'implementer' } });
  const event = { ...action(d), actorRole: 'implementer', role: 'lead' };
  const reported = [{ agentRunId: 'a', decisionId: d.decisionId, action: 'file_mutation', attribution: 'reported' }];
  assert.ok(codes(auditDecisionTrace({ decisions: [d], events: [event], actorArtifacts: reported })).includes('UNVERIFIED_ATTRIBUTION'));
  assert.equal(auditDecisionTrace({ decisions: [d], events: [{ ...event, evidenceRefs: ['observed-diff'] }], actorArtifacts: reported }).ok, true);
  for (const role of ['planner', 'implementer']) {
    const expected = decision({ intendedAction: { type: 'spawn', role } });
    const bypass = { ...action(expected), action: 'file_mutation', actorRole: 'lead', role: 'lead', files: ['PLAN.md'] };
    const result = codes(auditDecisionTrace({ decisions: [expected], events: [bypass] }));
    assert.ok(result.includes('MISSING_EXPECTED_ACTION'));
    assert.ok(result.includes('ROLE_OWNERSHIP_MISMATCH'));
  }
  assert.ok(codes(auditDecisionTrace({ decisions: [d], events: [{ ...event, nested: { rawSource: 'bad' } }] })).includes('DECISION_ACTION_MISMATCH'));
  assert.ok(codes(auditDecisionTrace({ decisions: [d], events: [event], expectedSnapshot: 'new' })).includes('STALE_SNAPSHOT_ACTION'));
});
test('stable scheduling, isolation, routing, planning and security policies', () => {
  const tasks = [{ id: 'A', files_modified: ['a.js'] }, { id: 'B', files_modified: ['b.js'] }];
  const prepared = prepareExecution({ request: 'Fix README.md typo', tasks });
  const parallel = prepared.decisionTrace.find(d => d.decision === 'parallel_wave');
  assert.equal(parallel.policy.rule, 'execution.parallel-independent-writers');
  assert.deepEqual(parallel.reasonCodes, ['PARALLEL_DEPENDENCIES_SATISFIED', 'FILE_OWNERSHIP_DISJOINT']);
  assert.ok(prepared.decisionTrace.filter(d => d.decision === 'spawn_implementer').every(d => d.parentDecisionId === parallel.decisionId && d.reasonCodes.includes('TASK_OWNER_IMPLEMENTER')));
  const single = prepareExecution({ tasks: tasks.slice(0, 1) });
  assert.ok(!single.decisionTrace.some(d => d.decision === 'serialize_writers'));
  const serialized = prepareExecution({ tasks: tasks.map(t => ({ ...t, files_modified: ['same'] })) }).decisionTrace.find(d => d.decision === 'serialize_writers');
  assert.equal(serialized.policy.rule, 'execution.same-file-serialization');
  assert.deepEqual(serialized.reasonCodes, ['SAME_FILE_CONFLICT']);
  for (const [patch, code] of [
    [{ migration: true }, 'WORKTREE_MIGRATION_RISK'], [{ files_modified: ['generated/migrations/1.sql'] }, 'WORKTREE_MIGRATION_RISK'],
    [{ files_modified: ['package-lock.json'] }, 'WORKTREE_LOCKFILE_RISK'], [{ formatter: true }, 'WORKTREE_FORMATTER_RISK'],
    [{ fileOwnershipConfidence: 'low' }, 'WORKTREE_LOW_OWNERSHIP_CONFIDENCE'], [{ codegen: true }, 'WORKTREE_GENERATED_FILES_RISK'],
    [{ generatedFiles: true }, 'WORKTREE_GENERATED_FILES_RISK'],
  ]) {
    const d = prepareExecution({ tasks: [{ ...tasks[0], ...patch }, tasks[1]] }).decisionTrace.find(d => d.decision === 'use_worktree');
    assert.equal(d.policy.rule, 'execution.worktree-isolation');
    assert.ok(d.reasonCodes.includes(code));
  }
  assert.ok(prepareExecution({ tasks, forceWorktree: true }).decisionTrace.find(d => d.decision === 'use_worktree').reasonCodes.includes('WORKTREE_EXPLICIT'));
  for (const extra of [{}, { lunaExhausted: true }, { repeatedSameFailure: true }, { modelRouting: { supportedModels: [] } }]) {
    const result = prepareExecution({ tasks, ...extra });
    for (const route of result.modelRouting.stages) {
      const d = result.decisionTrace.find(d => d.stage === 'routing' && d.discriminator === route.stage);
      for (const key of ['role', 'routeLevel', 'modelTier', 'model', 'reasoningEffort', 'escalationReasons', 'fallbackReason']) assert.deepEqual(d.facts[key], route[key]);
      assert.equal(d.policy.rule, route.escalationReasons.length || route.fallbackReason ? 'routing.failure-escalation' : 'routing.luna-first');
    }
  }
  const plan = buildPlanningDecision({ verdict: 'ITERATE', planRevision: 2, architectVerdict: 'ITERATE', auditorVerdict: 'APPROVE', nextRevision: 3 });
  assert.equal(plan.policy.rule, 'planning.planner-only-revision');
  assert.deepEqual(plan.reasonCodes, ['CONSENSUS_ITERATE', 'PLANNER_ONLY_REVISION']);
  assert.deepEqual(plan.intendedAction, { type: 'spawn', role: 'planner', nextRevision: 3 });
  for (const [description, code] of [['authentication authorization', 'SECURITY_AUTHORIZATION_CHANGE'], ['file upload', 'SECURITY_FILE_UPLOAD'], ['trust boundary', 'SECURITY_TRUST_BOUNDARY'], ['secret handling', 'SECURITY_SECRET_HANDLING'], ['payment', 'SECURITY_PAYMENT'], ['command injection', 'SECURITY_INJECTION']]) {
    const assessment = assessSecurityReview({ description });
    assert.ok(assessment.reasonCodes.includes(code));
    assert.equal(assessment.reasonCodes.length, new Set(assessment.reasonCodes).size);
  }
  assert.ok(assessSecurityReview({ securityRelevant: true }).reasonCodes.includes('SECURITY_EXPLICIT'));
  assert.equal(prepared.decisionTrace.find(d => d.stage === 'classification').policy.rule, 'classification.tier');
  assert.ok(prepared.decisionTrace.some(d => d.policy.rule === 'review.security-activation'));
  assert.ok(prepared.decisionTrace.some(d => d.policy.rule === 'planning.council-required'));
});
