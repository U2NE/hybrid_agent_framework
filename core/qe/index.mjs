import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeEvidence } from '../verification/index.mjs';

const execFileAsync = promisify(execFile);
export const PROOF_KIND_ORDER = Object.freeze([
  'test',
  'build',
  'typecheck',
  'lint',
  'cli',
  'http',
  'browser',
]);

export function selectProofAcquisition(gap = {}, options = {}) {
  let requiredKind = String(gap.requiredKind || '').trim().toLowerCase();

  if (!requiredKind && Array.isArray(gap.adequateKinds)) {
    const candidates = [...new Set(gap.adequateKinds.map((kind) => String(kind).trim().toLowerCase()))]
      .sort((a, b) => proofRank(a) - proofRank(b));
    let firstUnavailable = null;
    for (const candidate of candidates) {
      const selection = selectProofAcquisition(
        { ...gap, requiredKind: candidate, adequateKinds: undefined },
        options
      );
      if (selection.available) return selection;
      if (!firstUnavailable) firstUnavailable = selection;
    }
    return firstUnavailable || {
      available: false,
      requiredKind: '',
      adapter: null,
      reason: 'unsupported-proof-kind',
    };
  }

  if (!PROOF_KIND_ORDER.includes(requiredKind) && requiredKind !== 'review') {
    return {
      available: false,
      requiredKind,
      adapter: null,
      reason: 'unsupported-proof-kind',
    };
  }

  if (requiredKind === 'browser') {
    return options.browserProvider
      ? { available: true, requiredKind, adapter: 'browser' }
      : { available: false, requiredKind, adapter: 'browser', reason: 'browser-provider-unavailable' };
  }

  if (requiredKind === 'http') {
    return gap.url
      ? { available: true, requiredKind, adapter: 'http' }
      : { available: false, requiredKind, adapter: 'http', reason: 'http-endpoint-unavailable' };
  }

  if (requiredKind === 'review') {
    return {
      available: false,
      requiredKind,
      adapter: null,
      reason: 'review-proof-requires-existing-independent-review',
    };
  }

  const command = normalizeCommand(gap.command);
  return command
    ? { available: true, requiredKind, adapter: 'process', command }
    : { available: false, requiredKind, adapter: 'process', reason: 'proof-command-unavailable' };
}

export async function acquireProof(gap = {}, options = {}) {
  const selection = selectProofAcquisition(gap, options);
  if (!selection.available) {
    return {
      acquired: false,
      available: false,
      gap,
      selection,
      evidence: null,
      reason: selection.reason,
    };
  }

  if (selection.adapter === 'process') {
    const timeoutMs = boundedTimeout(options.timeoutMs);
    const [file, ...args] = selection.command;
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: options.env || process.env,
      });
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence: createRawEvidence({
          kind: selection.requiredKind,
          source: selection.command.join(' '),
          fresh: true,
          success: true,
          exitCode: 0,
          stdout,
          stderr,
          criterionId: gap.criterionId || null,
          artifactRef: null,
        }),
      };
    } catch (error) {
      const exitCode = Number.isInteger(error.code) ? error.code : null;
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence: createRawEvidence({
          kind: selection.requiredKind,
          source: selection.command.join(' '),
          fresh: true,
          success: false,
          exitCode,
          stdout: String(error.stdout || ''),
          stderr: String(error.stderr || error.message || ''),
          criterionId: gap.criterionId || null,
          artifactRef: null,
        }),
      };
    }
  }

  if (selection.adapter === 'http') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedTimeout(options.timeoutMs));
    try {
      const response = await fetch(gap.url, {
        method: gap.method || 'GET',
        headers: gap.headers,
        body: gap.body,
        signal: controller.signal,
      });
      const body = await response.text();
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence: createRawEvidence({
          kind: 'http',
          source: String(gap.url),
          fresh: true,
          success: response.ok,
          exitCode: response.status,
          stdout: body,
          stderr: '',
          criterionId: gap.criterionId || null,
        }),
      };
    } catch (error) {
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence: createRawEvidence({
          kind: 'http',
          source: String(gap.url),
          fresh: true,
          success: false,
          stderr: String(error?.message || error),
          criterionId: gap.criterionId || null,
        }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (selection.adapter === 'browser') {
    try {
      const result = await options.browserProvider({
        gap,
        timeoutMs: boundedTimeout(options.timeoutMs),
      });
      const evidence = createRawEvidence({
        kind: 'browser',
        source: result?.source || 'configured-browser-provider',
        fresh: true,
        success: result?.success === true,
        criterionId: gap.criterionId || null,
        artifactRef: result?.artifactRef || null,
        stdout: result?.summary || '',
      });
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence,
      };
    } catch (error) {
      return {
        acquired: true,
        available: true,
        gap,
        selection,
        evidence: createRawEvidence({
          kind: 'browser',
          source: 'configured-browser-provider',
          fresh: true,
          success: false,
          criterionId: gap.criterionId || null,
          stderr: String(error?.message || error),
        }),
      };
    }
  }

  return {
    acquired: false,
    available: false,
    gap,
    selection,
    evidence: null,
    reason: 'proof-acquisition-unavailable',
  };
}

export async function acquireProofGaps(gaps = [], options = {}) {
  const results = [];
  for (const gap of gaps) {
    results.push(await acquireProof(gap, options));
  }
  return results;
}

export function mergeAcquiredEvidence(existing = [], acquisitions = []) {
  const evidence = Array.isArray(existing) ? [...existing] : [];
  for (const acquisition of acquisitions) {
    if (acquisition?.evidence) evidence.push(acquisition.evidence);
  }
  return evidence;
}


function createRawEvidence(value) {
  const evidenceId = createHash('sha256')
    .update(JSON.stringify({
      kind: value.kind || null,
      source: value.source || null,
      criterionId: value.criterionId || null,
      exitCode: value.exitCode ?? null,
      stdout: value.stdout || '',
      stderr: value.stderr || '',
      artifactRef: value.artifactRef || null,
    }))
    .digest('hex');

  return normalizeEvidence({
    ...value,
    evidenceId,
    acquired: true,
    assessed: false,
    verified: false,
  });
}

function proofRank(kind) {
  if (kind === 'review') return PROOF_KIND_ORDER.length + 1;
  const index = PROOF_KIND_ORDER.indexOf(kind);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeCommand(value) {
  if (Array.isArray(value) && value.length) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    throw new TypeError('proof command must be an argv array, not a shell string');
  }
  return null;
}

function boundedTimeout(value) {
  const timeout = Number(value || 15000);
  if (!Number.isFinite(timeout) || timeout <= 0) return 15000;
  return Math.min(Math.max(Math.floor(timeout), 100), 60000);
}
