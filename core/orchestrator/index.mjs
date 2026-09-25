import { buildDecision, createDecisionWriter } from '../provenance/index.mjs';
export { runQualityClosure } from './quality-closure.mjs';
import { classifyTask, TaskTier } from '../classifier/index.mjs';
import { evaluateRequirements } from '../requirements/index.mjs';
import { buildExecutionWaves, planExecutionIsolation, findFileConflicts } from '../scheduler/index.mjs';
import { resolveRoleRouting, MODEL_ROUTING_POLICY } from '../routing/index.mjs';
import { assessSecurityReview } from '../verification/index.mjs';

const ROUTABLE_STAGES = new Set([
  'scout',
  'requirements-gate',
  'researcher',
  'planner',
  'architect',
  'plan-auditor',
  'implementer',
  'tester',
  'code-reviewer',
  'security-reviewer',
  'verifier',
  'knowledge-synthesizer',
]);

export function derivePipeline({
  classification,
  securityReview = false,
  needs = {},
}) {
  const tier = classification.tier;
  const stages = [];

  if (tier === TaskTier.TRIVIAL) {
    stages.push('implementer');
    if (needs.tester) stages.push('tester');
    else stages.push('lightweight-verify');
    if (securityReview) stages.push('security-reviewer');
    if (needs.knowledge) stages.push('knowledge-synthesizer', 'wiki-lint');
    return stages;
  }

  if (tier === TaskTier.BOUNDED) {
    if (needs.scout) stages.push('scout');
    if (needs.research) stages.push('researcher');
    if (needs.planning) stages.push('planner');
    if (needs.scheduler) stages.push('scheduler');
    stages.push('implementer');
    if (needs.tester) stages.push('tester');
    if (needs.review) stages.push('code-reviewer');
    if (securityReview) stages.push('security-reviewer');
    stages.push('verifier');
    if (needs.knowledge) stages.push('knowledge-synthesizer', 'wiki-lint');
    return stages;
  }

  // Complex and ambiguous work retain the full durable-spec and quality path,
  // with expensive research/council/knowledge steps still conditional where
  // they do not contribute to the actual task.
  stages.push('scout');

  if (tier === TaskTier.AMBIGUOUS) {
    stages.push('requirements-gate', 'user-approval');
  } else {
    stages.push('spec-lite', 'user-approval');
  }

  if (needs.research) stages.push('researcher');
  stages.push('planner');

  if (tier === TaskTier.AMBIGUOUS || needs.council) {
    stages.push('architect', 'plan-auditor');
  }

  stages.push('scheduler', 'implementer', 'tester', 'code-reviewer');
  if (securityReview) stages.push('security-reviewer');
  stages.push('verifier', 'integrate', 'full-test');

  if (needs.knowledge) stages.push('knowledge-synthesizer', 'wiki-lint');

  return stages;
}

export function prepareExecution(input) {
  const classification = classifyTask(input.task || input.request || input);
  const requirements = input.spec
    ? evaluateRequirements(input.spec, {
        type: input.projectType || input.spec.type,
        requireTopology: classification.tier === TaskTier.AMBIGUOUS,
      })
    : null;

  const securityAssessment = assessSecurityReview({
    description: input.request || input.task?.request || '',
    files: (input.tasks || []).flatMap((task) => task.files_modified || []),
    tags: input.securityTags || [],
    securityRelevant: input.securityRelevant,
  });

  const securityReview = securityAssessment.required;
  const baseWaves = input.tasks ? buildExecutionWaves(input.tasks) : [];
  const isolationPlan = planExecutionIsolation(baseWaves, {
    worktreeAvailable: input.worktreeAvailable,
    forceWorktree: input.forceWorktree === true,
    fileOwnershipConfidence: input.fileOwnershipConfidence,
  });

  const routingContext = deriveRoutingContext(
    input,
    classification,
    requirements,
    securityReview
  );
  const needs = derivePipelineNeeds(input, classification, securityReview, routingContext);
  const pipeline = derivePipeline({ classification, securityReview, needs });
  const modelRouting = buildModelRouting(pipeline, routingContext, input.modelRouting || {});

  return {
    decisionTrace: executionDecisions(input, { classification, pipeline, isolationPlan, modelRouting, securityAssessment }),
    classification,
    requirements,
    securityReview,
    needs,
    pipeline,
    waves: isolationPlan.waves,
    isolationPlan,
    routingContext,
    modelRouting,
    blocked:
      classification.tier === TaskTier.AMBIGUOUS &&
      requirements !== null &&
      requirements.pass === false,
  };
}


export async function prepareExecutionWithProvenance(input = {}, options = {}) {
  const runId = options.runId || input.runId || 'execution';
  const prepared = prepareExecution({ ...input, runId });
  const writer = options.decisionWriter || createDecisionWriter({
    role: 'lead',
    runId,
    repoRoot: options.repoRoot || input.repoRoot || '.',
    runtimeRoot: options.runtimeRoot,
    strict: options.strict === true,
  });
  let count = 0;
  let error = null;
  for (const record of prepared.decisionTrace) {
    try {
      const result = await writer(record);
      if (result?.ok === false) {
        error ||= result.error || 'decision persistence failed';
      } else {
        count += 1;
      }
    } catch (cause) {
      if (options.strict === true) throw cause;
      error ||= String(cause?.message || cause);
    }
  }
  return {
    ...prepared,
    provenance: {
      persisted: count === prepared.decisionTrace.length,
      count,
      error,
    },
  };
}

export function derivePipelineNeeds(input, classification, securityReview, routingContext = {}) {
  const tier = classification.tier;
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const evidence = classification.evidence || {};
  const hasDependencies = tasks.some((item) => (item.depends_on || []).length > 0);
  const acceptance = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria
    : Array.isArray(task.acceptance_criteria)
      ? task.acceptance_criteria
      : [];

  const architectureKnowledge =
    routingContext.architecturalChange === true ||
    input.environmentChanged === true ||
    input.setupChanged === true ||
    input.newDurablePattern === true ||
    input.importantDebuggingKnowledge === true ||
    input.newTestingConvention === true;

  return {
    scout:
      input.needsScout === true ||
      tier >= TaskTier.COMPLEX ||
      (tier === TaskTier.BOUNDED && Number(evidence.fileAnchors || 0) === 0),
    research:
      input.needsResearch === true ||
      input.externalResearch === true ||
      (tier === TaskTier.AMBIGUOUS && input.needsResearch !== false),
    planning:
      input.needsPlanning === true ||
      (tier === TaskTier.BOUNDED && (tasks.length > 1 || hasDependencies)),
    scheduler: tasks.length > 1,
    tester:
      input.needsTester === true ||
      input.newBehavior === true ||
      input.testSurfaceChanged === true ||
      securityReview === true ||
      (tier >= TaskTier.COMPLEX) ||
      (tier === TaskTier.BOUNDED && input.acceptanceRequiresTest === true && acceptance.length > 0),
    review:
      input.needsReview === true ||
      input.meaningfulLogicChange === true ||
      securityReview === true ||
      tier >= TaskTier.COMPLEX,
    council:
      input.needsCouncil === true ||
      routingContext.architecturalChange === true ||
      routingContext.importantArchitecturalDecision === true ||
      routingContext.securitySensitive === true ||
      routingContext.criticalPlanRisk === true,
    knowledge:
      input.durableKnowledgeChange === true ||
      architectureKnowledge,
  };
}

export function deriveRoutingContext(input, classification, requirements, securityReview) {
  const request = String(input.request || input.task?.request || '');
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const components = Array.isArray(task.components) ? task.components : [];

  return {
    classification: classification.name,
    ambiguity: requirements?.ambiguity ?? (classification.tier === TaskTier.AMBIGUOUS ? 1 : 0),
    highAmbiguity:
      input.highAmbiguity === true ||
      classification.tier === TaskTier.AMBIGUOUS ||
      Number(requirements?.ambiguity || 0) > 0.20,
    architecturalChange:
      input.architecturalChange === true ||
      task.architecturalDecision === true ||
      /\barchitecture\b|\barchitectural\b|\bmigration\b|\bframework\b|\bcross[- ]module\s+refactor\b|아키텍처|마이그레이션|프레임워크|대규모\s*리팩터/i.test(request),
    largeRefactor:
      input.largeRefactor === true ||
      /\b(?:large|major|large-scale|cross-module)\s+refactor\b|대규모\s*리팩터/i.test(request),
    securitySensitive: securityReview === true,
    verificationFailures: Number(input.verificationFailures || 0),
    complexDebugging:
      input.complexDebugging === true ||
      (
        /\b(?:debug|debugging|deadlock|race condition|flaky|integration bug)\b|디버깅|교착|경쟁\s*조건/i.test(request) &&
        (input.crossModuleDebugging === true || components.length > 1)
      ),
    crossModuleDebugging: input.crossModuleDebugging === true,
    difficultReview: input.difficultReview === true,
    importantArchitecturalDecision: input.importantArchitecturalDecision === true,
    moderateImplementation:
      input.moderateImplementation === true || input.taskDifficulty === 'moderate',
    hardImplementation:
      input.hardImplementation === true || input.taskDifficulty === 'hard',
    veryHardImplementation:
      input.veryHardImplementation === true || input.taskDifficulty === 'very-hard',
    hardVerification: input.hardVerification === true,
    hardResearch: input.hardResearch === true,
    complexSecurityReasoning: input.complexSecurityReasoning === true,
    exploitReasoning: input.exploitReasoning === true,
    complexTrustBoundary: input.complexTrustBoundary === true,
    criticalSecurityJudgment: input.criticalSecurityJudgment === true,
    unresolvedSecurityRisk: input.unresolvedSecurityRisk === true,
    unresolvedArchitecture: input.unresolvedArchitecture === true,
    criticalPlanRisk: input.criticalPlanRisk === true,
    exceptionallyDifficult: input.exceptionallyDifficult === true,
    lunaExhausted: input.lunaExhausted === true,
    lunaMaxFailed: input.lunaMaxFailed === true,
    repeatedSameFailure: input.repeatedSameFailure === true,
    criticalUnresolved: input.criticalUnresolved === true,
    extremeUnresolved: input.extremeUnresolved === true,
  };
}

export function buildModelRouting(pipeline, context, routingOptions = {}) {
  const stages = [];

  for (const stage of pipeline) {
    if (!ROUTABLE_STAGES.has(stage)) continue;

    const agentRole = stage === 'requirements-gate' ? 'researcher' : stage;
    const routeRole = stage === 'requirements-gate' ? 'requirements-gate' : stage;
    const route = resolveRoleRouting(routeRole, {
      ...routingOptions,
      context,
    });

    stages.push({
      stage,
      agentRole,
      ...route,
    });
  }

  return {
    schema: MODEL_ROUTING_POLICY.schema,
    defaultModelTier: MODEL_ROUTING_POLICY.default_model_tier,
    heavyModelTier: MODEL_ROUTING_POLICY.heavy_model_tier,
    fallback: MODEL_ROUTING_POLICY.fallback,
    stages,
  };
}


function executionDecisions(input, prepared) {
  const records = [];
  const base = { runId: input.runId || 'execution', snapshot: input.snapshot ?? null, revision: input.revision ?? 0, attempt: input.attempt ?? 0 };
  const add = data => { const record = buildDecision({ ...base, ...data }); records.push(record); return record; };
  const { classification, pipeline, isolationPlan, modelRouting, securityAssessment } = prepared;
  const tierCode = ['TIER0_TRIVIAL', 'TIER1_BOUNDED', 'TIER2_COMPLEX', 'TIER3_AMBIGUOUS'][classification.tier];
  const root = add({ stage: 'classification', decision: 'classify_tier_' + classification.tier, policy: { rule: 'classification.tier' }, facts: { tier: classification.tier, evidence: classification.evidence }, reasonCodes: [tierCode] });
  for (const role of ['planner', 'scout', 'researcher', 'implementer', 'tester', 'code-reviewer', 'security-reviewer', 'verifier', 'architect', 'plan-auditor']) {
    const stage = ['planner', 'architect', 'plan-auditor'].includes(role) ? 'planning' : ['tester', 'code-reviewer', 'security-reviewer', 'verifier'].includes(role) ? 'review' : 'dispatch';
    add({ stage, discriminator: role, decision: pipeline.includes(role) ? 'activate' : 'skip',
      policy: { rule: role === 'security-reviewer' ? 'review.security-activation' : ['architect', 'plan-auditor'].includes(role) ? 'planning.council-required' : 'execution.task-owner' },
      parentDecisionId: root.decisionId, facts: { targetRole: role, activated: pipeline.includes(role), tier: classification.tier },
      reasonCodes: role === 'security-reviewer' ? securityAssessment.reasonCodes : [] });
  }
  isolationPlan.waves.forEach((wave, index) => {
    const waveId = 'wave-' + (index + 1);
    const conflicts = findFileConflicts(input.tasks || []).filter(conflict => conflict.tasks.some(id => wave.some(task => task.id === id)));
    const parallel = wave.length > 1;
    const parent = add({ stage: 'scheduling', waveId, decision: parallel ? 'parallel_wave' : conflicts.length ? 'serialize_writers' : 'schedule_wave',
      policy: { rule: parallel ? 'execution.parallel-independent-writers' : conflicts.length ? 'execution.same-file-serialization' : 'execution.task-owner' },
      reasonCodes: parallel ? ['PARALLEL_DEPENDENCIES_SATISFIED', 'FILE_OWNERSHIP_DISJOINT'] : conflicts.length ? ['SAME_FILE_CONFLICT'] : [],
      facts: { ...isolationPlan.isolation[index], conflicts }, intendedAction: { type: parallel ? 'parallel-dispatch' : 'dispatch-wave', waveId, taskIds: wave.map(t => t.id), expectsEvent: false } });
    const isolation = isolationPlan.isolation[index];
    if (isolation.mode === 'worktree') {
      const riskCodes = { explicit: 'WORKTREE_EXPLICIT', 'low-file-ownership-confidence': 'WORKTREE_LOW_OWNERSHIP_CONFIDENCE', formatter: 'WORKTREE_FORMATTER_RISK', migration: 'WORKTREE_MIGRATION_RISK', lockfile: 'WORKTREE_LOCKFILE_RISK', codegen: 'WORKTREE_GENERATED_FILES_RISK', 'generated-files': 'WORKTREE_GENERATED_FILES_RISK', 'generated-or-migration-path': 'WORKTREE_MIGRATION_RISK' };
      add({ stage: 'scheduling', waveId, parentDecisionId: parent.decisionId, decision: 'use_worktree', policy: { rule: 'execution.worktree-isolation' }, facts: isolation,
        reasonCodes: [...new Set(isolation.reason.split(':').slice(1).join(':').split(',').map(r => riskCodes[r]).filter(Boolean))] });
    }
    for (const task of wave) {
      const taskRoute = modelRouting.stages.find(route => route.stage === task.owner || route.agentRole === task.owner);
      add({ stage: 'dispatch', waveId, taskId: task.id, agentRunId: task.agentRunId, owner: task.owner, files: task.files_modified, decision: 'spawn_' + task.owner, parentDecisionId: parent.decisionId, policy: { rule: 'execution.task-owner' }, reasonCodes: task.owner === 'implementer' ? ['TASK_OWNER_IMPLEMENTER'] : [], intendedAction: { type: 'spawn', role: task.owner, taskId: task.id }, facts: { dependsOn: task.depends_on, agentIdentityKind: task.agentIdentityKind ?? (task.agentRunId ? 'framework-logical' : null), requestedModel: taskRoute?.model ?? null, requestedReasoningEffort: taskRoute?.reasoningEffort ?? null } });
    }
  });
  for (const route of modelRouting.stages) add({ stage: 'routing', discriminator: route.stage, decision: 'route',
    policy: { rule: route.escalationReasons?.length ? 'routing.failure-escalation' : 'routing.luna-first' }, facts: { ...route },
    reasonCodes: [...new Set((route.escalationReasons || []).map(reason => /repeat/.test(reason) ? 'REPEATED_FAILURE' : /luna/.test(reason) ? 'LUNA_MAX_EXHAUSTED' : 'ROUTING_ESCALATION'))] });
  return records;
}
