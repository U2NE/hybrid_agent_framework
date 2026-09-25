import { createHash } from 'node:crypto';

export const FAILURE_ENVELOPE_SCHEMA = 'hybrid-failure-envelope/v1';

const FAILURE_KINDS = new Set([
  'environment',
  'tool',
  'model-format',
  'localization',
  'specification',
  'implementation',
  'verification',
  'integration',
  'policy',
  'security-reasoning',
  'architecture-reasoning',
]);

const ALWAYS_REASONING = new Set([
  'localization',
  'specification',
  'implementation',
  'verification',
  'security-reasoning',
  'architecture-reasoning',
]);

const NEVER_REASONING = new Set([
  'environment',
  'tool',
  'policy',
]);

export function buildFailureEnvelope(input = {}) {
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!FAILURE_KINDS.has(kind)) {
    throw new TypeError('unsupported failure kind: ' + kind);
  }

  const stage = String(input.stage || 'unknown').trim() || 'unknown';
  const attemptedRoute = nullableString(input.attemptedRoute);
  const targetRole = nullableString(input.targetRole);
  const attempt = positiveInt(input.attempt, 1);
  const sameFailureCount = positiveInt(input.sameFailureCount, 1);
  const semanticProgress = normalizeProgress(input.semanticProgress);
  const reasoningRequired =
    input.reasoningRequired === true ||
    ALWAYS_REASONING.has(kind) ||
    (kind === 'integration' && input.semanticConflict === true);
  const reasoningEscalationEligible =
    !NEVER_REASONING.has(kind) &&
    reasoningRequired &&
    !(kind === 'model-format' && sameFailureCount <= 1) &&
    semanticProgress !== 'new-evidence';

  const fingerprint = input.fingerprint || failureFingerprint({
    kind,
    stage,
    code: input.code ?? null,
    locus: input.locus ?? null,
    evidence: input.evidence ?? null,
    message: normalizeMessage(input.message),
  });

  return {
    schema: FAILURE_ENVELOPE_SCHEMA,
    kind,
    stage,
    attemptedRoute,
    targetRole,
    attempt,
    sameFailureCount,
    semanticProgress,
    reasoningRequired,
    reasoningEscalationEligible,
    retryable: input.retryable !== false,
    fingerprint,
    code: nullableString(input.code),
    locus: nullableString(input.locus),
    recommendedAction: recommendedAction({
      kind,
      sameFailureCount,
      semanticProgress,
      reasoningEscalationEligible,
      retryable: input.retryable !== false,
    }),
  };
}

export function failureNeedsModelEscalation(envelope) {
  return normalizeFailureEnvelope(envelope).reasoningEscalationEligible;
}

export function normalizeFailureEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('failure envelope must be an object');
  }
  if (value.schema === FAILURE_ENVELOPE_SCHEMA) {
    return buildFailureEnvelope(value);
  }
  return buildFailureEnvelope(value);
}

export function failureFingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function recommendedAction({
  kind,
  sameFailureCount,
  semanticProgress,
  reasoningEscalationEligible,
  retryable,
}) {
  if (!retryable) return 'stop';
  if (kind === 'environment') return 'recover-environment';
  if (kind === 'tool') return 'recover-tool';
  if (kind === 'policy') return 'resolve-policy';
  if (kind === 'model-format' && sameFailureCount <= 1) return 'retry-same-route';
  if (semanticProgress === 'new-evidence') return 'retry-targeted-same-route';
  if (reasoningEscalationEligible) return 'escalate-one-rung';
  return 'retry-same-route';
}

function normalizeProgress(value) {
  const progress = String(value || 'none').trim().toLowerCase();
  if (!['none', 'partial', 'new-evidence'].includes(progress)) {
    throw new TypeError('unsupported semantic progress: ' + progress);
  }
  return progress;
}

function normalizeMessage(value) {
  if (value == null) return null;
  return String(value)
    .replace(/\b\d+(?:\.\d+)?\b/g, '#')
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1024);
}

function nullableString(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return text || null;
}

function positiveInt(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(
      (key) => JSON.stringify(key) + ':' + canonical(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
