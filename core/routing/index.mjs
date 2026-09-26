import { readFileSync } from 'node:fs';
import { normalizeFailureEnvelope } from './failure-envelope.mjs';

export const MODEL_ROUTING_POLICY = Object.freeze(
  JSON.parse(readFileSync(new URL('./model-routing.json', import.meta.url), 'utf8'))
);

const LUNA_ORDER = Object.freeze(['luna_medium', 'luna_high', 'luna_xhigh', 'luna_max']);
const SOL_ORDER = Object.freeze(['sol_high', 'sol_xhigh', 'sol_max']);
const ROUTE_ORDER = Object.freeze([...LUNA_ORDER, ...SOL_ORDER]);

export const ALLOWED_MODELS = Object.freeze([
  ...new Set(Object.values(MODEL_ROUTING_POLICY.levels || {}).map(level => level?.model).filter(Boolean)),
]);

export function supportedEffortsForModel(model, policy = MODEL_ROUTING_POLICY) {
  const family = Object.values(policy.levels || {}).find(level => level?.model === model)?.family;
  if (!family) return [];
  const values = policy.runtime_surface?.[family + '_supported_efforts'];
  return Array.isArray(values) ? [...values] : [];
}

export function validateModelSelection(model, reasoningEffort, policy = MODEL_ROUTING_POLICY) {
  if (!model) throw routingError('MODEL_REQUIRED', 'Hybrid-controlled inference requires an explicit model');
  if (!reasoningEffort) throw routingError('EFFORT_REQUIRED', 'Hybrid-controlled inference requires an explicit reasoning effort');
  const allowed = new Set(Object.values(policy.levels || {}).map(level => level?.model).filter(Boolean));
  if (!allowed.has(model)) throw routingError('MODEL_NOT_ALLOWED', 'Model is not allowed by Hybrid routing policy: ' + model, { model });
  const efforts = supportedEffortsForModel(model, policy);
  if (!efforts.includes(reasoningEffort)) {
    throw routingError('EFFORT_NOT_ALLOWED', 'Reasoning effort is not allowed for model ' + model + ': ' + reasoningEffort, {
      model,
      reasoningEffort,
      supportedEfforts: efforts,
    });
  }
  return { model, reasoningEffort };
}

export function resolveRoleRouting(role, options = {}) {
  const policy = mergePolicy(options.policy);
  const context = options.context || {};
  const reasons = [];
  const forced = normalizeForcedRoute(role, options, policy);

  let routeLevel = forced || baseRouteFor(role, context, policy, reasons);
  if (!forced) routeLevel = applyFailureEscalation(routeLevel, context, policy, reasons, role);

  const level = policy.levels?.[routeLevel];
  if (!level) throw new Error('Unknown routing level: ' + routeLevel);

  const configuredModel =
    options.roleModels?.[role] ||
    options.levelModels?.[routeLevel] ||
    options.tierModels?.[level.family] ||
    level.model ||
    null;
  const attemptedModel = sanitizeModel(configuredModel);

  const configuredEffort =
    options.roleEffort?.[role] ||
    options.levelEffort?.[routeLevel] ||
    options.tierEffort?.[level.family] ||
    level.reasoning_effort ||
    null;

  if (!attemptedModel) {
    throw routingError('MODEL_REQUIRED', 'Resolved Hybrid route has no explicit model', { role, routeLevel });
  }
  validateModelSelection(attemptedModel, configuredEffort, policy);
  const attemptedFamily = modelFamilyFor(attemptedModel, policy);
  if (attemptedFamily !== level.family) {
    throw routingError(
      'MODEL_FAMILY_MISMATCH',
      'Model override family does not match the selected Hybrid route family',
      {
        role,
        routeLevel,
        routeFamily: level.family,
        model: attemptedModel,
        modelFamily: attemptedFamily,
      }
    );
  }

  if (options.modelOverrideSupported === false) {
    throw routingError('MODEL_OVERRIDE_REJECTED', 'Codex model override is unavailable; session inheritance is prohibited', {
      role,
      routeLevel,
      model: attemptedModel,
    });
  }

  if (Array.isArray(options.supportedModels) && !new Set(options.supportedModels.map(String)).has(attemptedModel)) {
    throw routingError('MODEL_UNAVAILABLE', 'Routed model is unavailable; Hybrid will not inherit or substitute a session model', {
      role,
      routeLevel,
      model: attemptedModel,
    });
  }

  const runtimeEfforts = options.supportedEffortsByModel?.[attemptedModel];
  if (Array.isArray(runtimeEfforts) && !runtimeEfforts.includes(configuredEffort)) {
    throw routingError('EFFORT_NOT_ALLOWED', 'Routed reasoning effort is unavailable; Hybrid will not drop the override', {
      role,
      routeLevel,
      model: attemptedModel,
      reasoningEffort: configuredEffort,
    });
  }

  return {
    role,
    routeLevel,
    modelTier: level.family,
    tier: level.family,
    model: attemptedModel,
    attemptedModel,
    reasoningEffort: configuredEffort,
    inheritSessionModel: false,
    executable: true,
    escalated: level.family === 'sol',
    escalationReasons: [...new Set(reasons)],
    fallback: policy.fallback,
    fallbackReason: null,
  };
}

export function failClosedModelRoute(route, reason = 'MODEL_OVERRIDE_REJECTED') {
  if (!route || typeof route !== 'object') throw new TypeError('route is required');
  return {
    ...route,
    inheritSessionModel: false,
    executable: false,
    blocked: true,
    fallback: 'fail-closed',
    fallbackReason: reason,
  };
}

export function escalationReasons(role, context = {}) {
  const reasons = [];
  const policy = mergePolicy();
  baseRouteFor(role, context, policy, reasons);
  applyFailureEscalation('luna_medium', context, policy, reasons, role);
  return [...new Set(reasons)];
}

export function routeForDifficulty(difficulty, options = {}) {
  const policy = mergePolicy(options.policy);
  const key = policy.profiles?.[difficulty];
  if (!key || !policy.levels?.[key]) throw new Error('Unknown routing difficulty: ' + difficulty);
  return key;
}

export function nextRouteWithinFamily(routeLevel, policyOverride) {
  const policy = mergePolicy(policyOverride);
  const level = policy.levels?.[routeLevel];
  if (!level) throw new Error('Unknown routing level: ' + routeLevel);
  const order = level.family === 'sol' ? SOL_ORDER : LUNA_ORDER;
  const index = order.indexOf(routeLevel);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : routeLevel;
}

export function nextRouteStep(routeLevel, policyOverride) {
  const policy = mergePolicy(policyOverride);
  if (!policy.levels?.[routeLevel]) throw new Error('Unknown routing level: ' + routeLevel);
  const index = ROUTE_ORDER.indexOf(routeLevel);
  return index >= 0 && index < ROUTE_ORDER.length - 1
    ? ROUTE_ORDER[index + 1]
    : routeLevel;
}

function baseRouteFor(role, context, policy, reasons) {
  const profile = (name, reason) => {
    if (reason) reasons.push(reason);
    return routeForDifficulty(name, { policy });
  };

  if (context.lunaExhausted === true || context.lunaMaxFailed === true) {
    return profile('exceptional', 'luna-max-exhausted');
  }
  if (
    context.forceSolMax === true ||
    context.forceSolXHigh === true ||
    context.extremeUnresolved === true ||
    context.criticalUnresolved === true ||
    context.forceHeavy === true ||
    context.exceptionallyDifficult === true
  ) {
    return profile('very_hard', 'luna-max-required-before-sol');
  }

  const classification = String(context.classification || '');
  const highAmbiguity =
    context.highAmbiguity === true ||
    classification === 'ambiguous' ||
    Number(context.ambiguity) > 0.20;
  const architectural =
    context.architecturalChange === true ||
    context.largeRefactor === true;
  const importantArchitecture = context.importantArchitecturalDecision === true;
  const complexDebugging =
    context.complexDebugging === true ||
    context.crossModuleDebugging === true;
  const difficultReview = context.difficultReview === true;
  const securitySensitive = context.securitySensitive === true;
  const complexSecurity =
    context.complexSecurityReasoning === true ||
    context.exploitReasoning === true ||
    context.complexTrustBoundary === true;
  const criticalSecurity =
    context.criticalSecurityJudgment === true ||
    context.unresolvedSecurityRisk === true;

  if (role === 'design-architect') {
    if (context.highDesignComplexity === true || highAmbiguity) {
      return profile('hard', 'high-complexity-design-architecture');
    }
    return profile('moderate', 'design-architecture');
  }

  if (role === 'design-executor') {
    if (context.highDesignComplexity === true) {
      return profile('hard', 'high-complexity-design-execution');
    }
    return profile('moderate', 'design-execution');
  }

  if (role === 'design-reviewer') {
    if (context.highDesignComplexity === true || difficultReview) {
      return profile('hard', 'high-complexity-design-review');
    }
    return profile('moderate', 'design-review');
  }

  if (role === 'security-reviewer') {
    if (criticalSecurity) return profile('very_hard', 'critical-security-needs-luna-max');
    if (complexSecurity) return profile('very_hard', 'complex-security-needs-luna-max');
    return profile('very_hard', 'bounded-security-review');
  }

  if (role === 'architect') {
    if (context.unresolvedArchitecture === true) {
      return profile('very_hard', 'unresolved-architecture-needs-luna-max');
    }
    if (importantArchitecture || securitySensitive) {
      return profile('very_hard', 'important-architecture');
    }
    if (architectural || classification === 'complex' || classification === 'ambiguous') {
      return profile('very_hard', 'architecture-review');
    }
    return profile('hard', 'ordinary-architecture-review');
  }

  if (role === 'plan-auditor') {
    if (context.unresolvedArchitecture === true || context.criticalPlanRisk === true) {
      return profile('very_hard', 'unresolved-plan-risk-needs-luna-max');
    }
    if (importantArchitecture || highAmbiguity || securitySensitive) {
      return profile('very_hard', 'high-risk-plan-audit');
    }
    return profile('hard', 'plan-audit');
  }

  if (role === 'requirements-gate') {
    if (highAmbiguity) return profile('very_hard', 'high-ambiguity');
    return profile('moderate', 'requirements-reasoning');
  }

  if (role === 'planner') {
    if (importantArchitecture || securitySensitive || highAmbiguity) {
      return profile('very_hard', 'high-risk-planning');
    }
    if (architectural || complexDebugging) {
      return profile('hard', architectural ? 'architectural-planning' : 'complex-cross-module-debugging');
    }
    if (classification === 'complex') return profile('moderate', 'complex-planning');
    return profile('routine');
  }

  if (role === 'implementer') {
    if (context.veryHardImplementation === true || context.largeRefactor === true) {
      return profile('very_hard', 'very-hard-implementation');
    }
    if (complexDebugging || context.hardImplementation === true) {
      return profile('hard', 'complex-cross-module-debugging');
    }
    if (context.moderateImplementation === true) {
      return profile('moderate', 'moderate-implementation');
    }
    return profile('routine');
  }

  if (role === 'code-reviewer') {
    if (importantArchitecture || securitySensitive) {
      return profile('very_hard', 'high-risk-review');
    }
    if (difficultReview || architectural || classification === 'complex') {
      return profile('hard', difficultReview ? 'difficult-review' : 'complex-review');
    }
    return profile('moderate', 'independent-review');
  }

  if (role === 'adversarial-reviewer') {
    if (
      importantArchitecture ||
      securitySensitive ||
      context.highRegressionRisk === true
    ) {
      return profile('very_hard', 'high-risk-adversarial-review');
    }
    if (
      difficultReview ||
      architectural ||
      classification === 'complex' ||
      classification === 'ambiguous'
    ) {
      return profile('hard', 'adversarial-review');
    }
    return profile('moderate', 'bounded-adversarial-review');
  }

  if (role === 'browser-adversarial-reviewer') {
    if (
      importantArchitecture ||
      securitySensitive ||
      context.highRegressionRisk === true ||
      classification === 'ambiguous'
    ) {
      return profile('very_hard', 'high-risk-browser-adversarial-review');
    }
    if (difficultReview || architectural || classification === 'complex') {
      return profile('hard', 'browser-adversarial-review');
    }
    return profile('moderate', 'bounded-browser-adversarial-review');
  }

  if (role === 'browser-functional-tester') {
    if (context.hardVerification === true || classification === 'complex') {
      return profile('moderate', 'nontrivial-browser-functional-test');
    }
    return profile('routine', 'browser-functional-test');
  }

  if (role === 'debugger') {
    if (complexDebugging) return profile('hard', 'complex-cross-module-debugging');
    return profile('moderate', 'debugging');
  }

  if (role === 'researcher') {
    if (highAmbiguity || context.hardResearch === true) {
      return profile('hard', highAmbiguity ? 'high-ambiguity-research' : 'hard-research');
    }
    return profile('moderate', 'research');
  }

  if (role === 'tester' || role === 'verifier') {
    if (context.hardVerification === true || classification === 'complex') {
      return profile('moderate', 'nontrivial-verification');
    }
    return profile('routine');
  }

  return profile('routine');
}

function applyFailureEscalation(routeLevel, context, policy, reasons, role) {
  if (context.failureEnvelope) {
    const envelope = normalizeFailureEnvelope(context.failureEnvelope);
    if (envelope.targetRole && envelope.targetRole !== role) {
      return routeLevel;
    }

    const attemptedRoute =
      envelope.attemptedRoute && policy.levels?.[envelope.attemptedRoute]
        ? envelope.attemptedRoute
        : routeLevel;

    if (!envelope.reasoningEscalationEligible) {
      reasons.push('failure-' + envelope.kind + '-keep-route');
      return attemptedRoute;
    }

    const next = nextRouteStep(attemptedRoute, policy);
    if (next !== attemptedRoute) {
      reasons.push('reasoning-failure-one-rung');
      reasons.push('failure-kind-' + envelope.kind);
    }
    return next;
  }

  const failures = Math.max(0, Number(context.verificationFailures || 0));
  if (!failures) return routeLevel;

  // Legacy verificationFailures is interpreted only for the failed verifier
  // or the implementation-owner repair path. Other sibling stages stay local.
  if (!['verifier', 'implementer'].includes(role)) return routeLevel;

  let current = routeLevel;
  if (context.lunaMaxFailed === true || context.lunaExhausted === true) {
    current = 'luna_max';
  }

  for (let step = 0; step < failures; step++) {
    current = nextRouteStep(current, policy);
  }

  if (current !== routeLevel) {
    reasons.push('gradual-failure-escalation');
    if (current.startsWith('sol_')) reasons.push('luna-max-exhausted');
  }
  return current;
}

function normalizeForcedRoute(role, options, policy) {
  const direct = options.roleRoutes?.[role] || options.routeLevel || null;
  if (direct) {
    if (!policy.levels?.[direct]) throw new Error('Unknown forced routing level: ' + direct);
    return direct;
  }

  const legacy = options.roleTiers?.[role] || options.modelTier || null;
  if (legacy === 'luna') return policy.default_route || 'luna_medium';
  if (legacy === 'sol') return 'sol_high';
  if (legacy && policy.levels?.[legacy]) return legacy;
  return null;
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

function modelFamilyFor(model, policy) {
  const families = new Set(
    Object.values(policy.levels || {})
      .filter((level) => level?.model === model)
      .map((level) => level.family)
  );
  return families.size === 1 ? [...families][0] : null;
}

function routingError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function mergePolicy(override) {
  if (!override) return MODEL_ROUTING_POLICY;
  return {
    ...MODEL_ROUTING_POLICY,
    ...override,
    levels: {
      ...MODEL_ROUTING_POLICY.levels,
      ...(override.levels || {}),
    },
    profiles: {
      ...MODEL_ROUTING_POLICY.profiles,
      ...(override.profiles || {}),
    },
    failure_policy: {
      ...MODEL_ROUTING_POLICY.failure_policy,
      ...(override.failure_policy || {}),
    },
  };
}
