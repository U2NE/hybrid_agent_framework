import { createHash } from 'node:crypto';
import { buildWorkerContext } from '../context/index.mjs';
import { resolveRoleRouting } from '../routing/index.mjs';
import { runFixLoop } from '../verification/index.mjs';

export const MAX_REPAIR_CYCLES = 3;

export function normalizeFinding(finding = {}) {
  const severity = String(finding.severity || 'medium').trim().toLowerCase();
  const category = String(finding.category || finding.code || 'correctness').trim().toLowerCase();
  const criterionId = finding.criterionId || finding.acceptanceCriterionId || null;
  const criterion = String(finding.criterion || finding.acceptanceCriterion || '').trim();
  const file = String(finding.file || finding.path || '').trim();
  const symbol = String(finding.symbol || '').trim();
  const evidence = String(finding.evidence || finding.failure || finding.message || '').trim();
  const expectedBehavior = String(finding.expectedBehavior || finding.expected || '').trim();
  const verification = String(finding.requiredVerification || finding.verify || '').trim();

  let correctnessImpact;
  if (finding.correctnessImpact === true) correctnessImpact = true;
  else if (finding.correctnessImpact === false) correctnessImpact = false;
  else if (finding.acceptanceFailure === true) correctnessImpact = true;
  else {
    correctnessImpact =
      /\b(?:correctness|incorrect|wrong|fail(?:ed|ure)?|throw|crash|regression|security)\b/i.test(
        [category, evidence].join(' ')
      );
  }

  return {
    severity,
    category,
    criterionId,
    criterion,
    file,
    symbol,
    evidence,
    expectedBehavior,
    requiredVerification: verification,
    acceptanceFailure: finding.acceptanceFailure === true,
    correctnessImpact,
  };
}

export function shouldTriggerRepair(finding = {}) {
  const normalized = normalizeFinding(finding);
  if (['blocker', 'critical', 'high'].includes(normalized.severity)) return true;
  if (normalized.acceptanceFailure) return true;
  if (normalized.severity === 'medium') return normalized.correctnessImpact === true;
  return false;
}

export function findingFingerprint(finding = {}) {
  const normalized = normalizeFinding(finding);
  const signature = [
    normalized.category,
    normalized.criterionId || normalized.criterion,
    normalized.file,
    normalized.symbol,
    normalizeFailureSignature(normalized.evidence),
  ].join('|');
  return createHash('sha256').update(signature).digest('hex');
}

export function buildRepairPacket(finding, task = {}, options = {}) {
  const normalized = normalizeFinding(finding);
  const relevantFiles = [
    normalized.file,
    ...(task.relevantFiles || task.files_modified || []),
  ].filter(Boolean);
  const acceptanceCriteria = [
    normalized.criterion,
    ...(task.acceptance_criteria || task.acceptanceCriteria || []),
  ].filter(Boolean);
  const requiredVerification = [
    normalized.requiredVerification,
    ...(task.requiredVerification || (task.verify ? [task.verify] : [])),
  ].filter(Boolean);

  const context = buildWorkerContext({
    goal:
      normalized.expectedBehavior ||
      task.goal ||
      'Repair the verified blocking finding without expanding scope.',
    acceptanceCriteria,
    constraints: task.constraints || options.constraints || [],
    relevantFiles,
    relevantInterfaces: [
      normalized.symbol,
      ...(task.relevantInterfaces || []),
    ].filter(Boolean),
    depends_on: task.depends_on || task.dependencies || [],
    decisions: task.decisions || options.decisions || [],
    requiredVerification,
    dependencyOutputs: options.relevantDependencyOutputs || {},
  }, {
    budgetChars: options.budgetChars,
    decisions: options.decisions,
    requiredVerification,
  });

  return {
    schema: 'hybrid-repair-packet/v1',
    owner: options.owner || task.owner || 'implementer',
    finding: normalized,
    fingerprint: findingFingerprint(normalized),
    context,
  };
}

export async function runRepairConvergence(options = {}) {
  if (typeof options.reviewSnapshot !== 'function') {
    throw new TypeError('reviewSnapshot must be a function');
  }
  if (typeof options.verifySnapshot !== 'function') {
    throw new TypeError('verifySnapshot must be a function');
  }
  if (typeof options.repairImplementation !== 'function') {
    throw new TypeError('repairImplementation must be a function');
  }

  const maxIterations = Number.isInteger(options.maxIterations)
    ? options.maxIterations
    : MAX_REPAIR_CYCLES;
  if (maxIterations < 0 || maxIterations > MAX_REPAIR_CYCLES) {
    throw new TypeError('maxIterations must be between 0 and ' + MAX_REPAIR_CYCLES);
  }

  let snapshot = options.snapshot ?? null;
  const fingerprints = [];
  const repairHistory = [];

  const result = await runFixLoop({
    maxIterations,
    verify: async ({ attempt }) => {
      const qa = await options.reviewSnapshot({ attempt, snapshot });
      const qaFindings = (Array.isArray(qa?.findings) ? qa.findings : [])
        .map(normalizeFinding);
      const qaRepairable = qaFindings.filter(shouldTriggerRepair);

      // A blocking independent QA finding already justifies repair. Avoid an
      // extra verifier/model call until the impacted QA lanes are clean.
      if (qaRepairable.length > 0) {
        return {
          ok: false,
          snapshot,
          qa,
          verification: {
            ok: false,
            skipped: true,
            reason: 'blocking-qa-finding',
            findings: [],
          },
          findings: qaFindings,
          repairable: qaRepairable,
        };
      }

      const verification = await options.verifySnapshot({ attempt, snapshot, qa });
      const findings = [
        ...qaFindings,
        ...(Array.isArray(verification?.findings) ? verification.findings : [])
          .map(normalizeFinding),
      ];
      const repairable = findings.filter(shouldTriggerRepair);

      return {
        ok: qa?.ok !== false && verification?.ok === true && repairable.length === 0,
        snapshot,
        qa,
        verification,
        findings,
        repairable,
      };
    },
    fix: async ({ attempt, verification }) => {
      const finding = verification?.repairable?.[0];
      if (!finding) {
        return {
          changed: false,
          blocked: true,
          reason: 'verification failed without a repairable finding',
        };
      }

      const fingerprint = findingFingerprint(finding);
      const repeatedSameFailure = fingerprints.includes(fingerprint);
      fingerprints.push(fingerprint);
      const route = resolveRoleRouting('implementer', {
        ...(options.routingOptions || {}),
        context: {
          ...(options.routingContext || {}),
          verificationFailures: attempt,
          repeatedSameFailure,
          lunaExhausted:
            repeatedSameFailure && attempt >= MAX_REPAIR_CYCLES,
          lunaMaxFailed:
            repeatedSameFailure && attempt >= MAX_REPAIR_CYCLES,
        },
      });
      const packet = buildRepairPacket(
        finding,
        options.task || {},
        {
          ...(options.contextOptions || {}),
          owner: options.owner || options.task?.owner || 'implementer',
        }
      );
      const repair = await options.repairImplementation({
        attempt,
        snapshot,
        packet,
        route,
        owner: packet.owner,
        repeatedSameFailure,
      });

      if (repair?.snapshot !== undefined) snapshot = repair.snapshot;
      repairHistory.push({
        attempt,
        fingerprint,
        repeatedSameFailure,
        route,
        owner: packet.owner,
        packet,
        repair,
      });
      return repair;
    },
  });

  return {
    ...result,
    snapshot,
    repairs: repairHistory,
    fingerprints,
  };
}

function normalizeFailureSignature(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}
