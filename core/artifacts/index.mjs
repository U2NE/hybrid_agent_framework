import { promises as fs } from 'node:fs';
import path from 'node:path';

export function phaseDirectory(projectRoot, phaseId) {
  const slug = sanitizePhaseId(phaseId);
  return path.join(path.resolve(projectRoot), '.planning', 'phases', slug);
}

export async function writePhaseArtifact(projectRoot, phaseId, name, content) {
  const allowed = new Set([
    'SPEC.md',
    'RESEARCH.md',
    'PLAN.md',
    'IMPLEMENTATION.md',
    'VERIFICATION.md',
    'SUMMARY.md',
    'HANDOFF.md',
  ]);
  if (!allowed.has(name)) throw new Error('unsupported phase artifact: ' + name);

  const dir = phaseDirectory(projectRoot, phaseId);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await atomicWrite(target, String(content));
  return target;
}

export function renderSpec(spec) {
  return [
    '# SPEC',
    '',
    section('Goal', spec.goal),
    section('Topology', renderTopology(spec.topology)),
    section('Constraints', bullets(spec.constraints)),
    section('Non-goals', bullets(spec.nonGoals)),
    section('Acceptance Criteria', bullets(spec.acceptanceCriteria)),
    section('Resolved assumptions', bullets(spec.resolvedAssumptions)),
    section('Technical context', bullets(spec.technicalContext)),
    section('Relevant code', bullets(spec.relevantCode)),
    section('Edge cases', bullets(spec.edgeCases)),
    ...(spec.clarification ? [section('Clarification provenance', renderClarification(spec.clarification))] : []),
  ].join('\n').trimEnd() + '\n';
}

export function renderHandoff(handoff) {
  return [
    '# Handoff',
    '',
    section('Decided', bullets(handoff.decided)),
    section('Rejected', bullets(handoff.rejected)),
    section('Risks', bullets(handoff.risks)),
    section('Files', bullets(handoff.files)),
    section('Remaining', bullets(handoff.remaining)),
  ].join('\n').trimEnd() + '\n';
}

async function atomicWrite(target, content) {
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, target);
}

function sanitizePhaseId(value) {
  const phase = String(value || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(phase)) {
    throw new Error('unsafe phase id');
  }
  return phase;
}

function section(title, content) {
  return '## ' + title + '\n\n' + (content || '(none)') + '\n';
}

function bullets(values) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  return list.length ? list.map((x) => '- ' + String(x)).join('\n') : '(none)';
}

function renderClarification(value) {
  const lines = [
    '- Final ambiguity: ' + value.finalAmbiguity,
    '- Threshold: ' + value.threshold,
    '- Threshold source: ' + (value.thresholdSource || 'unknown'),
    '- Round count: ' + (value.roundCount ?? 0),
    '- Completion: ' + (value.completion || 'unknown'),
    '- Pass: ' + String(value.pass === true),
    '- Approval: ' + (value.approvalStatus || 'pending'),
  ];
  if (Array.isArray(value.deferredComponents) && value.deferredComponents.length) {
    lines.push('- Deferred components: ' + value.deferredComponents.map((x) => x.component_id || x.id).join(', '));
  }
  return lines.join('\n');
}

function renderTopology(topology) {
  const list = Array.isArray(topology) ? topology : [];
  if (!list.length) return '(none)';
  return list.map((component, index) => {
    const status = component.status ? ' [' + component.status + ']' : '';
    return (index + 1) + '. ' + (component.name || component.id || 'component') + status +
      (component.description ? ': ' + component.description : '');
  }).join('\n');
}
