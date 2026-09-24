import { readFileSync } from 'node:fs';

export const MODEL_ROUTING_POLICY = Object.freeze(
  JSON.parse(readFileSync(new URL('./model-routing.json', import.meta.url), 'utf8'))
);

const LUNA_ORDER = Object.freeze(['luna_medium', 'luna_high', 'luna_xhigh', 'luna_max']);
const SOL_ORDER = Object.freeze(['sol_high', 'sol_xhigh', 'sol_max']);

export function resolveRoleRouting(role, options = {}) {
  const policy = mergePolicy(options.policy);
  const context = options.context || {};
  const reasons = [];
  const forced = normalizeForcedRoute(role, options, policy);

  let routeLevel = forced || baseRouteFor(role, context, policy, reasons);
  if (!forced) routeLevel = applyFailureEscalation(routeLevel, context, policy, reasons);

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

  const supportedModels = Array.isArray(options.supportedModels)
    ? new Set(options.supportedModels.map(String))
    : null;
  const overrideSupported = options.modelOverrideSupported !== false;
  const modelAvailable =
    attemptedModel === null ||
    supportedModels === null ||
    supportedModels.has(attemptedModel);

  const supportedEfforts = options.supportedEffortsByModel?.[attemptedModel];
  const effortAvailable =
    !configuredEffort ||
    !Array.isArray(supportedEfforts) ||
    supportedEfforts.includes(configuredEffort);

  const useFallback = !overrideSupported || !modelAvailable || !effortAvailable;
  const model = useFallback ? null : attemptedModel;
  const reasoningEffort = model ? configuredEffort : null;

  return {
    role,
    routeLevel,
    modelTier: level.family,
    tier: level.family,
    model,
    attemptedModel,
    reasoningEffort,
    inheritSessionModel: model === null,
    escalated: level.family === 'sol',
    escalationReasons: [...new Set(reasons)],
    fallback: policy.fallback,
    fallbackReason: useFallback
      ? (!overrideSupported
          ? 'model-override-unsupported'
          : !modelAvailable
            ? 'model-not-available'
            : 'reasoning-effort-not-available')
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
  const policy = mergePolicy();
  baseRouteFor(role, context, policy, reasons);
  applyFailureEscalation('luna_medium', context, policy, reasons);
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

function baseRouteFor(role, context, policy, reasons) {
  const profile = (name, reason) => {
    if (reason) reasons.push(reason);
    return routeForDifficulty(name, { policy });
  };

  if (context.forceSolMax === true || context.extremeUnresolved === true) {
    return profile('extreme', 'extreme-unresolved');
  }
  if (context.forceSolXHigh === true || context.criticalUnresolved === true) {
    return profile('critical', 'critical-unresolved');
  }
  if (
    context.forceHeavy === true ||
    context.exceptionallyDifficult === true ||
    context.lunaExhausted === true
  ) {
    return profile('exceptional', 'luna-capability-exhausted');
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

  if (role === 'security-reviewer') {
    if (criticalSecurity) return profile('extreme', 'critical-security-judgment');
    if (complexSecurity) return profile('exceptional', 'complex-security-reasoning');
    return profile('very_hard', 'bounded-security-review');
  }

  if (role === 'architect') {
    if (context.unresolvedArchitecture === true) {
      return profile('exceptional', 'unresolved-architecture');
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
      return profile('exceptional', 'unresolved-plan-risk');
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

function applyFailureEscalation(routeLevel, context, policy, reasons) {
  const failures = Math.max(0, Number(context.verificationFailures || 0));
  if (!failures) return routeLevel;

  const level = policy.levels?.[routeLevel];
  if (!level) return routeLevel;

  if (level.family === 'sol') {
    const next = nextRouteWithinFamily(routeLevel, policy);
    if (next !== routeLevel) {
      reasons.push(failures >= 2
        ? 'repeated-failure-sol-effort-increase'
        : 'first-failure-same-family-effort-increase');
    }
    return next;
  }

  if (
    routeLevel === 'luna_max' &&
    (
      context.lunaMaxFailed === true ||
      context.repeatedSameFailure === true ||
      failures >= 3
    )
  ) {
    reasons.push('luna-max-repeated-failure');
    return 'sol_high';
  }

  if (failures >= 2) {
    reasons.push('repeated-failure-use-luna-max');
    return 'luna_max';
  }

  const next = nextRouteWithinFamily(routeLevel, policy);
  if (next !== routeLevel) reasons.push('first-failure-same-family-effort-increase');
  return next;
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
