const TRIVIAL_HINTS = [
  /\btypo\b/i,
  /\bspelling\b/i,
  /\bone[- ]line\b/i,
  /\brename\b/i,
  /문구/,
  /오타/,
  /한\s*줄/,
];

const AMBIGUOUS_HINTS = [
  /\bsomething\b/i,
  /\bwhatever\b/i,
  /\bmake it better\b/i,
  /알아서/,
  /좋게/,
  /대충/,
  /이\s*기능/,
  /이거|저거/,
];

export const TaskTier = Object.freeze({
  TRIVIAL: 0,
  BOUNDED: 1,
  COMPLEX: 2,
  AMBIGUOUS: 3,
});

export function classifyTask(input) {
  const normalized = typeof input === 'string' ? { request: input } : { ...input };
  const request = String(normalized.request || '').trim();
  const knownFiles = Array.isArray(normalized.files) ? normalized.files.filter(Boolean) : [];
  const acceptance = Array.isArray(normalized.acceptanceCriteria)
    ? normalized.acceptanceCriteria.filter(Boolean)
    : [];
  const components = Array.isArray(normalized.components) ? normalized.components.filter(Boolean) : [];

  if (normalized.forceTier !== undefined) {
    return decision(Number(normalized.forceTier), 'explicit forceTier');
  }

  if (normalized.ambiguous === true || !request || AMBIGUOUS_HINTS.some((pattern) => pattern.test(request))) {
    return decision(TaskTier.AMBIGUOUS, 'intent or desired outcome is not sufficiently bounded');
  }

  const explicitlyArchitectural =
    normalized.architecturalDecision === true ||
    /\barchitecture\b|\barchitectural\b|\bmigration\b|\brefactor\b|\bframework\b/i.test(request) ||
    /아키텍처|마이그레이션|리팩터|프레임워크/.test(request);

  if (
    normalized.trivial === true ||
    (
      request.length <= 120 &&
      TRIVIAL_HINTS.some((pattern) => pattern.test(request)) &&
      components.length <= 1 &&
      !explicitlyArchitectural
    )
  ) {
    return decision(TaskTier.TRIVIAL, 'small localized change with no architectural decision');
  }

  if (
    normalized.complex === true ||
    explicitlyArchitectural ||
    components.length > 1 ||
    knownFiles.length > 4
  ) {
    return decision(TaskTier.COMPLEX, 'multi-component or architectural work');
  }

  if (
    normalized.bounded === true ||
    knownFiles.length > 0 ||
    acceptance.length > 0 ||
    request.length <= 320
  ) {
    return decision(TaskTier.BOUNDED, 'bounded request suitable for scout plus plan-lite');
  }

  return decision(TaskTier.AMBIGUOUS, 'insufficient execution boundary');
}

function decision(tier, reason) {
  const names = ['trivial', 'bounded', 'complex', 'ambiguous'];
  return {
    tier,
    name: names[tier],
    reason,
    requiresInterview: tier === TaskTier.AMBIGUOUS,
    requiresSpec: tier >= TaskTier.COMPLEX,
  };
}
