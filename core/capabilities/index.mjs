export const ROLE_CAPABILITY_POLICY = Object.freeze({
  scout: readOnlyPolicy(['fs.read', 'code.search']),
  researcher: readOnlyPolicy(['fs.read', 'code.search', 'network.read']),
  planner: readOnlyPolicy(['fs.read', 'code.search', 'planning.return']),
  'design-architect': readOnlyPolicy(['fs.read', 'code.search', 'ui.inspect', 'design.return']),
  architect: readOnlyPolicy(['fs.read', 'code.search', 'review.return']),
  'plan-auditor': readOnlyPolicy(['fs.read', 'code.search', 'review.return']),
  tester: readOnlyPolicy(['fs.read', 'process.test', 'review.return']),
  'code-reviewer': readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'review.return']),
  'adversarial-reviewer': readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'review.return']),
  'browser-functional-tester': readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'ui.inspect', 'browser.interact', 'review.return']),
  'browser-adversarial-reviewer': readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'ui.inspect', 'browser.interact', 'review.return']),
  'security-reviewer': readOnlyPolicy([
    'fs.read',
    'code.search',
    'process.test',
    'security.scan',
    'review.return',
  ]),
  verifier: readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'review.return']),
  implementer: Object.freeze({
    sandboxMode: 'workspace-write',
    capabilities: Object.freeze(['fs.read', 'fs.write.leased', 'process.execute']),
    writeScope: 'leased-task',
  }),
  'design-executor': Object.freeze({
    sandboxMode: 'workspace-write',
    capabilities: Object.freeze(['fs.read', 'fs.write.leased', 'process.execute', 'ui.implement']),
    writeScope: 'leased-ui',
  }),
  'design-reviewer': readOnlyPolicy(['fs.read', 'code.search', 'process.test', 'ui.inspect', 'design.return']),
  'knowledge-synthesizer': Object.freeze({
    sandboxMode: 'workspace-write',
    capabilities: Object.freeze(['fs.read', 'fs.write.documentation']),
    writeScope: 'durable-documentation',
  }),
});

const DURABLE_DOCUMENTATION_PATHS = Object.freeze([
  /^README(?:\.[^/]+)?$/i,
  /^ARCHITECTURE\.md$/i,
  /^DESIGN-MATRIX\.md$/i,
  /^UPSTREAMS\.md$/i,
  /^docs\//,
  /^\.ai\/wiki\//,
]);

export class CapabilityError extends Error {
  constructor(message, code = 'CAPABILITY_DENIED', details = {}) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.details = details;
  }
}

export function roleCapabilityPolicy(role) {
  const key = String(role || '').trim();
  const policy = ROLE_CAPABILITY_POLICY[key];
  if (!policy) {
    throw new CapabilityError(
      'unknown Hybrid role has no capability policy: ' + key,
      'UNKNOWN_ROLE_CAPABILITY',
      { role: key || null }
    );
  }
  return policy;
}

export function roleHasCapability(role, capability) {
  const policy = roleCapabilityPolicy(role);
  return policy.capabilities.includes(String(capability || '').trim());
}

export function validateRoleSandbox(role, sandboxMode) {
  const policy = roleCapabilityPolicy(role);
  if (sandboxMode !== policy.sandboxMode) {
    throw new CapabilityError(
      'role sandbox does not match capability policy: ' + role,
      'SANDBOX_POLICY_MISMATCH',
      {
        role,
        expected: policy.sandboxMode,
        actual: sandboxMode,
      }
    );
  }
  return true;
}

export function validateRoleTaskContract(task = {}) {
  const role = String(task.owner || task.role || 'implementer').trim();
  const policy = roleCapabilityPolicy(role);
  const writes = uniquePaths([
    ...(task.files_modified || task.filesModified || []),
    ...(task.writes || task.files_written || task.filesWritten || []),
  ]);
  const requestedCapabilities = validateRoleCapabilityRequest(
    role,
    task.requested_capabilities || task.requestedCapabilities || policy.capabilities
  );

  if (!writes.length) {
    return {
      role,
      sandboxMode: policy.sandboxMode,
      writeScope: policy.writeScope,
      capabilities: requestedCapabilities,
      writes: [],
    };
  }

  if (policy.writeScope === 'none') {
    throw new CapabilityError(
      'read-only role cannot own mutating task: ' + role,
      'ROLE_WRITE_DENIED',
      { role, writes }
    );
  }

  if (policy.writeScope === 'leased-ui') {
    const resources = Array.isArray(task.resources) ? task.resources : [];
    const uiExclusive = resources.some((resource) => {
      const item = typeof resource === 'string' ? { key: resource, mode: 'exclusive' } : resource;
      const key = String(item?.key || '').trim();
      const mode = String(item?.mode || 'exclusive').trim().toLowerCase();
      return key.startsWith('ui:') && ['exclusive', 'write'].includes(mode);
    });
    if (!uiExclusive) {
      throw new CapabilityError(
        'design executor requires an exclusive ui:<surface> resource lease',
        'UI_LEASE_REQUIRED',
        { role, resources }
      );
    }
  }

  if (policy.writeScope === 'durable-documentation') {
    const denied = writes.filter((file) =>
      !DURABLE_DOCUMENTATION_PATHS.some((pattern) => pattern.test(file))
    );
    if (denied.length) {
      throw new CapabilityError(
        'knowledge synthesizer write escapes durable documentation scope',
        'ROLE_WRITE_SCOPE_VIOLATION',
        { role, denied, writes }
      );
    }
  }

  return {
    role,
    sandboxMode: policy.sandboxMode,
    writeScope: policy.writeScope,
    capabilities: requestedCapabilities,
    writes,
  };
}

export function validateRoleCapabilityRequest(role, requested = []) {
  const policy = roleCapabilityPolicy(role);
  const capabilities = [...new Set(
    (Array.isArray(requested) ? requested : [requested])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )].sort();
  const denied = capabilities.filter(
    (capability) => !policy.capabilities.includes(capability)
  );
  if (denied.length) {
    throw new CapabilityError(
      'role requested capabilities outside its policy: ' + role,
      'CAPABILITY_REQUEST_DENIED',
      { role, denied, requested: capabilities }
    );
  }
  return capabilities;
}

function readOnlyPolicy(capabilities) {
  return Object.freeze({
    sandboxMode: 'read-only',
    capabilities: Object.freeze(capabilities),
    writeScope: 'none',
  });
}

function uniquePaths(values) {
  return [...new Set(
    values
      .map((value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
      .filter(Boolean)
  )].sort();
}
