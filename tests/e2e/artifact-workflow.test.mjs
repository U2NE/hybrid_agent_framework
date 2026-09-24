import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPlanDocument, parsePlanDocument, compilePlan, PlanError } from '../../core/planning/index.mjs';
import { buildWorkerContext, measureContext, reduceMarkdownArtifact, renderWorkerContext } from '../../core/context/index.mjs';
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


test('markdown-aware context reduction preserves critical late sections instead of raw prefix cutting', () => {
  const markdown = [
    '# Historical Commentary',
    'old '.repeat(3000),
    '',
    '## Implementation Log',
    'routine '.repeat(3000),
    '',
    '## Goal',
    'MUST_KEEP_GOAL',
    '',
    '## Acceptance Criteria',
    '- MUST_KEEP_LAST_CRITERION',
    '',
    '## Constraints',
    '- MUST_KEEP_CONSTRAINT',
    '',
    '## Required Verification',
    '- MUST_KEEP_VERIFY',
  ].join('\n');

  const reduced = reduceMarkdownArtifact(markdown, 1200);
  assert.match(reduced, /MUST_KEEP_GOAL/);
  assert.match(reduced, /MUST_KEEP_LAST_CRITERION/);
  assert.match(reduced, /MUST_KEEP_CONSTRAINT/);
  assert.match(reduced, /MUST_KEEP_VERIFY/);
  assert.match(reduced, /context-reduced/);
});

test('worker context preserves fresh critical contract under an oversized dependency artifact', () => {
  const context = buildWorkerContext({
    goal: 'MUST_KEEP_GOAL',
    files_modified: ['src/api.js'],
    relevantInterfaces: ['ApiContract'],
    depends_on: ['schema'],
    acceptance_criteria: ['MUST_KEEP_ACCEPTANCE'],
    constraints: ['MUST_KEEP_CONSTRAINT'],
    decisions: ['MUST_KEEP_DECISION'],
    verify: 'node --test tests/api.test.js',
    dependencyOutputs: {
      hugeArtifact: [
        '# Old Commentary',
        'noise '.repeat(6000),
        '## Acceptance Criteria',
        '- DEPENDENCY_ACCEPTANCE',
        '## Constraints',
        '- DEPENDENCY_CONSTRAINT',
      ].join('\n'),
      conversation: 'must be removed',
    },
  }, { budgetChars: 1800 });

  const rendered = renderWorkerContext(context);
  for (const marker of [
    'MUST_KEEP_GOAL',
    'MUST_KEEP_ACCEPTANCE',
    'MUST_KEEP_CONSTRAINT',
    'src/api.js',
    'ApiContract',
    'schema',
    'MUST_KEEP_DECISION',
    'node --test tests/api.test.js',
    'DEPENDENCY_ACCEPTANCE',
    'DEPENDENCY_CONSTRAINT',
  ]) {
    assert.ok(rendered.includes(marker), marker);
  }
  assert.doesNotMatch(rendered, /must be removed/);
});

test('worker context rendering has deterministic critical-section ordering and measurable budget metadata', () => {
  const context = buildWorkerContext({
    goal: 'G',
    acceptance_criteria: ['A'],
    constraints: ['C'],
    files_modified: ['f.js'],
    relevantInterfaces: ['I'],
    depends_on: ['D'],
    decisions: ['DEC'],
    verify: 'VERIFY',
  });
  const rendered = renderWorkerContext(context);

  const headings = [
    '## Goal',
    '## Acceptance Criteria',
    '## Constraints',
    '## Relevant Files',
    '## Relevant Interfaces',
    '## Dependencies',
    '## Decisions',
    '## Required Verification',
  ];
  let prior = -1;
  for (const heading of headings) {
    const index = rendered.indexOf(heading);
    assert.ok(index > prior, heading);
    prior = index;
  }

  const measurement = measureContext(context);
  assert.ok(measurement.chars > 0);
  assert.ok(measurement.bytes >= measurement.chars);
  assert.ok(measurement.estimatedTokens > 0);
});
