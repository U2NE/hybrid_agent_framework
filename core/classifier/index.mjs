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

const ARCHITECTURE_HINTS = [
  /\barchitecture\b|\barchitectural\b|\bmigration\b|\bframework\b/i,
  /\bcross[- ]module\b|\bsystem[- ]wide\b|\bplatform[- ]wide\b/i,
  /아키텍처|마이그레이션|프레임워크|대규모|전면\s*개편/,
];

const MECHANICAL_HINTS = [
  /\bidentical\b|\bsame\s+(?:change|replacement|rename)\b/i,
  /\b(?:locale|translation)\s+files?\b/i,
  /동일\s*(?:문구|변경|치환|수정)|일괄\s*(?:변경|치환|수정)/,
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

  if (normalized.ambiguous === true || !request) {
    return decision(TaskTier.AMBIGUOUS, 'intent or desired outcome is not sufficiently bounded');
  }

  const evidence = collectEvidence({ request, knownFiles, acceptance, components, normalized });
  const ambiguousHint = AMBIGUOUS_HINTS.some((pattern) => pattern.test(request));

  if (ambiguousHint && evidence.anchorCount < 2 && evidence.unknownDecisionCount > 0) {
    return decision(
      TaskTier.AMBIGUOUS,
      'ambiguous language is not offset by enough concrete execution anchors',
      evidence
    );
  }

  const explicitArchitecture =
    normalized.architecturalDecision === true ||
    normalized.largeRefactor === true ||
    ARCHITECTURE_HINTS.some((pattern) => pattern.test(request));

  const refactorMentioned = /\brefactor\b|리팩터/i.test(request);
  const localizedRefactor =
    refactorMentioned &&
    !explicitArchitecture &&
    (evidence.fileAnchors > 0 || evidence.symbolAnchors > 0) &&
    components.length <= 1;

  const mechanicalMultiFile =
    normalized.mechanical === true ||
    MECHANICAL_HINTS.some((pattern) => pattern.test(request));

  if (
    normalized.trivial === true ||
    (
      request.length <= 140 &&
      TRIVIAL_HINTS.some((pattern) => pattern.test(request)) &&
      components.length <= 1 &&
      !explicitArchitecture
    )
  ) {
    return decision(TaskTier.TRIVIAL, 'small localized change with no architectural decision', evidence);
  }

  if (
    normalized.complex === true ||
    explicitArchitecture ||
    (components.length > 1 && !mechanicalMultiFile) ||
    (refactorMentioned && !localizedRefactor && evidence.anchorCount < 2)
  ) {
    return decision(TaskTier.COMPLEX, 'multi-component or architecture-level reasoning is required', evidence);
  }

  if (
    normalized.bounded === true ||
    localizedRefactor ||
    mechanicalMultiFile ||
    evidence.anchorCount >= 1 ||
    request.length <= 320
  ) {
    return decision(TaskTier.BOUNDED, 'request has concrete execution anchors and bounded decisions', evidence);
  }

  return decision(TaskTier.AMBIGUOUS, 'insufficient execution boundary', evidence);
}

export function collectEvidence({ request, knownFiles = [], acceptance = [], components = [], normalized = {} }) {
  const fileMatches = request.match(
    /(?:^|[\s"'(])(?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?/g
  ) || [];
  const symbolMatches = request.match(
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\([^)]*\)|\x60[A-Za-z_$][A-Za-z0-9_$.:-]*\x60/g
  ) || [];

  const explicitBehavior =
    normalized.explicitBehavior === true ||
    /\b(?:return|returns|respond|responds|throw|throws|emit|redirect|reject|accept|set|write|read|delete|create|update)\b/i.test(request) ||
    /\b(?:200|201|204|400|401|403|404|409|422|500)\b/.test(request) ||
    /(?:반환|응답|리다이렉트|거부|허용|생성|수정|삭제|저장)(?:하도록|하게|해줘|한다)?/.test(request);

  const explicitConstraint =
    normalized.explicitConstraints === true ||
    /\b(?:must|only|never|without|exactly|at most|at least)\b/i.test(request) ||
    /(?:반드시|오직|절대|없이|정확히|최대|최소)/.test(request);

  const fileAnchors = knownFiles.length + fileMatches.length;
  const symbolAnchors = symbolMatches.length;
  const acceptanceAnchors = acceptance.length + (explicitBehavior ? 1 : 0);
  const constraintAnchors = explicitConstraint ? 1 : 0;
  const anchorCount =
    (fileAnchors > 0 ? 1 : 0) +
    (symbolAnchors > 0 ? 1 : 0) +
    (acceptanceAnchors > 0 ? 1 : 0) +
    constraintAnchors;

  const unknownDecisionCount = Number(
    normalized.unknownDecisions ??
    (AMBIGUOUS_HINTS.some((pattern) => pattern.test(request)) ? 1 : 0)
  );

  return {
    fileAnchors,
    symbolAnchors,
    acceptanceAnchors,
    constraintAnchors,
    componentCount: components.length,
    architecturalLanguage: ARCHITECTURE_HINTS.some((pattern) => pattern.test(request)),
    unknownDecisionCount,
    anchorCount,
  };
}

function decision(tier, reason, evidence = null) {
  const names = ['trivial', 'bounded', 'complex', 'ambiguous'];
  return {
    tier,
    name: names[tier],
    reason,
    evidence,
    requiresInterview: tier === TaskTier.AMBIGUOUS,
    requiresSpec: tier >= TaskTier.COMPLEX,
  };
}
