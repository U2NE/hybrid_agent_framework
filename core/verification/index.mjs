export const SECURITY_TRIGGERS = Object.freeze([
  /(?:^|[^a-z])auth(?:entication)?(?:[^a-z]|$)/i,
  /authori[sz]ation/i,
  /crypto/i,
  /secret/i,
  /payment/i,
  /file[ _-]?upload/i,
  /(?:^|[^a-z])sql(?:[^a-z]|$)/i,
  /network/i,
  /permission/i,
]);

export function requiresSecurityReview(change = {}) {
  if (change.securityRelevant === true) return true;
  const haystack = [
    change.description || '',
    ...(change.files || []),
    ...(change.tags || []),
  ].join(' ').toLowerCase();

  return SECURITY_TRIGGERS.some((trigger) => trigger.test(haystack));
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
