export const STRONG_SECURITY_TRIGGERS = Object.freeze([
  /\bauthentication\b|\bauthori[sz]ation\b/i,
  /\b(?:jwt|session|oauth|oidc)\b/i,
  /\bcrypto(?:graphy|graphic)?\b|\bencrypt(?:ion|ed)?\b|\bdecrypt(?:ion|ed)?\b/i,
  /\b(?:sql|nosql)\b.*\b(?:query|statement|execute|builder)\b/i,
  /\bfile[ _-]?upload\b/i,
  /\bpayment\b|\bcheckout\b|\bbilling\b/i,
  /\b(?:secret|token|api[ _-]?key|password)\b.*\b(?:handling|storage|rotation|validation|exposure|leak|write|read)\b/i,
  /\bpermission\b.*\b(?:check(?:s|ing)?|enforce(?:ment|d|s)?|grant|deny|access)\b/i,
  /\btrust[ _-]?boundary\b/i,
  /\b(?:ssrf|xss|injection)\b/i,
  /\bcommand\b.*\binjection\b/i,
]);

export const WEAK_SECURITY_TRIGGERS = Object.freeze([
  /\bnetwork\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bpermission\b/i,
  /\bcredential\b/i,
]);

export function requiresSecurityReview(change = {}) {
  if (change.securityRelevant === true) return true;

  const description = String(change.description || '');
  const tags = (change.tags || []).map(String).join(' ');
  const files = (change.files || []).map(String);
  const text = [description, tags, ...files].join(' ');

  if (STRONG_SECURITY_TRIGGERS.some((trigger) => trigger.test(text))) return true;

  if (files.some(isStrongSecurityPath)) return true;

  const weak = WEAK_SECURITY_TRIGGERS.some((trigger) => trigger.test(text));
  if (!weak) return false;

  if (change.securityContext === true) return true;

  const enforcementContext =
    /\b(?:enforce|validate|authorize|authenticate|access control|trust boundary|request handling|outbound request|database query)\b/i.test(description);
  const codeSurface = files.some((file) =>
    /\.(?:js|mjs|cjs|ts|tsx|py|go|rs|java|kt|rb|php|cs|cpp|c|h)$/i.test(file) &&
    !/(?:^|\/)(?:docs?|examples?|fixtures?|locales?)(?:\/|$)/i.test(file)
  );

  return enforcementContext && codeSurface;
}

export function assertIndependentVerification(implementationAuthor, verifier) {
  if (!implementationAuthor || !verifier) throw new Error('implementation author and verifier are required');
  if (implementationAuthor === verifier) {
    const error = new Error('implementation cannot mark itself verified');
    error.code = 'SELF_VERIFICATION';
    throw error;
  }
  return true;
}

export async function runFixLoop({ verify, fix, maxIterations = 3 }) {
  if (typeof verify !== 'function') throw new TypeError('verify must be a function');
  if (typeof fix !== 'function') throw new TypeError('fix must be a function');
  if (!Number.isInteger(maxIterations) || maxIterations < 0) throw new TypeError('maxIterations must be a non-negative integer');

  const evidence = [];

  for (let attempt = 0; attempt <= maxIterations; attempt++) {
    const result = await verify({ attempt });
    evidence.push({ stage: 'verify', attempt, result });

    if (result && result.ok === true) {
      return { ok: true, attempts: attempt, evidence };
    }

    if (attempt === maxIterations) {
      return {
        ok: false,
        blocked: true,
        reason: 'fix loop exhausted',
        attempts: attempt,
        evidence,
      };
    }

    const fixResult = await fix({ attempt: attempt + 1, verification: result });
    evidence.push({ stage: 'fix', attempt: attempt + 1, result: fixResult });
  }

  throw new Error('unreachable');
}

export function buildAcceptanceTrace(input = {}) {
  const criteria = (input.criteria || [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  const planTasks = Array.isArray(input.planTasks) ? input.planTasks : [];
  const implementationEvidence = input.implementationEvidence || {};
  const verificationEvidence = input.verificationEvidence || {};

  return criteria.map((criterion, index) => {
    const id = 'AC-' + String(index + 1).padStart(3, '0');
    const taskIds = planTasks
      .filter((task) =>
        (task.acceptance_criteria || task.acceptanceCriteria || [])
          .map(String)
          .some((value) => value.trim() === criterion)
      )
      .map((task) => String(task.id));

    const implementation = lookupEvidence(implementationEvidence, id, criterion, index);
    const verification = lookupEvidence(verificationEvidence, id, criterion, index);
    const requestedStatus = String(verification?.status || verification?.result || '').toUpperCase();

    let status = 'MISSING';
    if (
      taskIds.length > 0 &&
      hasEvidence(implementation) &&
      requestedStatus === 'VERIFIED' &&
      hasEvidence(verification)
    ) {
      status = 'VERIFIED';
    } else if (
      taskIds.length > 0 &&
      (hasEvidence(implementation) || hasEvidence(verification))
    ) {
      status = 'PARTIAL';
    }

    return {
      id,
      criterion,
      planTasks: taskIds,
      implementationEvidence: implementation || null,
      verificationEvidence: verification || null,
      status,
    };
  });
}

export function evaluateAcceptanceTrace(trace = []) {
  const normalized = Array.isArray(trace) ? trace : [];
  const missing = normalized.filter((item) => item.status === 'MISSING');
  const partial = normalized.filter((item) => item.status === 'PARTIAL');
  const verified = normalized.filter((item) => item.status === 'VERIFIED');

  return {
    pass: normalized.length > 0 && missing.length === 0 && partial.length === 0,
    total: normalized.length,
    verified: verified.length,
    partial: partial.length,
    missing: missing.length,
    items: normalized,
  };
}

export function evaluateVerificationReport(report = {}) {
  const trace = buildAcceptanceTrace({
    criteria: report.criteria || [],
    planTasks: report.planTasks || [],
    implementationEvidence: report.implementationEvidence || {},
    verificationEvidence: report.verificationEvidence || {},
  });
  const acceptance = evaluateAcceptanceTrace(trace);
  const gaps = [];

  if (!report.freshTestOutput) gaps.push('fresh-test-output');
  if (report.buildApplicable !== false && report.buildPassed !== true) gaps.push('build');
  if (report.typecheckApplicable === true && report.typecheckPassed !== true) gaps.push('typecheck');
  if (report.lintApplicable === true && report.lintPassed !== true) gaps.push('lint');
  if (report.specGoalAligned !== true) gaps.push('spec-goal-alignment');
  if (!acceptance.pass) gaps.push('acceptance-trace');

  return {
    pass: gaps.length === 0,
    verdict: gaps.length === 0 ? 'PASS' : 'FAIL',
    gaps,
    acceptance,
  };
}

function lookupEvidence(collection, id, criterion, index) {
  if (Array.isArray(collection)) {
    return collection.find((item) =>
      item?.id === id ||
      item?.criterion === criterion ||
      Number(item?.index) === index
    ) || null;
  }
  if (!collection || typeof collection !== 'object') return null;
  return collection[id] ?? collection[criterion] ?? collection[index] ?? null;
}

function hasEvidence(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([key]) => key !== 'status' && key !== 'result');
    return entries.some(([, item]) => hasEvidence(item)) ||
      (typeof value.evidence === 'string' && value.evidence.trim().length > 0);
  }
  return true;
}

function isStrongSecurityPath(file) {
  return /(?:^|\/)(?:auth|security|crypto|payments?|uploads?)(?:\/|\.|$)/i.test(String(file));
}

export const EVIDENCE_KINDS = Object.freeze([
  'test',
  'build',
  'typecheck',
  'lint',
  'review',
  'cli',
  'http',
  'browser',
]);

export function resolveEvidencePolicy(options = {}) {
  const tier = Math.max(0, Math.min(3, Number(options.tier ?? 1)));
  const depth = tier === 0 ? 'minimal' : tier === 1 ? 'targeted' : 'full';
  const runtimeInteractionRequired = options.runtimeInteractionRequired === true;
  const requiredKinds = uniqueEvidenceKinds(options.requiredKinds || []);

  return {
    tier,
    depth,
    requireFresh: true,
    requireIndependent: tier >= 2,
    runtimeInteractionRequired,
    requiredKinds,
  };
}

export function normalizeEvidence(value, defaults = {}) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return {
      kind: defaults.kind || 'test',
      source: text,
      fresh: defaults.fresh !== false,
      success: defaults.success !== false,
      acquired: defaults.acquired === true,
      assessed: defaults.assessed === true,
      verified: defaults.verified === true,
      independent: defaults.independent === true,
      criterionId: defaults.criterionId || null,
      evidenceId: defaults.evidenceId || null,
      verifier: defaults.verifier || null,
      snapshot: defaults.snapshot || null,
      artifactRef: defaults.artifactRef || null,
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const kind = String(value.kind || defaults.kind || 'test').trim().toLowerCase();
  if (!EVIDENCE_KINDS.includes(kind)) return null;

  const exitCode = value.exitCode == null ? null : Number(value.exitCode);
  const success =
    value.success === true ||
    value.passed === true ||
    (Number.isInteger(exitCode) && exitCode === 0);
  const verified = value.verified === true || defaults.verified === true;
  const assessed = verified || value.assessed === true || defaults.assessed === true;

  return {
    kind,
    source: String(value.source || value.evidence || defaults.source || '').trim(),
    fresh: value.fresh !== false && defaults.fresh !== false,
    success,
    acquired: value.acquired === true || defaults.acquired === true,
    assessed,
    verified,
    independent: value.independent === true || defaults.independent === true,
    criterionId: value.criterionId || defaults.criterionId || null,
    evidenceId: value.evidenceId || value.id || defaults.evidenceId || null,
    verifier: value.verifier || defaults.verifier || null,
    snapshot: value.snapshot || defaults.snapshot || null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    artifactRef: value.artifactRef || defaults.artifactRef || null,
    stdout: typeof value.stdout === 'string' ? value.stdout : undefined,
    stderr: typeof value.stderr === 'string' ? value.stderr : undefined,
  };
}

export function assessEvidence(evidence = [], assessment = {}, defaults = {}) {
  const normalized = flattenEvidence(evidence);
  const evidenceIds = new Set(
    (assessment.evidenceIds || assessment.consumedEvidenceIds || [])
      .map(String)
      .filter(Boolean)
  );
  const criterionId = assessment.criterionId || defaults.criterionId || null;
  const kind = normalizeRequiredKind(assessment.kind || defaults.kind);
  const verified = assessment.verified === true;
  const verifier = assessment.verifier || defaults.verifier || null;
  const snapshot = assessment.snapshot || defaults.snapshot || null;

  return normalized.map((entry) => {
    const idMatch = evidenceIds.size > 0 && entry.evidenceId && evidenceIds.has(String(entry.evidenceId));
    const fallbackMatch =
      evidenceIds.size === 0 &&
      entry.acquired !== true &&
      criterionId &&
      entry.criterionId === criterionId &&
      (!kind || entry.kind === kind);

    if (!idMatch && !fallbackMatch) return entry;

    return {
      ...entry,
      assessed: true,
      verified,
      verifier,
      independent: assessment.independent === true || entry.independent === true,
      snapshot: snapshot || entry.snapshot || null,
    };
  });
}

export function findProofGaps(input = {}) {
  const policy = input.policy || resolveEvidencePolicy(input);
  const trace = Array.isArray(input.trace) ? input.trace : [];
  const evidence = flattenEvidence(input.evidence || []);
  const requiredProofByCriterion = input.requiredProofByCriterion || {};
  const expectedSnapshot = input.snapshot || null;
  const gaps = [];

  for (const item of trace) {
    if (!item?.id) continue;
    const requiredKind = normalizeRequiredKind(
      requiredProofByCriterion[item.id] ??
      requiredProofByCriterion[item.criterion]
    );
    if (!requiredKind) continue;

    const matching = evidence.filter((entry) =>
      entry &&
      entry.criterionId === item.id &&
      entry.kind === requiredKind &&
      entry.success === true &&
      entry.assessed === true &&
      entry.verified === true &&
      (!policy.requireFresh || entry.fresh === true) &&
      (!expectedSnapshot || entry.snapshot === expectedSnapshot)
    );

    if (!matching.length) {
      gaps.push({
        criterionId: item.id,
        requiredKind,
        reason: 'required ' + requiredKind + ' proof is missing or not verifier-assessed',
      });
    }
  }

  for (const requiredKind of policy.requiredKinds) {
    const found = evidence.some((entry) =>
      entry?.kind === requiredKind &&
      entry.success === true &&
      entry.assessed === true &&
      entry.verified === true &&
      (!policy.requireFresh || entry.fresh === true) &&
      (!expectedSnapshot || entry.snapshot === expectedSnapshot)
    );
    if (!found) {
      gaps.push({
        criterionId: null,
        requiredKind,
        reason: 'required ' + requiredKind + ' evidence is missing or not verifier-assessed',
      });
    }
  }

  return dedupeProofGaps(gaps);
}

export function evaluateCompletionGate(input = {}) {
  const tier = Math.max(0, Math.min(3, Number(input.tier ?? 1)));
  const policy = resolveEvidencePolicy({
    tier,
    runtimeInteractionRequired: input.runtimeInteractionRequired,
    requiredKinds: input.requiredKinds,
  });
  const report = input.report || {};
  const expectedSnapshot = input.snapshot || report.snapshot || null;
  const runtimeEvidence = flattenEvidence(
    input.evidence ||
    report.runtimeEvidence ||
    report.evidence ||
    []
  );

  if (tier === 0) {
    const minimal = normalizeEvidence(
      report.lightweightVerificationEvidence || runtimeEvidence[0],
      { kind: 'test', fresh: true }
    );
    const pass = Boolean(minimal?.fresh && minimal?.success);
    return {
      pass,
      verdict: pass ? 'PASS' : 'FAIL',
      reason: pass ? null : 'PROOF_GAP',
      evidencePolicy: policy,
      proofGaps: pass
        ? []
        : [{ criterionId: null, requiredKind: minimal?.kind || 'test', reason: 'fresh lightweight evidence is missing' }],
      verification: null,
      independentVerification: null,
    };
  }

  const verification = evaluateVerificationReport(report);
  const proofGaps = findProofGaps({
    policy,
    trace: verification.acceptance.items,
    evidence: runtimeEvidence,
    requiredProofByCriterion: input.requiredProofByCriterion,
    snapshot: expectedSnapshot,
  });
  const independentVerification = evaluateIndependentCoverage({
    required: policy.requireIndependent,
    trace: verification.acceptance.items,
    evidence: runtimeEvidence,
    metadata: report.independentVerification,
    snapshot: expectedSnapshot,
  });

  if (!independentVerification.pass) {
    proofGaps.push({
      criterionId: null,
      requiredKind: 'review',
      reason: independentVerification.reason,
    });
  }

  const pass = verification.pass && proofGaps.length === 0;
  const missingProofOnly =
    !pass &&
    proofGaps.length > 0 &&
    verification.gaps.every((gap) => gap === 'acceptance-trace' || gap === 'fresh-test-output');

  return {
    pass,
    verdict: pass ? 'PASS' : 'FAIL',
    reason: pass ? null : (missingProofOnly ? 'PROOF_GAP' : 'FAILURE'),
    evidencePolicy: policy,
    proofGaps: dedupeProofGaps(proofGaps),
    verification,
    independentVerification,
  };
}

function evaluateIndependentCoverage({ required, trace, evidence, metadata, snapshot }) {
  if (!required) return { pass: true, mode: 'not-required', reason: null };

  const requiredIds = trace.map((item) => item.id).filter(Boolean);
  if (!requiredIds.length) {
    return {
      pass: false,
      mode: null,
      reason: 'independent verification cannot cover an empty acceptance trace',
    };
  }

  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const covered = new Set((metadata.coveredCriteria || []).map(String));
    const coverageComplete = requiredIds.every((id) => covered.has(id));
    const fresh = metadata.fresh === true;
    const verifier = String(metadata.verifiedBy || '').trim();
    const snapshotMatches = !snapshot || metadata.snapshot === snapshot;

    if (coverageComplete && fresh && verifier && snapshotMatches) {
      return {
        pass: true,
        mode: 'final-verifier-coverage',
        verifiedBy: verifier,
        coveredCriteria: requiredIds,
        snapshot: metadata.snapshot || null,
        reason: null,
      };
    }
  }

  const criterionCoverage = requiredIds.every((id) =>
    evidence.some((entry) =>
      entry?.criterionId === id &&
      entry.independent === true &&
      entry.assessed === true &&
      entry.verified === true &&
      entry.fresh === true &&
      (!snapshot || entry.snapshot === snapshot)
    )
  );

  if (criterionCoverage) {
    return {
      pass: true,
      mode: 'criterion-level',
      coveredCriteria: requiredIds,
      snapshot: snapshot || null,
      reason: null,
    };
  }

  return {
    pass: false,
    mode: null,
    reason: snapshot
      ? 'independent verification must cover every acceptance criterion on snapshot ' + snapshot
      : 'independent verification must cover every acceptance criterion',
  };
}

function flattenEvidence(value) {
  const items = Array.isArray(value) ? value : Object.values(value || {});
  const flattened = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      flattened.push(...flattenEvidence(item));
      continue;
    }
    const normalized = normalizeEvidence(item);
    if (normalized) flattened.push(normalized);
  }
  return flattened;
}

function normalizeRequiredKind(value) {
  if (value == null || value === '') return null;
  const kind = String(value).trim().toLowerCase();
  return EVIDENCE_KINDS.includes(kind) ? kind : null;
}

function uniqueEvidenceKinds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(normalizeRequiredKind)
      .filter(Boolean)
  )];
}

function dedupeProofGaps(gaps) {
  const seen = new Set();
  return gaps.filter((gap) => {
    const key = [gap.criterionId || '', gap.requiredKind || '', gap.reason || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
