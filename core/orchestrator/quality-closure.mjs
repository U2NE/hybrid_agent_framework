import { buildWorkerContextWithCache } from '../context/index.mjs';
import { appendRuntimeEvent } from '../observability/index.mjs';
import { acquireProofGaps, mergeAcquiredEvidence } from '../qe/index.mjs';
import { runRepairConvergence, shouldTriggerRepair } from '../repair/index.mjs';
import {
  assessEvidence,
  evaluateCompletionGate,
  normalizeEvidence,
} from '../verification/index.mjs';

export async function runQualityClosure(options = {}) {
  if (typeof options.qa !== 'function') throw new TypeError('qa must be a function');
  if (typeof options.verifier !== 'function') throw new TypeError('verifier must be a function');

  const tier = Math.max(0, Math.min(3, Number(options.tier ?? 1)));
  const task = options.task || {};
  const repoRoot = options.repoRoot || options.context?.repoRoot || '.';
  const runId = options.runId || 'quality-closure';
  const taskId = options.taskId || task.id || null;
  const logger = options.appendRuntimeEvent || appendRuntimeEvent;
  const events = [];
  let runtimeEvidence = normalizeEvidenceList(options.evidence || []);
  let currentSnapshot = options.snapshot ?? null;
  let lastQa = null;
  let acquisitions = [];
  const gates = [];

  const contextBundle = await buildWorkerContextWithCache(task, {
    ...(options.context || {}),
    tier,
    repoRoot,
    reuseSharedContext: options.context?.reuseSharedContext === true,
    reuseCount: Number(options.context?.reuseCount || 0),
  });

  if (contextBundle.cacheUsed) {
    await emit('context-cache', {
      outcome: contextBundle.cacheError ? 'fallback' : (contextBundle.cacheHit ? 'hit' : 'miss'),
      cacheHit: contextBundle.cacheHit,
      cacheError: contextBundle.cacheError,
      cachePath: contextBundle.cachePath,
    });
  }

  const repairImplementation = typeof options.repairImplementation === 'function'
    ? options.repairImplementation
    : async () => ({
        changed: false,
        blocked: true,
        reason: 'repair implementation is unavailable',
      });

  const convergence = await runRepairConvergence({
    snapshot: currentSnapshot,
    task,
    owner: options.owner || task.owner || 'implementer',
    maxIterations: options.maxRepairIterations,
    routingOptions: options.routingOptions,
    routingContext: options.routingContext,
    contextOptions: options.repairContextOptions,
    reviewSnapshot: async ({ attempt, snapshot }) => {
      const startedAt = Date.now();
      await emit('qa', { lifecycle: 'start', attempt, snapshot, startedAt });
      const qa = await options.qa({
        attempt,
        snapshot,
        evidence: runtimeEvidence,
        context: contextBundle.context,
        sharedContext: contextBundle.sharedSnapshot?.shared || null,
        cache: summarizeCache(contextBundle),
      });
      const endedAt = Date.now();
      lastQa = qa;
      await emit('qa', {
        lifecycle: 'end',
        attempt,
        snapshot,
        startedAt,
        endedAt,
        outcome: qa?.ok === false ? 'fail' : 'pass',
        failureReason: summarizeFindings(qa?.findings),
      });
      return qa;
    },
    verifySnapshot: async ({ attempt, snapshot, qa }) => {
      const raw = await callVerifier({
        phase: 'verification',
        attempt,
        snapshot,
        qa,
      });

      if (hasProofGapSignal(raw) && !hasRepairableFindings(raw)) {
        return {
          ...raw,
          verifierOk: raw.ok === true,
          ok: true,
          closurePending: 'PROOF_GAP',
        };
      }

      return raw;
    },
    repairImplementation: async (repairInput) => {
      const startedAt = Date.now();
      await emit('repair', {
        lifecycle: 'start',
        attempt: repairInput.attempt,
        snapshot: repairInput.snapshot,
        startedAt,
        fingerprint: repairInput.packet?.fingerprint || null,
      });
      const result = await repairImplementation({
        ...repairInput,
        context: contextBundle.context,
        sharedContext: contextBundle.sharedSnapshot?.shared || null,
      });
      const endedAt = Date.now();
      await emit('repair', {
        lifecycle: 'end',
        attempt: repairInput.attempt,
        snapshot: repairInput.snapshot,
        nextSnapshot: result?.snapshot ?? repairInput.snapshot,
        startedAt,
        endedAt,
        outcome: result?.changed === true ? 'changed' : 'blocked',
        failureReason: result?.reason || null,
      });
      return result;
    },
  });

  currentSnapshot = convergence.snapshot ?? currentSnapshot;
  const convergenceVerification = lastConvergenceVerification(convergence);
  if (!convergence.ok && !convergenceVerification) {
    const result = {
      pass: false,
      verdict: 'FAIL',
      reason: convergence.reason || 'REPAIR_BLOCKED',
      snapshot: currentSnapshot,
      convergence,
      evidence: runtimeEvidence,
      cache: summarizeCache(contextBundle),
      events,
      completion: null,
      gates,
    };
    await emit('completion', {
      outcome: 'fail',
      snapshot: currentSnapshot,
      failureReason: result.reason,
    });
    return result;
  }

  let verifierResult = convergenceVerification;
  if (!verifierResult) {
    verifierResult = await callVerifier({
      phase: 'verification',
      attempt: convergence.attempts || 0,
      snapshot: currentSnapshot,
      qa: lastQa,
    });
  }

  let completion = evaluateGate(verifierResult, 'pre-proof');

  if (completion.pass) {
    const result = buildResult('PASS', null, completion, verifierResult);
    await emit('completion', {
      outcome: 'pass',
      snapshot: currentSnapshot,
      evidenceRefs: runtimeEvidence.map((entry) => entry.evidenceId).filter(Boolean),
    });
    return result;
  }

  if (completion.reason !== 'PROOF_GAP' && !hasProofGapSignal(verifierResult)) {
    const result = buildResult('FAIL', completion.reason || 'FAILURE', completion, verifierResult);
    await emit('completion', {
      outcome: 'fail',
      snapshot: currentSnapshot,
      failureReason: result.reason,
    });
    return result;
  }

  const acquisitionGaps = completion.proofGaps
    .filter((gap) => gap.requiredKind && gap.requiredKind !== 'review')
    .map((gap) => ({
      ...gap,
      ...resolveProofRequest(gap, options.proofRequests || {}),
      snapshot: currentSnapshot,
    }));

  if (!acquisitionGaps.length) {
    const result = buildResult('FAIL', 'PROOF_GAP', completion, verifierResult);
    await emit('completion', {
      outcome: 'fail',
      snapshot: currentSnapshot,
      failureReason: 'proof gap has no acquirable deterministic proof',
    });
    return result;
  }

  const proofStartedAt = Date.now();
  await emit('proof-acquisition', {
    lifecycle: 'start',
    snapshot: currentSnapshot,
    startedAt: proofStartedAt,
    criteria: acquisitionGaps.map((gap) => gap.criterionId).filter(Boolean),
  });

  if (typeof options.proofAcquisition === 'function') {
    acquisitions = await options.proofAcquisition({
      gaps: acquisitionGaps,
      snapshot: currentSnapshot,
      evidence: runtimeEvidence,
      context: contextBundle.context,
      sharedContext: contextBundle.sharedSnapshot?.shared || null,
    });
  } else {
    acquisitions = await acquireProofGaps(acquisitionGaps, {
      ...(options.proofOptions || {}),
      cwd: options.proofOptions?.cwd || repoRoot,
    });
  }
  acquisitions = Array.isArray(acquisitions) ? acquisitions : [];

  runtimeEvidence = mergeAcquiredEvidence(runtimeEvidence, acquisitions);
  const proofEndedAt = Date.now();
  await emit('proof-acquisition', {
    lifecycle: 'end',
    snapshot: currentSnapshot,
    startedAt: proofStartedAt,
    endedAt: proofEndedAt,
    outcome: acquisitions.every((item) => item?.acquired === true) ? 'acquired' : 'partial',
    evidenceRefs: acquisitions.map((item) => item?.evidence?.evidenceId).filter(Boolean),
  });

  // Raw acquisition is deliberately not a completion check. The verifier must
  // semantically assess the exact acquired evidence before the gate runs again.
  verifierResult = await callVerifier({
    phase: 'proof-reassessment',
    attempt: (convergence.attempts || 0) + 1,
    snapshot: currentSnapshot,
    qa: lastQa,
  });

  completion = evaluateGate(verifierResult, 'post-proof');
  const result = buildResult(
    completion.pass ? 'PASS' : 'FAIL',
    completion.pass ? null : (completion.reason || 'FAILURE'),
    completion,
    verifierResult
  );

  await emit('completion', {
    outcome: completion.pass ? 'pass' : 'fail',
    snapshot: currentSnapshot,
    failureReason: result.reason,
    evidenceRefs: runtimeEvidence.map((entry) => entry.evidenceId).filter(Boolean),
  });

  return result;

  async function callVerifier({ phase, attempt, snapshot, qa }) {
    const startedAt = Date.now();
    await emit('verifier', { lifecycle: 'start', phase, attempt, snapshot, startedAt });

    const raw = await options.verifier({
      phase,
      attempt,
      snapshot,
      qa,
      evidence: runtimeEvidence,
      context: contextBundle.context,
      sharedContext: contextBundle.sharedSnapshot?.shared || null,
      cache: summarizeCache(contextBundle),
    });

    if (!raw || typeof raw !== 'object') {
      throw new TypeError('verifier must return an object');
    }

    const assessments = Array.isArray(raw.assessments) ? raw.assessments : [];
    for (const assessment of assessments) {
      runtimeEvidence = assessEvidence(runtimeEvidence, assessment, {
        verifier: raw.verifiedBy || 'verifier',
        snapshot,
      });
    }

    const report = {
      ...(raw.report || {}),
      snapshot,
    };
    if (raw.independentVerification && report.independentVerification == null) {
      report.independentVerification = raw.independentVerification;
    }

    const endedAt = Date.now();
    await emit('verifier', {
      lifecycle: 'end',
      phase,
      attempt,
      snapshot,
      startedAt,
      endedAt,
      outcome: raw.ok === true ? 'pass' : (hasProofGapSignal(raw) ? 'proof-gap' : 'fail'),
      failureReason: raw.reason || summarizeFindings(raw.findings),
      evidenceRefs: assessments.flatMap((item) => item.evidenceIds || item.consumedEvidenceIds || []),
    });

    return {
      ...raw,
      report,
      snapshot,
    };
  }

  function evaluateGate(verificationResult, phase) {
    let gate;
    if (!verificationResult?.report) {
      gate = {
        pass: false,
        verdict: 'FAIL',
        reason: 'FAILURE',
        proofGaps: [],
        verification: null,
      };
    } else {
      gate = evaluateCompletionGate({
        tier,
        report: verificationResult.report,
        snapshot: currentSnapshot,
        evidence: runtimeEvidence,
        requiredProofByCriterion: options.requiredProofByCriterion,
        requiredKinds: options.requiredKinds,
        runtimeInteractionRequired: options.runtimeInteractionRequired,
      });
    }

    gates.push({
      phase,
      snapshot: currentSnapshot,
      gate,
    });
    return gate;
  }

  function buildResult(verdict, reason, gate, verificationResult) {
    return {
      pass: verdict === 'PASS',
      verdict,
      reason,
      snapshot: currentSnapshot,
      convergence,
      qa: lastQa,
      verifier: verificationResult,
      evidence: runtimeEvidence,
      acquisitions,
      completion: gate,
      gates,
      cache: summarizeCache(contextBundle),
      events,
    };
  }

  async function emit(stage, event = {}) {
    const item = {
      runId,
      taskId,
      stage,
      ...event,
      primitive: 'runQualityClosure',
    };
    events.push(item);
    try {
      await logger({
        repoRoot,
        runId,
        event: item,
      }, {
        runtimeRoot: options.runtimeRoot || options.context?.runtimeRoot,
      });
    } catch {
      // Passive observability must never alter execution semantics.
    }
  }
}

function hasRepairableFindings(result = {}) {
  return (Array.isArray(result.findings) ? result.findings : [])
    .some((finding) => shouldTriggerRepair(finding));
}

function hasProofGapSignal(result = {}) {
  return result.reason === 'PROOF_GAP' ||
    result.closurePending === 'PROOF_GAP' ||
    (Array.isArray(result.proofGaps) && result.proofGaps.length > 0);
}

function lastConvergenceVerification(convergence = {}) {
  const evidence = Array.isArray(convergence.evidence) ? convergence.evidence : [];
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const entry = evidence[index];
    if (entry?.stage === 'verify' && entry?.result?.verification) {
      return entry.result.verification;
    }
  }
  return null;
}

function normalizeEvidenceList(values) {
  const items = Array.isArray(values) ? values : [];
  return items.map((item) => normalizeEvidence(item)).filter(Boolean);
}

function resolveProofRequest(gap, proofRequests) {
  const direct = gap.criterionId ? proofRequests[gap.criterionId] : null;
  const byKind = proofRequests[gap.requiredKind];
  const request = direct || byKind || {};
  return request && typeof request === 'object' && !Array.isArray(request) ? request : {};
}

function summarizeFindings(findings) {
  if (!Array.isArray(findings) || !findings.length) return null;
  return findings
    .slice(0, 3)
    .map((finding) => finding?.evidence || finding?.message || finding?.category || 'finding')
    .join('; ');
}

function summarizeCache(bundle) {
  return {
    used: bundle.cacheUsed === true,
    hit: bundle.cacheHit === true,
    error: bundle.cacheError || null,
    path: bundle.cachePath || null,
    key: bundle.sharedSnapshot?.key || null,
  };
}
