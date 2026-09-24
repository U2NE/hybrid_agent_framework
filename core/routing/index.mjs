import { readFileSync } from 'node:fs';

export const MODEL_ROUTING_POLICY = Object.freeze(
  JSON.parse(readFileSync(new URL('./model-routing.json', import.meta.url), 'utf8'))
);

const ALWAYS_SOL_ROLES = new Set(['architect', 'plan-auditor', 'security-reviewer']);

export function resolveRoleRouting(role, options = {}) {
  const policy = mergePolicy(options.policy);
  const context = options.context || {};
  const reasons = escalationReasons(role, context);
  const forcedTier = options.roleTiers?.[role] || options.modelTier || null;
  const modelTier = forcedTier || (reasons.length ? policy.heavy_model_tier : policy.default_model_tier);

  const configuredModel =
    options.roleModels?.[role] ||
    options.tierModels?.[modelTier] ||
    policy.tiers?.[modelTier]?.model ||
    null;
  const attemptedModel = sanitizeModel(configuredModel);

  const supportedModels = Array.isArray(options.supportedModels)
    ? new Set(options.supportedModels.map(String))
    : null;
  const overrideSupported = options.modelOverrideSupported !== false;
  const available = attemptedModel === null || supportedModels === null || supportedModels.has(attemptedModel);

  const useFallback = !overrideSupported || !available;
  const model = useFallback ? null : attemptedModel;
  const reasoningEffort = model
    ? (
        options.roleEffort?.[role] ||
        options.tierEffort?.[modelTier] ||
        policy.tiers?.[modelTier]?.reasoning_effort ||
        null
      )
    : null;

  return {
    role,
    modelTier,
    tier: modelTier,
    model,
    attemptedModel,
    reasoningEffort,
    inheritSessionModel: model === null,
    escalated: modelTier === policy.heavy_model_tier,
    escalationReasons: reasons,
    fallback: policy.fallback,
    fallbackReason: useFallback
      ? (!overrideSupported ? 'model-override-unsupported' : 'model-not-available')
      : null,
  };
}

export function fallbackToSessionInheritance(route, reason = 'runtime-model-rejected') {
  if (!route || typeof route !== 'object') throw new TypeError('route is required');
  return {
    ...route,
    model: null,
    reasoningEffort: null,
    inheritSessionModel: true,
    fallbackReason: reason,
  };
}

export function escalationReasons(role, context = {}) {
  const reasons = [];

  if (ALWAYS_SOL_ROLES.has(role)) reasons.push('role-requires-high-judgment');

  const highAmbiguity =
    context.highAmbiguity === true ||
    context.classification === 'ambiguous' ||
    Number(context.ambiguity) > 0.20;
  const complexTask = context.classification === 'complex';
  const architectural =
    context.architecturalChange === true ||
    context.largeRefactor === true ||
    context.importantArchitecturalDecision === true;
  const complexDebugging =
    context.complexDebugging === true ||
    context.crossModuleDebugging === true;
  const repeatedFailure = Number(context.verificationFailures || 0) >= 2;
  const difficultReview = context.difficultReview === true;
  const securitySensitive = context.securitySensitive === true;

  if (role === 'requirements-gate' && highAmbiguity) reasons.push('high-ambiguity');
  if (role === 'planner') {
    if (complexTask) reasons.push('complex-planning');
    if (highAmbiguity) reasons.push('high-ambiguity');
    if (architectural) reasons.push('architectural-change');
    if (complexDebugging) reasons.push('complex-cross-module-debugging');
    if (securitySensitive) reasons.push('security-sensitive-plan');
  }
  if (role === 'implementer' && complexDebugging) {
    reasons.push('complex-cross-module-debugging');
  }
  if (role === 'implementer' && complexDebugging) {
    reasons.push('complex-cross-module-debugging');
  }
  if (role === 'debugger') {
    if (complexDebugging) reasons.push('complex-cross-module-debugging');
    if (repeatedFailure) reasons.push('repeated-verification-failure');
  }
  if (role === 'code-reviewer') {
    if (difficultReview) reasons.push('difficult-review');
    if (architectural) reasons.push('architectural-change');
    if (securitySensitive) reasons.push('security-sensitive-review');
    if (repeatedFailure) reasons.push('repeated-verification-failure');
  }
  if (role === 'verifier' && repeatedFailure) reasons.push('repeated-verification-failure');

  if (context.forceHeavy === true) reasons.push('explicit-heavy-escalation');

  return [...new Set(reasons)];
}

export function sanitizeModel(value) {
  if (value == null || value === '') return null;
  const model = String(value).trim();
  if (!model) return null;
  if (!/^gpt-[a-z0-9][a-z0-9._-]*$/i.test(model) && !/^o[0-9][a-z0-9._-]*$/i.test(model)) {
    throw new Error('Refusing non-OpenAI-looking Codex model override: ' + model);
  }
  return model;
}

function mergePolicy(override) {
  if (!override) return MODEL_ROUTING_POLICY;
  return {
    ...MODEL_ROUTING_POLICY,
    ...override,
    tiers: {
      ...MODEL_ROUTING_POLICY.tiers,
      ...(override.tiers || {}),
    },
  };
}
