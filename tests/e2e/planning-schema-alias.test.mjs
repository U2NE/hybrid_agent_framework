import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../core/planning/index.mjs';

function baseTask(overrides = {}) {
  return {
    id: 'task-a',
    goal: 'Implement task A.',
    files_modified: ['src/a.js'],
    acceptance_criteria: ['A is complete.'],
    owner: 'implementer',
    ...overrides,
  };
}

test('planning validator canonicalizes dependencies and automated_verify aliases', () => {
  const plan = validatePlan({
    tasks: [
      baseTask({
        dependencies: ['task-b'],
        automated_verify: 'node --test tests/a.test.js',
      }),
      {
        id: 'task-b',
        goal: 'Implement dependency.',
        files_modified: ['src/b.js'],
        acceptance_criteria: ['B is complete.'],
        verify: 'node --test tests/b.test.js',
        depends_on: [],
        owner: 'implementer',
      },
    ],
  });

  assert.deepEqual(plan.tasks[0].depends_on, ['task-b']);
  assert.equal(plan.tasks[0].verify, 'node --test tests/a.test.js');
  assert.equal('dependencies' in plan.tasks[0], false);
  assert.equal('automated_verify' in plan.tasks[0], false);
});

test('planning validator rejects conflicting canonical and alias dependency values', () => {
  assert.throws(
    () =>
      validatePlan({
        tasks: [
          baseTask({
            depends_on: [],
            dependencies: ['other'],
            verify: 'node --test tests/a.test.js',
          }),
        ],
      }),
    /conflicting depends_on and dependencies/
  );
});

test('planning validator rejects conflicting canonical and alias verify values', () => {
  assert.throws(
    () =>
      validatePlan({
        tasks: [
          baseTask({
            depends_on: [],
            verify: 'node --test tests/a.test.js',
            automated_verify: 'node --test tests/other.test.js',
          }),
        ],
      }),
    /conflicting verify and automated_verify/
  );
});
