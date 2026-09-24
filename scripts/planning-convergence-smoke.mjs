#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  buildPlanAcceptanceCoverage,
  createConsensusState,
  recordConsensusReview,
  validatePlan,
} from '../core/planning/index.mjs';
import { installProject } from './install-project.mjs';
import { runCodexExec } from './runtime-smoke.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);

export const CONVERGENCE_CRITERIA = Object.freeze([
  'behaviorA() returns "A-v2" and node --test tests/behavior-a.test.js passes.',
  'behaviorB() returns "B-v2" and node --test tests/behavior-b.test.js passes.',
  'ops/rollback.sh <target-dir> restores the target copies of both behavior modules to their baseline exports, and node --test tests/rollback.test.js proves this in an isolated temporary target without changing the repository\'s v2 source state.',
]);

const DRAFT_V1 = Object.freeze({
  tasks: [
    {
      id: 'behavior-a',
      goal: 'Change behaviorA() from A-v1 to A-v2 and update its focused test.',
      files_modified: ['src/behavior-a.js', 'tests/behavior-a.test.js'],
      depends_on: [],
      acceptance_criteria: [CONVERGENCE_CRITERIA[0]],
      verify: 'node --test tests/behavior-a.test.js',
      owner: 'implementer',
    },
    {
      id: 'behavior-b',
      goal: 'Change behaviorB() from B-v1 to B-v2 and update its focused test.',
      files_modified: ['src/behavior-b.js', 'tests/behavior-b.test.js'],
      depends_on: [],
      acceptance_criteria: [CONVERGENCE_CRITERIA[1]],
      verify: 'node --test tests/behavior-b.test.js',
      owner: 'implementer',
    },
  ],
});

export function preflightPlanningConvergence() {
  const plan = validatePlan(DRAFT_V1);
  const coverage = buildPlanAcceptanceCoverage(plan, CONVERGENCE_CRITERIA);
  assert.equal(coverage.pass, false);
  assert.equal(coverage.missing.length, 1);
  assert.equal(coverage.missing[0].criterion, CONVERGENCE_CRITERIA[2]);

  const state = createConsensusState({ tier: 2, enabled: true, plan });
  assert.equal(state.policy.maxIterations, 3);
  assert.equal(state.status, 'planning');

  return {
    case: 'F',
    title: 'authenticated planning consensus convergence',
    initialCoverage: coverage,
    consensusPolicy: state.policy,
  };
}

export async function runAuthenticatedPlanningConvergenceSmoke(options = {}) {
  const preflight = preflightPlanningConvergence();
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const doctor = await doctorStatus(codexBin);
  if (doctor.authStatus !== 'ok') {
    return {
      status: 'runtime-validation-pending',
      case: 'F',
      reason: doctor.summary || 'Codex credentials are not ready',
      preflight,
    };
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-plan-smoke-main-'));
  const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-plan-smoke-evidence-'));
  await execFileAsync('git', ['init', '-q', workspace]);
  await execFileAsync('git', ['config', 'user.name', 'Hybrid Runtime Smoke'], { cwd: workspace });
  await execFileAsync('git', ['config', 'user.email', 'hybrid-smoke@example.invalid'], { cwd: workspace });
  await installProject(workspace, { skipCodexValidation: true });
  await seedFixture(workspace);
  await commitAll(workspace, 'planning convergence fixture');

  let consensus = createConsensusState({ tier: 2, enabled: true, plan: DRAFT_V1 });
  let caught = null;
  const report = {
    schema: 'hybrid-planning-convergence-smoke/v1',
    case: 'F',
    workspace,
    evidenceRoot,
    preflight,
    revisions: [],
    reviewRounds: [],
    consensusTransitions: [],
    finalState: null,
    finalGitStatus: null,
    runtimeError: null,
  };

  try {
    const maxIterations = consensus.policy.maxIterations;
    let revision = 1;
    let plannerRun = await runPlannerV1({
      codexBin,
      workspace,
      evidenceRoot,
      timeoutMs: options.plannerTimeoutMs || 180000,
    });
    let plan = validatePlan(plannerRun.output.plan);
    let sourceReviews = null;

    while (revision <= maxIterations) {
      const coverage = buildPlanAcceptanceCoverage(plan, CONVERGENCE_CRITERIA);
      if (revision === 1 && (coverage.pass || coverage.missing.length !== 1)) {
        throw new Error('revision 1 fixture no longer contains the intended material acceptance gap');
      }

      const relativePlanPath = '.planning/convergence/PLAN-v' + revision + '.json';
      const planPath = path.join(workspace, relativePlanPath);
      await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
      await commitAll(workspace, 'planning smoke revision ' + revision);
      const planHash = await hashFile(planPath);

      report.revisions.push({
        revision,
        planHash,
        path: relativePlanPath,
        planner: summarizeRun(plannerRun),
        coverage,
        addressed: revision > 1 ? plannerRun.output.addressed || [] : [],
        sourceReviewHashes: sourceReviews
          ? [hashJson(sourceReviews.architect), hashJson(sourceReviews.auditor)]
          : [],
      });

      const beforeReview = await gitStatus(workspace);
      const [architect, auditor] = await Promise.all([
        runReviewer({
          codexBin,
          workspace,
          evidenceRoot,
          role: 'architect',
          revision,
          planHash,
          planPath: relativePlanPath,
          timeoutMs: options.reviewTimeoutMs || 180000,
        }),
        runReviewer({
          codexBin,
          workspace,
          evidenceRoot,
          role: 'plan-auditor',
          revision,
          planHash,
          planPath: relativePlanPath,
          timeoutMs: options.reviewTimeoutMs || 180000,
        }),
      ]);
      const afterReview = await gitStatus(workspace);
      if (beforeReview !== afterReview) {
        throw new Error('read-only revision-' + revision + ' reviewer mutated the repository');
      }

      assertReviewSnapshot(architect.output, 'architect', revision, planHash);
      assertReviewSnapshot(auditor.output, 'plan-auditor', revision, planHash);

      const findings = materialFindings([architect.output, auditor.output]);
      const architectVerdict = String(architect.output.verdict || '').toUpperCase();
      const auditorVerdict = String(auditor.output.verdict || '').toUpperCase();

      if (revision === 1) {
        if (!findings.length) {
          throw new Error('revision 1 reviewers did not independently surface the real material gap');
        }
        if (architectVerdict === 'APPROVE' && auditorVerdict === 'APPROVE') {
          throw new Error('revision 1 council incorrectly approved a plan with a deterministic acceptance gap');
        }
      }

      if (!coverage.pass && architectVerdict === 'APPROVE' && auditorVerdict === 'APPROVE') {
        throw new Error('council approved revision ' + revision + ' despite deterministic SPEC coverage failure');
      }

      report.reviewRounds.push({
        revision,
        planHash,
        sameSnapshot: true,
        independent: true,
        overlapObserved: intervalsOverlap([architect, auditor]),
        repositoryStatusBefore: beforeReview,
        repositoryStatusAfter: afterReview,
        architect: { ...architect.output, runtime: summarizeRun(architect) },
        auditor: { ...auditor.output, runtime: summarizeRun(auditor) },
        materialFindings: findings,
      });

      await fs.writeFile(
        path.join(evidenceRoot, 'review-round-' + revision + '.json'),
        JSON.stringify(report.reviewRounds.at(-1), null, 2) + '\n'
      );

      consensus = recordConsensusReview(consensus, {
        plan,
        planRevision: revision,
        architect: normalizeConsensusReview(architect.output),
        auditor: normalizeConsensusReview(auditor.output),
      });
      report.consensusTransitions.push(snapshotConsensus(consensus));

      if (consensus.status === 'pending-user-approval') break;
      if (consensus.status === 'consensus-not-reached') break;
      if (consensus.status !== 'revision-required') {
        throw new Error('unexpected consensus status after revision ' + revision + ': ' + consensus.status);
      }
      if (revision >= maxIterations) break;

      sourceReviews = {
        architect: architect.output,
        auditor: auditor.output,
      };
      revision += 1;
      plannerRun = await runPlannerRevision({
        codexBin,
        workspace,
        evidenceRoot,
        revision,
        previousPlan: plan,
        architect: sourceReviews.architect,
        auditor: sourceReviews.auditor,
        timeoutMs: options.plannerTimeoutMs || 180000,
      });
      plan = validatePlan(plannerRun.output.plan);
    }

    report.finalState = snapshotConsensus(consensus);
    report.finalGitStatus = await gitStatus(workspace);

    if (consensus.status !== 'pending-user-approval') {
      throw new Error(
        'planning convergence did not reach council approval within ' +
          consensus.policy.maxIterations +
          ' iterations'
      );
    }
  } catch (error) {
    caught = error;
    report.runtimeError = {
      message: String(error.message || error),
      code: error.code || null,
    };
    report.finalState = snapshotConsensus(consensus);
    report.finalGitStatus = await gitStatus(workspace).catch(() => null);
  }

  const semantic = validatePlanningConvergenceReport(report);
  const reportPath = path.join(evidenceRoot, 'planning-convergence-report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');

  return {
    status: semantic.ok && !caught ? 'completed' : 'failed',
    case: 'F',
    workspace,
    evidenceRoot,
    reportPath,
    semantic,
    report,
    ...(caught ? { error: String(caught.message || caught) } : {}),
  };
}

export function validatePlanningConvergenceReport(report) {
  const errors = [];
  const revisions = Array.isArray(report?.revisions) ? [...report.revisions] : [];
  const rounds = Array.isArray(report?.reviewRounds) ? [...report.reviewRounds] : [];
  const maxIterations = Number(report?.preflight?.consensusPolicy?.maxIterations || 3);

  revisions.sort((a, b) => Number(a.revision) - Number(b.revision));
  rounds.sort((a, b) => Number(a.revision) - Number(b.revision));

  if (!revisions.length) {
    errors.push('planner revision 1 missing');
  }
  if (revisions.length > maxIterations) {
    errors.push('planning revisions exceeded consensus maxIterations');
  }

  for (let i = 0; i < revisions.length; i++) {
    const expectedRevision = i + 1;
    if (Number(revisions[i].revision) !== expectedRevision) {
      errors.push('planning revisions are not contiguous at revision ' + expectedRevision);
    }
  }

  const firstRevision = revisions[0];
  if (
    firstRevision &&
    (firstRevision.coverage?.pass !== false || firstRevision.coverage?.missing?.length < 1)
  ) {
    errors.push('revision 1 does not contain a real deterministic acceptance gap');
  }

  for (const revision of revisions) {
    const number = Number(revision.revision);
    const round = rounds.find((item) => Number(item.revision) === number);
    validateRound(round, number, revision.planHash, errors);

    if (number > 1) {
      if (!Array.isArray(revision.addressed) || revision.addressed.length === 0) {
        errors.push('revision ' + number + ' does not record addressed reviewer findings');
      }
      if (!Array.isArray(revision.sourceReviewHashes) || revision.sourceReviewHashes.length !== 2) {
        errors.push('revision ' + number + ' does not bind to both source reviews');
      }
    }
  }

  const firstRound = rounds.find((item) => Number(item.revision) === 1);
  if (firstRound) {
    const verdicts = [
      String(firstRound.architect?.verdict || '').toUpperCase(),
      String(firstRound.auditor?.verdict || '').toUpperCase(),
    ];
    if (verdicts.every((verdict) => verdict === 'APPROVE')) {
      errors.push('revision 1 was approved despite the real material gap');
    }
    if (!Array.isArray(firstRound.materialFindings) || !firstRound.materialFindings.length) {
      errors.push('revision 1 has no material reviewer objection');
    }
  }

  const finalRevision = revisions.at(-1);
  const finalRound = rounds.find(
    (item) => Number(item.revision) === Number(finalRevision?.revision)
  );

  if (!finalRevision || Number(finalRevision.revision) < 2) {
    errors.push('no revised plan was produced after the rejected initial plan');
  } else if (finalRevision.coverage?.pass !== true) {
    errors.push('final revision does not close SPEC acceptance coverage');
  }

  if (finalRound) {
    if (String(finalRound.architect?.verdict || '').toUpperCase() !== 'APPROVE') {
      errors.push('final architect approval missing');
    }
    if (String(finalRound.auditor?.verdict || '').toUpperCase() !== 'APPROVE') {
      errors.push('final auditor approval missing');
    }
  }

  for (const round of rounds) {
    if (finalRound && Number(round.revision) === Number(finalRound.revision)) continue;
    const verdicts = [
      String(round.architect?.verdict || '').toUpperCase(),
      String(round.auditor?.verdict || '').toUpperCase(),
    ];
    if (verdicts.every((verdict) => verdict === 'APPROVE')) {
      errors.push('non-final revision ' + round.revision + ' was fully approved');
    }
  }

  if (rounds.length !== revisions.length) {
    errors.push('planner revision count and review round count differ');
  }
  if ((report.consensusTransitions || []).length !== rounds.length) {
    errors.push('consensus transition count does not match review rounds');
  }

  if (report.finalState?.status !== 'pending-user-approval') {
    errors.push('final consensus state is not pending-user-approval');
  }
  if (report.finalState?.approved !== true) {
    errors.push('final consensus is not approved');
  }
  if (report.finalState?.executionApproved !== false) {
    errors.push('executionApproved must remain false');
  }
  if (report.finalGitStatus !== '') {
    errors.push('review/planning smoke repository is not clean at final state');
  }
  if (report.runtimeError) {
    errors.push('runtime error: ' + report.runtimeError.message);
  }

  return { ok: errors.length === 0, errors };
}

function validateRound(round, revision, planHash, errors) {
  if (!round) {
    errors.push('review round ' + revision + ' missing');
    return;
  }
  if (round.sameSnapshot !== true) errors.push('review round ' + revision + ' did not use one fixed snapshot');
  if (round.independent !== true) errors.push('review round ' + revision + ' was not independent');
  if (round.overlapObserved !== true) errors.push('review round ' + revision + ' reviewers did not overlap');
  if (round.repositoryStatusBefore !== round.repositoryStatusAfter) {
    errors.push('reviewers mutated repository in round ' + revision);
  }
  for (const [role, review] of [['architect', round.architect], ['plan-auditor', round.auditor]]) {
    if (!review) {
      errors.push(role + ' review missing for revision ' + revision);
      continue;
    }
    if (Number(review.revision) !== revision) errors.push(role + ' reviewed wrong revision');
    if (review.planHash !== planHash) errors.push(role + ' reviewed wrong plan hash');
    if (review.planModified !== false) errors.push(role + ' claims plan modification');
    if (review.runtime?.exitCode !== 0 || review.runtime?.timedOut) {
      errors.push(role + ' runtime did not complete for revision ' + revision);
    }
  }
}

async function runPlannerV1({ codexBin, workspace, evidenceRoot, timeoutMs }) {
  const prompt = [
    'Act as the Hybrid Planner for revision 1 only. Do not spawn or delegate.',
    'Read .planning/convergence/SPEC.md and .planning/convergence/DRAFT-PLAN-v1.json.',
    'This first pass is fixture canonicalization, not the independent audit: preserve the draft task set and its existing acceptance mappings exactly. Do not silently add new scope in revision 1.',
    'Do not modify files. Return exactly one JSON object and no markdown.',
    'Required shape:',
    JSON.stringify({
      role: 'planner',
      revision: 1,
      source: '.planning/convergence/DRAFT-PLAN-v1.json',
      plan: DRAFT_V1,
      notes: ['short factual note'],
    }),
  ].join('\n');

  return runJsonRole({
    codexBin,
    workspace,
    evidenceRoot,
    id: 'planner-v1',
    model: 'gpt-6-luna',
    effort: 'high',
    sandbox: 'read-only',
    prompt,
    timeoutMs,
  });
}

async function runPlannerRevision({
  codexBin,
  workspace,
  evidenceRoot,
  revision,
  previousPlan,
  architect,
  auditor,
  timeoutMs,
}) {
  const previousRevision = revision - 1;
  const prompt = [
    'Act as the Hybrid Planner revising a rejected/iterated plan. Do not spawn or delegate.',
    'Read .planning/convergence/SPEC.md. The exact previous plan and two independent reviews are supplied below.',
    'Only you may synthesize both reviews into revision ' + revision + '. Do not alter or reinterpret reviewer verdicts.',
    'Address every material reviewer finding, including exact-file ownership, verification side effects, rollback/recovery behavior, and consistency of the final planned state.',
    'Produce a complete executable plan that maps every SPEC acceptance criterion to at least one task.',
    'For traceability, copy each mapped SPEC acceptance criterion verbatim as one acceptance_criteria string; do not split, paraphrase, shorten, or normalize it.',
    'The exact SPEC criteria are: ' + JSON.stringify(CONVERGENCE_CRITERIA),
    'Use the canonical task schema exactly: id, goal, files_modified, depends_on, acceptance_criteria, verify, owner. Do not rename depends_on to dependencies and do not rename verify to automated_verify.',
    'Every task must include depends_on as an array and verify as a non-empty automated command string.',
    'Verification of rollback/recovery must be isolated when destructive verification would otherwise invalidate the intended final source state.',
    'Do not modify files. Return exactly one JSON object and no markdown.',
    'PREVIOUS_PLAN=' + JSON.stringify(previousPlan),
    'ARCHITECT_REVIEW=' + JSON.stringify(architect),
    'AUDITOR_REVIEW=' + JSON.stringify(auditor),
    'Required shape: {"role":"planner","revision":' + revision +
      ',"plan":{"tasks":[...]},"addressed":["concrete finding addressed", "..."],' +
      '"sourceRevisions":[' + previousRevision + ']}',
  ].join('\n');

  return runJsonRole({
    codexBin,
    workspace,
    evidenceRoot,
    id: 'planner-v' + revision,
    model: 'gpt-6-luna',
    effort: 'high',
    sandbox: 'read-only',
    prompt,
    timeoutMs,
  });
}

async function runReviewer({
  codexBin,
  workspace,
  evidenceRoot,
  role,
  revision,
  planHash,
  planPath,
  timeoutMs,
}) {
  const roleContract = role === 'architect'
    ? [
        'Act as the Hybrid Architect. Review architecture boundaries, data/control flow, migration/rollback risk, operability, and maintainability.',
        'Ground material objections in SPEC/PLAN/repository evidence. Do not manufacture objections when the plan is sound.',
      ]
    : [
        'Act as the Hybrid Plan Auditor. Check SPEC acceptance coverage, hidden assumptions, dependencies, exact files, ownership, testability, rollback/recovery risk, missing edge cases, and verification.',
        'Style preferences are not blocking findings.',
      ];

  const prompt = [
    ...roleContract,
    'You are independently reviewing one immutable plan snapshot. You have not received and must not seek the other reviewer output.',
    'Read .planning/convergence/SPEC.md and ' + planPath + '.',
    'Expected SHA256 of the exact committed plan file bytes: ' + planHash,
    'Do not modify any file. Do not spawn or delegate.',
    'Return exactly one JSON object and no markdown.',
    'Required shape: {"role":' + JSON.stringify(role) + ',"revision":' + revision +
      ',"planHash":' + JSON.stringify(planHash) +
      ',"verdict":"APPROVE|ITERATE|REJECT","planModified":false,' +
      '"findings":[{"severity":"major|minor","code":"short-code","evidence":"SPEC/PLAN evidence","impact":"impact"}],' +
      '"objections":["short material objection strings"]}',
  ].join('\n');

  return runJsonRole({
    codexBin,
    workspace,
    evidenceRoot,
    id: role.replace(/-/g, '_') + '-v' + revision,
    model: 'gpt-6-luna',
    effort: 'xhigh',
    sandbox: 'read-only',
    prompt,
    timeoutMs,
  });
}

async function runJsonRole({
  codexBin,
  workspace,
  evidenceRoot,
  id,
  model,
  effort,
  sandbox,
  prompt,
  timeoutMs,
}) {
  const eventsPath = path.join(evidenceRoot, id + '.events.jsonl');
  const stderrPath = path.join(evidenceRoot, id + '.stderr.log');
  const startedAt = Date.now();

  const run = await runCodexExec(codexBin, [
    'exec',
    '--strict-config',
    '--json',
    '--sandbox',
    sandbox,
    '--cd',
    workspace,
    '-m',
    model,
    '-c',
    'model_reasoning_effort=' + JSON.stringify(effort),
    prompt,
  ], { cwd: workspace, timeoutMs });

  const endedAt = Date.now();
  await fs.writeFile(eventsPath, run.stdout || '', 'utf8');
  await fs.writeFile(stderrPath, run.stderr || '', 'utf8');

  if (run.code !== 0 || run.timedOut) {
    throw new Error(id + ' Codex process failed');
  }
  if (hasDelegationToolEvent(run.stdout)) {
    throw new Error(id + ' attempted recursive delegation');
  }

  const message = lastAgentMessage(run.stdout);
  const output = parseJsonMessage(message);
  return {
    id,
    startedAt,
    endedAt,
    exitCode: run.code,
    timedOut: run.timedOut === true,
    requestedModel: model,
    reasoningEffort: effort,
    delegationObserved: false,
    eventsPath,
    stderrPath,
    output,
  };
}

function assertReviewSnapshot(review, expectedRole, revision, planHash) {
  if (normalizeRole(review.role) !== expectedRole) {
    throw new Error('review role mismatch: expected ' + expectedRole);
  }
  if (Number(review.revision) !== revision) {
    throw new Error(expectedRole + ' reviewed wrong revision');
  }
  if (review.planHash !== planHash) {
    throw new Error(expectedRole + ' reviewed wrong plan hash');
  }
  if (review.planModified !== false) {
    throw new Error(expectedRole + ' violated read-only review invariant');
  }
  const verdict = String(review.verdict || '').toUpperCase();
  if (!['APPROVE', 'ITERATE', 'REJECT'].includes(verdict)) {
    throw new Error(expectedRole + ' returned invalid verdict');
  }
}

function normalizeConsensusReview(review) {
  return {
    verdict: String(review.verdict || '').toUpperCase(),
    findings: (review.findings || []).map(findingText),
    objections: (review.objections || []).map(String),
  };
}

function findingText(finding) {
  if (typeof finding === 'string') return finding;
  return [
    finding?.severity,
    finding?.code,
    finding?.evidence,
    finding?.impact,
  ].filter(Boolean).join(': ');
}

function materialFindings(reviews) {
  const out = [];
  for (const review of reviews) {
    for (const finding of review.findings || []) {
      const text = findingText(finding);
      const severity = typeof finding === 'object' ? String(finding.severity || '') : '';
      if (/major|block|high|critical/i.test(severity) || /rollback|acceptance|recover/i.test(text)) {
        out.push(text);
      }
    }
    for (const objection of review.objections || []) {
      const text = String(objection);
      if (/rollback|acceptance|recover|missing/i.test(text)) out.push(text);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function snapshotConsensus(state) {
  return {
    iteration: state?.iteration ?? null,
    status: state?.status ?? null,
    approved: state?.approved === true,
    executionApproved: state?.executionApproved === true,
    remainingObjections: state?.remainingObjections || [],
  };
}

function summarizeRun(run) {
  return {
    id: run.id,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    requestedModel: run.requestedModel,
    reasoningEffort: run.reasoningEffort,
    delegationObserved: run.delegationObserved,
    eventsPath: run.eventsPath,
  };
}

function intervalsOverlap(runs) {
  if (!Array.isArray(runs) || runs.length < 2) return false;
  return Math.max(...runs.map((run) => run.startedAt)) < Math.min(...runs.map((run) => run.endedAt));
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function hashFile(target) {
  return createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

function lastAgentMessage(stdout) {
  let last = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event?.type === 'item.completed' &&
        event?.item?.type === 'agent_message' &&
        typeof event.item.text === 'string'
      ) {
        last = event.item.text;
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  if (!last) throw new Error('Codex role returned no final agent_message');
  return last;
}

function parseJsonMessage(message) {
  const source = String(message || '').trim();
  const fenced = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(source);
  const candidate = fenced ? fenced[1] : source;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(candidate.slice(first, last + 1));
    }
    throw new Error('agent_message did not contain parseable JSON');
  }
}

function hasDelegationToolEvent(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (objectContainsDelegationTool(JSON.parse(line))) return true;
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return false;
}

function objectContainsDelegationTool(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(objectContainsDelegationTool);
  for (const [key, child] of Object.entries(value)) {
    if (
      ['name', 'tool', 'tool_name', 'toolName'].includes(key) &&
      typeof child === 'string' &&
      /(?:^|\.)spawn_agent$/i.test(child)
    ) return true;
    if (objectContainsDelegationTool(child)) return true;
  }
  return false;
}

function normalizeRole(value) {
  return String(value || '').replace(/^hybrid[-_]/, '').replace(/_/g, '-').toLowerCase();
}

async function seedFixture(workspace) {
  const dir = path.join(workspace, '.planning', 'convergence');
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'tests'), { recursive: true });

  const spec = [
    '# SPEC — Planning convergence fixture',
    '',
    'Goal: move two independent behavior modules from v1 to v2 while preserving an explicit, automated rollback path.',
    '',
    '## Current repository contract',
    '',
    '- src/behavior-a.js exports behaviorA() and currently returns "A-v1".',
    '- src/behavior-b.js exports behaviorB() and currently returns "B-v1".',
    '- tests/behavior-a.test.js and tests/behavior-b.test.js are focused tests that must be updated with their modules.',
    '- The rollback implementation target is ops/rollback.sh and its focused verification target is tests/rollback.test.js.',
    '- ops/rollback.sh accepts a target-directory argument; rollback verification must run against an isolated temporary target and leave repository src/behavior-a.js and src/behavior-b.js at v2.',
    '- Behavior A and Behavior B are independent; no sequencing dependency is required.',
    '',
    '## Acceptance Criteria',
    '',
    ...CONVERGENCE_CRITERIA.map((criterion) => '- ' + criterion),
    '',
    '## Constraints',
    '',
    '- Planner owns plan revision.',
    '- Architect and Plan Auditor review the same immutable revision independently.',
    '- Reviewers must not modify the plan.',
    '- Every acceptance criterion must map to a task with exact files and an automated verify command.',
    '- Execution is not approved by this smoke.',
    '',
  ].join('\n');

  await fs.writeFile(path.join(dir, 'SPEC.md'), spec);
  await fs.writeFile(path.join(dir, 'DRAFT-PLAN-v1.json'), JSON.stringify(DRAFT_V1, null, 2) + '\n');
  await fs.writeFile(
    path.join(workspace, 'src', 'behavior-a.js'),
    'export function behaviorA() { return "A-v1"; }\n'
  );
  await fs.writeFile(
    path.join(workspace, 'src', 'behavior-b.js'),
    'export function behaviorB() { return "B-v1"; }\n'
  );
  await fs.writeFile(
    path.join(workspace, 'tests', 'behavior-a.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { behaviorA } from '../src/behavior-a.js';",
      "test('baseline behavior A', () => assert.equal(behaviorA(), 'A-v1'));",
      '',
    ].join('\n')
  );
  await fs.writeFile(
    path.join(workspace, 'tests', 'behavior-b.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { behaviorB } from '../src/behavior-b.js';",
      "test('baseline behavior B', () => assert.equal(behaviorB(), 'B-v1'));",
      '',
    ].join('\n')
  );
}

async function commitAll(workspace, message) {
  await execFileAsync('git', ['add', '.'], { cwd: workspace });
  await execFileAsync('git', ['commit', '-qm', message], { cwd: workspace });
}

async function gitStatus(workspace) {
  return (await execFileAsync('git', ['status', '--porcelain'], { cwd: workspace })).stdout.trim();
}

async function doctorStatus(codexBin) {
  try {
    const { stdout } = await execFileAsync(codexBin, ['doctor', '--json'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    const auth = report.checks?.['auth.credentials'];
    return {
      authStatus: auth?.status || 'unknown',
      summary: auth?.summary || '',
    };
  } catch (error) {
    return {
      authStatus: error.code === 'ENOENT' ? 'missing-cli' : 'unknown',
      summary: String(error.stderr || error.message || error),
    };
  }
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath);
}

if (isMainModule()) {
  if (process.argv.includes('--preflight')) {
    console.log(JSON.stringify(preflightPlanningConvergence(), null, 2));
  } else {
    const result = await runAuthenticatedPlanningConvergenceSmoke();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'runtime-validation-pending') process.exitCode = 2;
    else if (result.status !== 'completed') process.exitCode = 1;
  }
}
