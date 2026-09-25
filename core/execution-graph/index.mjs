import { createHash } from 'node:crypto';
import {
  buildExecutionWaves,
  normalizeTask,
  tasksConflict,
} from '../scheduler/index.mjs';
import { roleCapabilityPolicy, validateRoleTaskContract } from '../capabilities/index.mjs';

export const EXECUTION_GRAPH_SCHEMA = 'hybrid-exec-graph/v2';

const MATERIAL_FLAGS = Object.freeze({
  productBehaviorChanged: 'PRODUCT_BEHAVIOR_CHANGE',
  publicApiChanged: 'PUBLIC_API_CHANGE',
  schemaMeaningChanged: 'SCHEMA_MEANING_CHANGE',
  featureScopeChanged: 'FEATURE_SCOPE_CHANGE',
  requirementRemoved: 'REQUIREMENT_REMOVAL',
  securityPostureChanged: 'SECURITY_POSTURE_CHANGE',
});

export class ExecutionGraphError extends Error {
  constructor(message, code = 'INVALID_EXECUTION_GRAPH', details = {}) {
    super(message);
    this.name = 'ExecutionGraphError';
    this.code = code;
    this.details = details;
  }
}

export function sealExecutionPlan(plan, options = {}) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!tasks.length) {
    throw new ExecutionGraphError('approved plan requires at least one task', 'EMPTY_EXECUTION_GRAPH');
  }

  const runId = requiredString(options.runId, 'runId');
  const revisionId = String(options.revisionId || 'G1').trim();
  if (!revisionId) throw new ExecutionGraphError('revisionId is required', 'INVALID_REVISION');
  const approvalScopeHash = resolveApprovalScopeHash(options);
  const normalizedTasks = tasks.map((task) => normalizeTask(task));
  const capabilityContracts = new Map(
    normalizedTasks.map((task) => [task.id, validateRoleTaskContract(task)])
  );
  buildExecutionWaves(normalizedTasks);

  const terminalVerificationNodeId = String(
    options.terminalVerificationNodeId || 'verify-final'
  ).trim();
  if (!terminalVerificationNodeId) {
    throw new ExecutionGraphError(
      'terminalVerificationNodeId is required',
      'INVALID_TERMINAL_NODE'
    );
  }
  if (normalizedTasks.some((task) => task.id === terminalVerificationNodeId)) {
    throw new ExecutionGraphError(
      'terminal verification node collides with a task id',
      'DUPLICATE_NODE_ID'
    );
  }

  const taskNodes = normalizedTasks
    .map((task) => taskNode(task, capabilityContracts.get(task.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const taskIds = new Set(taskNodes.map((node) => node.id));
  const dependedOn = new Set(taskNodes.flatMap((node) => node.dependsOn));
  const leafIds = taskNodes
    .filter((node) => !dependedOn.has(node.id))
    .map((node) => node.id)
    .sort();

  const terminalNode = {
    id: terminalVerificationNodeId,
    kind: 'verification',
    role: 'verifier',
    dependsOn: leafIds,
    reads: [],
    writes: [],
    filesModified: [],
    resources: [],
    effectPolicy: 'side_effect_free',
    acceptanceCriteria: [],
    verify: null,
    capabilityGrant: capabilityGrantForRole('verifier'),
  };

  const nodes = [...taskNodes, terminalNode].sort((a, b) => a.id.localeCompare(b.id));
  const edges = nodes
    .flatMap((node) =>
      node.dependsOn.map((from) => ({ from, to: node.id }))
    )
    .sort(compareEdge);
  const entryNodeIds = taskNodes
    .filter((node) => node.dependsOn.length === 0)
    .map((node) => node.id)
    .sort();

  for (const edge of edges) {
    if (!taskIds.has(edge.from) && edge.from !== terminalVerificationNodeId) {
      throw new ExecutionGraphError(
        'graph edge references unknown source ' + edge.from,
        'UNKNOWN_GRAPH_NODE'
      );
    }
  }

  const graph = {
    schema: EXECUTION_GRAPH_SCHEMA,
    runId,
    revisionId,
    parentDescriptorHash: null,
    specHash: options.specHash || hashValue(options.spec ?? null),
    planHash: options.planHash || hashValue(normalizedPlanForHash(plan, normalizedTasks)),
    approvalScopeHash,
    concurrencyLimit: positiveInt(options.concurrencyLimit, 8),
    terminalVerificationNodeId,
    entryNodeIds,
    nodes,
    edges,
    amendments: [],
  };

  return sealGraph(graph);
}

export function validateSealedExecutionGraph(graph) {
  const errors = [];
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new ExecutionGraphError('graph must be an object');
  }
  if (graph.schema !== EXECUTION_GRAPH_SCHEMA) errors.push('invalid schema');
  for (const field of [
    'runId',
    'revisionId',
    'specHash',
    'planHash',
    'approvalScopeHash',
    'terminalVerificationNodeId',
    'descriptorHash',
  ]) {
    if (typeof graph[field] !== 'string' || !graph[field]) errors.push('missing ' + field);
  }
  if (!Number.isInteger(graph.concurrencyLimit) || graph.concurrencyLimit < 1) {
    errors.push('invalid concurrencyLimit');
  }
  if (!Array.isArray(graph.nodes) || !graph.nodes.length) errors.push('missing nodes');
  if (!Array.isArray(graph.edges)) errors.push('missing edges');
  if (!Array.isArray(graph.entryNodeIds)) errors.push('missing entryNodeIds');
  if (!Array.isArray(graph.amendments)) errors.push('missing amendments');

  if (!errors.length) {
    const ids = graph.nodes.map((node) => node.id);
    if (ids.some((id) => typeof id !== 'string' || !id)) errors.push('invalid node id');
    if (new Set(ids).size !== ids.length) errors.push('duplicate node id');
    const idSet = new Set(ids);
    if (!idSet.has(graph.terminalVerificationNodeId)) errors.push('missing terminal verification node');

    for (const node of graph.nodes) {
      try {
        const contract = validateRoleTaskContract({
          id: node.id,
          owner: node.role,
          files_modified: node.filesModified || [],
          writes: node.writes || [],
          resources: node.resources || [],
          requested_capabilities: node.capabilityGrant?.capabilities || [],
        });
        const expectedGrant = {
          sandboxMode: contract.sandboxMode,
          writeScope: contract.writeScope,
          capabilities: [...contract.capabilities].sort(),
        };
        if (canonical(node.capabilityGrant) !== canonical(expectedGrant)) {
          errors.push('capability grant mismatch: ' + node.id);
        }
      } catch (error) {
        errors.push('capability policy violation: ' + node.id + ': ' + error.message);
      }

      if (!Array.isArray(node.dependsOn)) {
        errors.push('node dependencies missing: ' + node.id);
        continue;
      }
      for (const dep of node.dependsOn) {
        if (!idSet.has(dep)) errors.push('unknown dependency ' + dep + ' for ' + node.id);
        if (dep === node.id) errors.push('self dependency ' + node.id);
      }
    }

    const expectedEdges = graph.nodes
      .flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id })))
      .sort(compareEdge);
    const actualEdges = [...graph.edges].sort(compareEdge);
    if (canonical(expectedEdges) !== canonical(actualEdges)) errors.push('edge/dependency mismatch');

    try {
      buildExecutionWaves(
        graph.nodes.map((node) => ({
          id: node.id,
          depends_on: node.dependsOn,
          files_modified: node.filesModified || [],
          reads: node.reads || [],
          writes: node.writes || [],
          resources: node.resources || [],
          effect_policy: node.effectPolicy || 'side_effect_free',
        }))
      );
    } catch (error) {
      errors.push('invalid dependency/resource graph: ' + error.message);
    }

    const expectedHash = hashGraph(graph);
    if (graph.descriptorHash !== expectedHash) errors.push('descriptor hash mismatch');
  }

  if (errors.length) {
    throw new ExecutionGraphError(
      'sealed execution graph validation failed: ' + errors.join('; '),
      'INVALID_EXECUTION_GRAPH',
      { errors }
    );
  }
  return true;
}

export function requestLeaseExtension(graph, input = {}) {
  validateSealedExecutionGraph(graph);
  const taskId = requiredString(input.taskId, 'taskId');
  const materialReasons = materialRevisionReasons(input);
  if (materialReasons.length) {
    return {
      applied: false,
      status: 'user-approval-required',
      reasons: materialReasons,
      graph,
    };
  }

  const nodeIndex = graph.nodes.findIndex(
    (node) => node.id === taskId && node.kind === 'agent'
  );
  if (nodeIndex < 0) {
    throw new ExecutionGraphError(
      'lease extension target is not an executable task: ' + taskId,
      'UNKNOWN_GRAPH_NODE'
    );
  }

  const requestedResources = normalizeTask({
    id: '__lease__',
    resources: input.resources || [],
    files_modified: [],
    effect_policy: 'side_effect_free',
  }).resources;
  if (!requestedResources.length) {
    return {
      applied: false,
      status: 'no-op',
      reasons: [],
      graph,
    };
  }

  const currentNode = graph.nodes[nodeIndex];
  const existing = new Set(
    currentNode.resources.map((resource) => resource.key + '\0' + resource.mode)
  );
  const additions = requestedResources.filter(
    (resource) => !existing.has(resource.key + '\0' + resource.mode)
  );
  if (!additions.length) {
    return {
      applied: false,
      status: 'no-op',
      reasons: [],
      graph,
    };
  }

  const next = structuredClone(graph);
  delete next.descriptorHash;
  next.parentDescriptorHash = graph.descriptorHash;
  next.revisionId = input.revisionId
    ? requiredString(input.revisionId, 'revisionId')
    : nextRevisionId(graph.revisionId);
  next.nodes[nodeIndex].resources = [
    ...next.nodes[nodeIndex].resources,
    ...additions,
  ].sort(compareResource);
  next.amendments = [
    ...next.amendments,
    {
      kind: 'lease-extension',
      taskId,
      resources: additions,
      material: false,
      approvalScopeHash: graph.approvalScopeHash,
    },
  ];

  const amended = sealGraph(next);
  const amendedTask = nodeAsTask(amended.nodes[nodeIndex]);
  const conflicts = amended.nodes
    .filter((node, index) => index !== nodeIndex && node.kind === 'agent')
    .filter((node) => tasksConflict(amendedTask, nodeAsTask(node)))
    .map((node) => node.id)
    .sort();

  return {
    applied: true,
    status: 'amended',
    reasons: [],
    requiresReschedule: conflicts.length > 0,
    conflicts,
    graph: amended,
  };
}

export function materialRevisionReasons(input = {}) {
  const reasons = [];
  if (input.material === true) reasons.push('EXPLICIT_MATERIAL_REVISION');
  for (const [field, code] of Object.entries(MATERIAL_FLAGS)) {
    if (input[field] === true) reasons.push(code);
  }
  return [...new Set(reasons)].sort();
}

export function executionGraphHash(graph) {
  return hashGraph(graph);
}

function taskNode(task, capabilityContract) {
  return {
    id: task.id,
    kind: 'agent',
    role: task.owner || 'implementer',
    dependsOn: [...task.depends_on].sort(),
    reads: [...task.reads].sort(),
    writes: [...task.writes].sort(),
    filesModified: [...task.files_modified].sort(),
    resources: [...task.resources].sort(compareResource),
    effectPolicy: task.effect_policy,
    acceptanceCriteria: [...(task.acceptance_criteria || [])],
    verify: task.verify || null,
    capabilityGrant: {
      sandboxMode: capabilityContract.sandboxMode,
      writeScope: capabilityContract.writeScope,
      capabilities: [...capabilityContract.capabilities].sort(),
    },
  };
}

function capabilityGrantForRole(role) {
  const policy = roleCapabilityPolicy(role);
  return {
    sandboxMode: policy.sandboxMode,
    writeScope: policy.writeScope,
    capabilities: [...policy.capabilities].sort(),
  };
}

function nodeAsTask(node) {
  return {
    id: node.id,
    depends_on: node.dependsOn || [],
    files_modified: node.filesModified || [],
    reads: node.reads || [],
    writes: node.writes || [],
    resources: node.resources || [],
    effect_policy: node.effectPolicy || 'side_effect_free',
  };
}

function sealGraph(graph) {
  const sealed = {
    ...graph,
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort(compareEdge),
    entryNodeIds: [...graph.entryNodeIds].sort(),
  };
  sealed.descriptorHash = hashGraph(sealed);
  validateSealedExecutionGraph(sealed);
  return sealed;
}

function hashGraph(graph) {
  const copy = structuredClone(graph);
  delete copy.descriptorHash;
  return hashValue(copy);
}

function resolveApprovalScopeHash(options) {
  if (typeof options.approvalScopeHash === 'string' && options.approvalScopeHash.trim()) {
    return options.approvalScopeHash.trim();
  }
  if (options.approvalScope !== undefined) {
    return hashValue(options.approvalScope);
  }
  throw new ExecutionGraphError(
    'approvalScopeHash or approvalScope is required before execution can be sealed',
    'APPROVAL_SCOPE_REQUIRED'
  );
}

function normalizedPlanForHash(plan, normalizedTasks) {
  const copy = structuredClone(plan || {});
  copy.tasks = normalizedTasks;
  return copy;
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new ExecutionGraphError(field + ' is required', 'MISSING_GRAPH_FIELD');
  return text;
}

function positiveInt(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new ExecutionGraphError('concurrencyLimit must be a positive integer', 'INVALID_CONCURRENCY');
  }
  return number;
}

function nextRevisionId(current) {
  const match = String(current || '').match(/^(.*?)(\d+)$/);
  if (!match) return String(current || 'G') + '-1';
  return match[1] + String(Number(match[2]) + 1);
}

function compareResource(left, right) {
  return left.key.localeCompare(right.key) || left.mode.localeCompare(right.mode);
}

function compareEdge(left, right) {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function hashValue(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
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
