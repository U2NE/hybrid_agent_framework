import { classifyTask, TaskTier } from '../classifier/index.mjs';
import { evaluateRequirements } from '../requirements/index.mjs';
import { buildExecutionWaves } from '../scheduler/index.mjs';
import { resolveRoleRouting, MODEL_ROUTING_POLICY } from '../routing/index.mjs';
import { requiresSecurityReview } from '../verification/index.mjs';

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

export function derivePipeline({ classification, securityReview = false }) {
  const tier = classification.tier;

  if (tier === TaskTier.TRIVIAL) {
    const stages = ['implementer', 'tester'];
    if (securityReview) stages.push('code-reviewer', 'security-reviewer');
    stages.push('verifier', 'knowledge-synthesizer');
    return stages;
  }

  const stages = ['scout'];

  if (tier === TaskTier.AMBIGUOUS) {
    stages.push('requirements-gate', 'user-approval');
  } else if (tier === TaskTier.COMPLEX) {
    stages.push('spec-lite', 'user-approval');
  }

  stages.push('researcher', 'planner');

  // Keep expensive architectural council work for genuinely complex/ambiguous
  // tasks rather than every bounded change.
  if (tier >= TaskTier.COMPLEX) stages.push('architect', 'plan-auditor');

  stages.push('scheduler', 'implementer', 'tester', 'code-reviewer');
  if (securityReview) stages.push('security-reviewer');
  stages.push('verifier', 'integrate', 'full-test', 'knowledge-synthesizer', 'wiki-lint');

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

  const securityReview = requiresSecurityReview({
    description: input.request || input.task?.request || '',
    files: (input.tasks || []).flatMap((task) => task.files_modified || []),
    tags: input.securityTags || [],
    securityRelevant: input.securityRelevant,
  });

  const waves = input.tasks ? buildExecutionWaves(input.tasks) : [];
  const pipeline = derivePipeline({ classification, securityReview });
  const routingContext = deriveRoutingContext(input, classification, requirements, securityReview);
  const modelRouting = buildModelRouting(pipeline, routingContext, input.modelRouting || {});

  return {
    classification,
    requirements,
    securityReview,
    pipeline,
    waves,
    routingContext,
    modelRouting,
    blocked:
      classification.tier === TaskTier.AMBIGUOUS &&
      requirements !== null &&
      requirements.pass === false,
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
      /\barchitecture\b|\barchitectural\b|\bmigration\b|\brefactor\b|아키텍처|마이그레이션|리팩터/i.test(request),
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
  };
}

export function buildModelRouting(pipeline, context, routingOptions = {}) {
  const stages = [];

  for (const stage of pipeline) {
    if (!ROUTABLE_STAGES.has(stage)) continue;

    // requirements-gate reuses the researcher agent surface but receives a
    // stage-specific routing decision so high ambiguity can escalate to Sol.
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
