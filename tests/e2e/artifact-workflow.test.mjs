import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPlanDocument, parsePlanDocument, compilePlan, PlanError } from '../../core/planning/index.mjs';
import { buildWorkerContext } from '../../core/context/index.mjs';
import { renderSpec, writePhaseArtifact } from '../../core/artifacts/index.mjs';

const samplePlan = {
  phase: '01-auth',
  tasks: [
    {
      id: 'A',
      goal: 'Add interface',
      files_modified: ['src/api.js'],
      depends_on: [],
      acceptance_criteria: ['interface exists'],
      verify: 'node --test tests/api.test.js',
      owner: 'implementer',
    },
    {
      id: 'B',
      goal: 'Add consumer',
      files_modified: ['src/use.js'],
      depends_on: ['A'],
      acceptance_criteria: ['consumer uses interface'],
      verify: 'node --test tests/use.test.js',
      owner: 'implementer',
    },
  ],
};

test('PLAN.md round-trips one canonical machine block and computes waves', () => {
  const markdown = renderPlanDocument(samplePlan);
  assert.match(markdown, /hybrid-plan:v1/);
  assert.match(markdown, /## Execution Waves/);
  const parsed = parsePlanDocument(markdown);
  assert.deepEqual(parsed.tasks.map((task) => task.id), ['A', 'B']);
  assert.deepEqual(compilePlan(parsed).waveSummary.map((wave) => wave.tasks), [['A'], ['B']]);
});

test('plan rejects missing exact files or verify command', () => {
  assert.throws(
    () => renderPlanDocument({ tasks: [{ id: 'A', goal: 'x', files_modified: [], acceptance_criteria: ['y'], verify: 'x' }] }),
    PlanError
  );
  assert.throws(
    () => renderPlanDocument({ tasks: [{ id: 'A', goal: 'x', files_modified: ['x.js'], acceptance_criteria: ['y'], verify: '' }] }),
    PlanError
  );
});

test('worker context excludes full conversation payloads', () => {
  const context = buildWorkerContext({
    goal: 'Implement A',
    files_modified: ['a.js'],
    acceptance_criteria: ['works'],
    dependencyOutputs: {
      interface: 'export function a() {}',
      conversation: 'huge transcript',
      fullTranscript: 'another transcript',
    },
  });
  assert.equal(context.dependencyOutputs.interface, 'export function a() {}');
  assert.equal('conversation' in context.dependencyOutputs, false);
  assert.equal('fullTranscript' in context.dependencyOutputs, false);
});

test('SPEC renderer includes the required durable fields and artifact writer is atomic-facing', async () => {
  const spec = renderSpec({
    goal: 'Build feature',
    topology: [{ id: 'api', status: 'active' }],
    constraints: ['Node only'],
    nonGoals: ['No UI'],
    acceptanceCriteria: ['passes tests'],
    resolvedAssumptions: ['repo is brownfield'],
    technicalContext: ['ESM'],
    relevantCode: ['src/api.js'],
    edgeCases: ['empty input'],
  });
  for (const heading of ['Goal', 'Topology', 'Constraints', 'Non-goals', 'Acceptance Criteria', 'Resolved assumptions', 'Technical context', 'Relevant code', 'Edge cases']) {
    assert.match(spec, new RegExp('## ' + heading));
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-artifact-'));
  const target = await writePhaseArtifact(root, '01-auth', 'SPEC.md', spec);
  assert.equal(await fs.readFile(target, 'utf8'), spec);
});

test('SPEC renderer preserves clarification provenance without replacing Hybrid sections', () => {
  const spec = renderSpec({
    goal: 'Build login',
    topology: [{ id: 'auth', name: 'Auth', status: 'active' }],
    constraints: ['JWT only'],
    nonGoals: ['No SSO'],
    acceptanceCriteria: ['login succeeds'],
    resolvedAssumptions: ['reuse current middleware'],
    technicalContext: ['brownfield'],
    relevantCode: ['src/auth/'],
    edgeCases: ['expired token'],
    clarification: {
      finalAmbiguity: 0.18,
      threshold: 0.20,
      thresholdSource: 'default',
      roundCount: 4,
      completion: 'spec-ready',
      pass: true,
      approvalStatus: 'pending',
      deferredComponents: [{ component_id: 'recovery' }],
    },
  });

  assert.match(spec, /## Clarification provenance/);
  assert.match(spec, /Final ambiguity: 0.18/);
  assert.match(spec, /Threshold: 0.2/);
  assert.match(spec, /Round count: 4/);
  assert.match(spec, /Deferred components: recovery/);
  assert.match(spec, /## Goal/);
  assert.match(spec, /- Approval: pending/);
});
