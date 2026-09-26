import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityError,
  ROLE_CAPABILITY_POLICY,
  roleCapabilityPolicy,
  validateRoleCapabilityRequest,
  validateRoleSandbox,
  validateRoleTaskContract,
} from '../../core/capabilities/index.mjs';

test('all registered Hybrid roles have deterministic capability policies', () => {
  assert.deepEqual(
    Object.keys(ROLE_CAPABILITY_POLICY).sort(),
    [
      'adversarial-reviewer',
      'architect',
      'browser-adversarial-reviewer',
      'browser-functional-tester',
      'code-reviewer',
      'design-architect',
      'design-executor',
      'design-reviewer',
      'implementer',
      'knowledge-synthesizer',
      'plan-auditor',
      'planner',
      'researcher',
      'scout',
      'security-reviewer',
      'tester',
      'verifier',
    ]
  );
  assert.equal(roleCapabilityPolicy('planner').sandboxMode, 'read-only');
  assert.equal(roleCapabilityPolicy('implementer').sandboxMode, 'workspace-write');
  assert.equal(roleCapabilityPolicy('verifier').writeScope, 'none');
});

test('unknown roles fail closed instead of inheriting a permissive default', () => {
  assert.throws(
    () => roleCapabilityPolicy('mystery-agent'),
    (error) => error instanceof CapabilityError && error.code === 'UNKNOWN_ROLE_CAPABILITY'
  );
});

test('planner reviewer tester and verifier cannot own mutating tasks', () => {
  for (const role of ['planner', 'architect', 'plan-auditor', 'tester', 'code-reviewer', 'adversarial-reviewer', 'browser-functional-tester', 'browser-adversarial-reviewer', 'security-reviewer', 'verifier']) {
    assert.throws(
      () => validateRoleTaskContract({
        id: 'mutate-' + role,
        owner: role,
        files_modified: ['src/a.js'],
      }),
      (error) => error instanceof CapabilityError && error.code === 'ROLE_WRITE_DENIED'
    );
  }
});

test('implementer receives leased write authority and cannot request undeclared capabilities', () => {
  const contract = validateRoleTaskContract({
    id: 'impl',
    owner: 'implementer',
    files_modified: ['src/a.js'],
  });
  assert.equal(contract.sandboxMode, 'workspace-write');
  assert.equal(contract.writeScope, 'leased-task');
  assert.ok(contract.capabilities.includes('fs.write.leased'));

  assert.throws(
    () => validateRoleCapabilityRequest('implementer', ['network.write']),
    (error) => error instanceof CapabilityError && error.code === 'CAPABILITY_REQUEST_DENIED'
  );
});

test('design executor requires an exclusive ui surface lease while design reviewers stay read-only', () => {
  const contract = validateRoleTaskContract({
    id: 'design',
    owner: 'design-executor',
    files_modified: ['src/components/Checkout.tsx'],
    resources: [{ key: 'ui:checkout', mode: 'exclusive' }],
  });
  assert.equal(contract.sandboxMode, 'workspace-write');
  assert.equal(contract.writeScope, 'leased-ui');
  assert.ok(contract.capabilities.includes('ui.implement'));

  assert.throws(
    () => validateRoleTaskContract({
      id: 'no-lease',
      owner: 'design-executor',
      files_modified: ['src/components/Checkout.tsx'],
    }),
    (error) => error instanceof CapabilityError && error.code === 'UI_LEASE_REQUIRED'
  );

  for (const role of ['design-architect', 'design-reviewer']) {
    assert.throws(
      () => validateRoleTaskContract({
        id: 'bad-' + role,
        owner: role,
        files_modified: ['src/components/Checkout.tsx'],
      }),
      (error) => error instanceof CapabilityError && error.code === 'ROLE_WRITE_DENIED'
    );
  }
});

test('knowledge synthesizer may write durable docs but not implementation source', () => {
  const docs = validateRoleTaskContract({
    id: 'docs',
    owner: 'knowledge-synthesizer',
    files_modified: ['docs/architecture/runtime.md', '.ai/wiki/runtime.md'],
  });
  assert.equal(docs.writeScope, 'durable-documentation');

  assert.throws(
    () => validateRoleTaskContract({
      id: 'escape',
      owner: 'knowledge-synthesizer',
      files_modified: ['src/runtime.js'],
    }),
    (error) => error instanceof CapabilityError && error.code === 'ROLE_WRITE_SCOPE_VIOLATION'
  );
});

test('sandbox declarations must match the capability policy exactly', () => {
  assert.equal(validateRoleSandbox('planner', 'read-only'), true);
  assert.throws(
    () => validateRoleSandbox('planner', 'workspace-write'),
    (error) => error instanceof CapabilityError && error.code === 'SANDBOX_POLICY_MISMATCH'
  );
});
