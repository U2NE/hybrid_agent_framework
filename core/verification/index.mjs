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
