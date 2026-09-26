import { createHash } from 'node:crypto';
import {
  buildExecutionWaves,
  normalizeTask,
  planExecutionIsolation,
  tasksConflict,
} from '../scheduler/index.mjs';
import { roleCapabilityPolicy, validateRoleTaskContract } from '../capabilities/index.mjs';
import { validateUserApprovalReceipt } from '../approval/index.mjs';

export const EXECUTION_GRAPH_SCHEMA = 'hybrid-exec-graph/v4';
export const MATERIAL_REVISION_PROPOSAL_SCHEMA = 'hybrid-material-revision-proposal/v1';

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
  const normalizedTasks = tasks.map((task) => normalizeTask(task));
  const capabilityContracts = new Map(
    normalizedTasks.map((task) => [task.id, validateRoleTaskContract(task)])
  );
  buildExecutionWaves(normalizedTasks);
  const approvalSubject = executionApprovalSubjectFromNormalized(
    plan,
    normalizedTasks,
    { ...options, runId }
  );
  const approvalReceipt = requireApprovalReceipt(options.approvalReceipt, approvalSubject);
  const approvalScopeHash = approvalReceipt.receiptHash;

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

  const isolationByTask = executionIsolationByTask(
    normalizedTasks,
    options
  );
  const taskNodes = normalizedTasks
    .map((task) =>
      taskNode(
        task,
        capabilityContracts.get(task.id),
        isolationByTask.get(task.id)
      )
    )
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
    isolationMode: 'none',
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
    specHash: approvalSubject.specHash,
    planHash: approvalSubject.planHash,
    approvalScopeHash,
    approvalReceipt,
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
  if (!graph.approvalReceipt || typeof graph.approvalReceipt !== 'object' || Array.isArray(graph.approvalReceipt)) {
    errors.push('missing approvalReceipt');
  }
  if (
    graph.parentDescriptorHash !== null &&
    (typeof graph.parentDescriptorHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(graph.parentDescriptorHash))
  ) {
    errors.push('invalid parentDescriptorHash');
  }
  if (Array.isArray(graph.amendments)) {
    const materialAmendments = graph.amendments.filter(
      (amendment) => amendment?.kind === 'material-revision'
    );
    for (const amendment of materialAmendments) {
      const amendmentReasons = normalizeMaterialReasonCodes(amendment.reasons);
      if (
        !amendmentReasons.length ||
        canonical(amendmentReasons) !== canonical(amendment.reasons)
      ) {
        errors.push('invalid material revision amendment reasons');
      }
      for (const field of [
        'proposalHash',
        'parentDescriptorHash',
        'priorSpecHash',
        'priorPlanHash',
        'priorApprovalScopeHash',
        'approvalScopeHash',
      ]) {
        if (
          typeof amendment?.[field] !== 'string' ||
          !/^[0-9a-f]{64}$/.test(amendment[field])
        ) {
          errors.push('invalid material revision amendment ' + field);
        }
      }
    }
    const latestMaterial = materialAmendments.at(-1);
    if (
      latestMaterial &&
      latestMaterial.approvalScopeHash !== graph.approvalScopeHash
    ) {
      errors.push('latest material revision approval mismatch');
    }
  }

  if (!errors.length) {
    try {
      validateUserApprovalReceipt(graph.approvalReceipt, {
        runId: graph.runId,
        specHash: graph.specHash,
        planHash: graph.planHash,
      });
      if (graph.approvalScopeHash !== graph.approvalReceipt.receiptHash) {
        errors.push('approval scope/receipt mismatch');
      }
    } catch (error) {
      errors.push('approval receipt invalid: ' + error.message);
    }

    const ids = graph.nodes.map((node) => node.id);
    if (ids.some((id) => typeof id !== 'string' || !id)) errors.push('invalid node id');
    if (new Set(ids).size !== ids.length) errors.push('duplicate node id');
    const idSet = new Set(ids);
    if (!idSet.has(graph.terminalVerificationNodeId)) errors.push('missing terminal verification node');

    for (const node of graph.nodes) {
      if (
        node.kind === 'agent' &&
        !['current-workspace', 'worktree'].includes(node.isolationMode)
      ) {
        errors.push('invalid isolation mode: ' + node.id);
      }
      if (
        node.kind === 'verification' &&
        node.isolationMode !== 'none'
      ) {
        errors.push('invalid verification isolation mode: ' + node.id);
      }
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

export function executionApprovalSubject(plan, options = {}) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (!tasks.length) {
    throw new ExecutionGraphError('approval subject requires at least one task', 'EMPTY_EXECUTION_GRAPH');
  }
  const normalizedTasks = tasks.map((task) => normalizeTask(task));
  buildExecutionWaves(normalizedTasks);
  return executionApprovalSubjectFromNormalized(plan, normalizedTasks, options);
}

export function proposeMaterialRevision(parentGraph, plan, input = {}) {
  validateSealedExecutionGraph(parentGraph);
  const reasons = materialRevisionReasons(input);
  if (!reasons.length) {
    throw new ExecutionGraphError(
      'material revision proposal requires at least one material reason',
      'MATERIAL_REVISION_REASON_REQUIRED'
    );
  }

  const revisionId = String(
    input.revisionId || nextRevisionId(parentGraph.revisionId)
  ).trim();
  if (!revisionId || revisionId === parentGraph.revisionId) {
    throw new ExecutionGraphError(
      'material revision requires a distinct child revisionId',
      'INVALID_REVISION'
    );
  }

  const subjectOptions = materialRevisionSubjectOptions(parentGraph, input);
  const approvalSubject = executionApprovalSubject(plan, {
    runId: parentGraph.runId,
    ...subjectOptions,
  });
  assertMaterialSubjectChanged(parentGraph, approvalSubject);

  const proposal = {
    schema: MATERIAL_REVISION_PROPOSAL_SCHEMA,
    runId: parentGraph.runId,
    parentDescriptorHash: parentGraph.descriptorHash,
    parentRevisionId: parentGraph.revisionId,
    revisionId,
    reasons,
    specBinding: input.spec !== undefined ? 'content' : 'hash',
    approvalSubject,
  };
  proposal.proposalHash = materialRevisionProposalHash(proposal);

  return {
    applied: false,
    status: 'user-approval-required',
    reasons: [...reasons],
    approvalSubject: structuredClone(approvalSubject),
    proposal: Object.freeze(structuredClone(proposal)),
    graph: parentGraph,
  };
}

export function validateMaterialRevisionProposal(
  parentGraph,
  plan,
  proposal,
  options = {}
) {
  validateSealedExecutionGraph(parentGraph);
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new ExecutionGraphError(
      'material revision proposal must be an object',
      'INVALID_MATERIAL_REVISION_PROPOSAL'
    );
  }

  const errors = [];
  if (proposal.schema !== MATERIAL_REVISION_PROPOSAL_SCHEMA) errors.push('invalid schema');
  if (proposal.runId !== parentGraph.runId) errors.push('runId mismatch');
  if (proposal.parentDescriptorHash !== parentGraph.descriptorHash) {
    errors.push('parent descriptor mismatch');
  }
  if (proposal.parentRevisionId !== parentGraph.revisionId) {
    errors.push('parent revision mismatch');
  }
  if (
    typeof proposal.revisionId !== 'string' ||
    !proposal.revisionId.trim() ||
    proposal.revisionId === parentGraph.revisionId
  ) {
    errors.push('invalid child revision');
  }
  if (!['content', 'hash'].includes(proposal.specBinding)) {
    errors.push('invalid spec binding');
  }
  if (
    !proposal.approvalSubject ||
    typeof proposal.approvalSubject !== 'object' ||
    Array.isArray(proposal.approvalSubject) ||
    proposal.approvalSubject.runId !== parentGraph.runId ||
    typeof proposal.approvalSubject.specHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proposal.approvalSubject.specHash) ||
    typeof proposal.approvalSubject.planHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proposal.approvalSubject.planHash)
  ) {
    errors.push('invalid approval subject');
  }

  const reasons = normalizeMaterialReasonCodes(proposal.reasons);
  if (!reasons.length || canonical(reasons) !== canonical(proposal.reasons)) {
    errors.push('invalid material reasons');
  }

  if (
    typeof proposal.proposalHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(proposal.proposalHash) ||
    proposal.proposalHash !== materialRevisionProposalHash(proposal)
  ) {
    errors.push('proposal hash mismatch');
  }

  if (errors.length) {
    throw new ExecutionGraphError(
      'material revision proposal validation failed: ' + errors.join('; '),
      'INVALID_MATERIAL_REVISION_PROPOSAL',
      { errors }
    );
  }

  let subjectOptions;
  if (proposal.specBinding === 'content') {
    if (options.spec === undefined) {
      throw new ExecutionGraphError(
        'material revision proposal requires the approved SPEC content to be supplied again',
        'MATERIAL_REVISION_SPEC_REQUIRED'
      );
    }
    subjectOptions = {
      spec: options.spec,
      specHash: proposal.approvalSubject.specHash,
      planHash: proposal.approvalSubject.planHash,
    };
  } else {
    subjectOptions = options.spec !== undefined
      ? {
          spec: options.spec,
          specHash: proposal.approvalSubject.specHash,
          planHash: proposal.approvalSubject.planHash,
        }
      : {
          specHash: proposal.approvalSubject.specHash,
          planHash: proposal.approvalSubject.planHash,
        };
  }

  const observedSubject = executionApprovalSubject(plan, {
    runId: parentGraph.runId,
    ...subjectOptions,
  });
  if (canonical(observedSubject) !== canonical(proposal.approvalSubject)) {
    throw new ExecutionGraphError(
      'material revision plan/SPEC no longer matches the proposed approval subject',
      'MATERIAL_REVISION_SUBJECT_MISMATCH',
      {
        expected: structuredClone(proposal.approvalSubject),
        actual: observedSubject,
      }
    );
  }
  assertMaterialSubjectChanged(parentGraph, observedSubject);
  return true;
}

export function sealApprovedMaterialRevision(
  parentGraph,
  plan,
  proposal,
  options = {}
) {
  validateMaterialRevisionProposal(parentGraph, plan, proposal, options);

  const approvalReceipt = requireApprovalReceipt(
    options.approvalReceipt,
    proposal.approvalSubject
  );
  if (
    approvalReceipt.receiptHash === parentGraph.approvalScopeHash ||
    approvalReceipt.approvalId === parentGraph.approvalReceipt?.approvalId
  ) {
    throw new ExecutionGraphError(
      'material revision requires a fresh explicit user approval receipt',
      'MATERIAL_REVISION_FRESH_APPROVAL_REQUIRED'
    );
  }

  const specOptions = proposal.specBinding === 'content'
    ? {
        spec: options.spec,
        specHash: proposal.approvalSubject.specHash,
      }
    : options.spec !== undefined
      ? {
          spec: options.spec,
          specHash: proposal.approvalSubject.specHash,
        }
      : {
          specHash: proposal.approvalSubject.specHash,
        };

  const base = sealExecutionPlan(plan, {
    runId: parentGraph.runId,
    revisionId: proposal.revisionId,
    concurrencyLimit: parentGraph.concurrencyLimit,
    terminalVerificationNodeId: parentGraph.terminalVerificationNodeId,
    planHash: proposal.approvalSubject.planHash,
    ...(options.isolationPlan
      ? { isolationPlan: options.isolationPlan }
      : {}),
    ...(options.worktreeAvailable !== undefined
      ? { worktreeAvailable: options.worktreeAvailable }
      : {}),
    ...(options.forceWorktree !== undefined
      ? { forceWorktree: options.forceWorktree }
      : {}),
    ...(options.fileOwnershipConfidence !== undefined
      ? { fileOwnershipConfidence: options.fileOwnershipConfidence }
      : {}),
    ...specOptions,
    approvalReceipt,
  });

  const child = structuredClone(base);
  delete child.descriptorHash;
  child.parentDescriptorHash = parentGraph.descriptorHash;
  child.amendments = [
    ...parentGraph.amendments.map((item) => structuredClone(item)),
    {
      kind: 'material-revision',
      proposalHash: proposal.proposalHash,
      parentDescriptorHash: parentGraph.descriptorHash,
      reasons: [...proposal.reasons],
      priorSpecHash: parentGraph.specHash,
      priorPlanHash: parentGraph.planHash,
      priorApprovalScopeHash: parentGraph.approvalScopeHash,
      approvalScopeHash: approvalReceipt.receiptHash,
    },
  ];

  return sealGraph(child);
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

function materialRevisionSubjectOptions(parentGraph, input) {
  if (input.spec !== undefined) {
    return {
      spec: input.spec,
      ...(input.specHash !== undefined ? { specHash: input.specHash } : {}),
      ...(input.planHash !== undefined ? { planHash: input.planHash } : {}),
    };
  }
  return {
    specHash: input.specHash !== undefined ? input.specHash : parentGraph.specHash,
    ...(input.planHash !== undefined ? { planHash: input.planHash } : {}),
  };
}

function assertMaterialSubjectChanged(parentGraph, approvalSubject) {
  if (
    approvalSubject.specHash === parentGraph.specHash &&
    approvalSubject.planHash === parentGraph.planHash
  ) {
    throw new ExecutionGraphError(
      'material revision must change the approved SPEC or normalized execution plan',
      'MATERIAL_REVISION_SUBJECT_UNCHANGED'
    );
  }
}

function materialRevisionProposalHash(proposal) {
  const copy = structuredClone(proposal);
  delete copy.proposalHash;
  return hashValue(copy);
}

function normalizeMaterialReasonCodes(reasons) {
  const allowed = new Set([
    'EXPLICIT_MATERIAL_REVISION',
    ...Object.values(MATERIAL_FLAGS),
  ]);
  return [...new Set(
    (Array.isArray(reasons) ? reasons : [])
      .map((reason) => String(reason || '').trim())
      .filter((reason) => allowed.has(reason))
  )].sort();
}

function executionIsolationByTask(normalizedTasks, options = {}) {
  const taskIds = new Set(normalizedTasks.map((task) => task.id));
  const calculatedPlan = planExecutionIsolation(
    buildExecutionWaves(normalizedTasks),
    {
      worktreeAvailable: options.worktreeAvailable,
      forceWorktree: options.forceWorktree === true,
      fileOwnershipConfidence: options.fileOwnershipConfidence,
    }
  );
  const calculated = isolationMapFromPlan(calculatedPlan, taskIds);

  if (
    options.isolationPlan &&
    Array.isArray(options.isolationPlan.isolation)
  ) {
    const supplied = isolationMapFromPlan(
      options.isolationPlan,
      taskIds
    );
    if (
      canonical([...supplied.entries()].sort()) !==
      canonical([...calculated.entries()].sort())
    ) {
      throw new ExecutionGraphError(
        'supplied isolation plan does not match deterministic scheduler isolation',
        'EXECUTION_ISOLATION_MISMATCH',
        {
          expected: Object.fromEntries([...calculated.entries()].sort()),
          supplied: Object.fromEntries([...supplied.entries()].sort()),
        }
      );
    }
  }

  return calculated;
}

function isolationMapFromPlan(plan, taskIds) {
  const byTask = new Map();
  for (const entry of plan?.isolation || []) {
    if (!['current-workspace', 'worktree'].includes(entry?.mode)) {
      throw new ExecutionGraphError(
        'sealed execution isolation must resolve to current-workspace or worktree',
        'INVALID_EXECUTION_ISOLATION',
        { entry }
      );
    }
    for (const taskId of entry.taskIds || []) {
      if (!taskIds.has(taskId)) {
        throw new ExecutionGraphError(
          'isolation plan references unknown task ' + taskId,
          'INVALID_EXECUTION_ISOLATION',
          { taskId }
        );
      }
      if (byTask.has(taskId)) {
        throw new ExecutionGraphError(
          'isolation plan assigns task more than once: ' + taskId,
          'INVALID_EXECUTION_ISOLATION',
          { taskId }
        );
      }
      byTask.set(taskId, entry.mode);
    }
  }

  const missing = [...taskIds].filter((taskId) => !byTask.has(taskId));
  if (missing.length) {
    throw new ExecutionGraphError(
      'isolation plan is missing executable tasks',
      'INVALID_EXECUTION_ISOLATION',
      { missing }
    );
  }
  return byTask;
}

function taskNode(task, capabilityContract, isolationMode) {
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
    isolationMode,
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

function requireApprovalReceipt(receipt, subject) {
  if (!receipt) {
    throw new ExecutionGraphError(
      'user approval receipt is required before execution can be sealed',
      'APPROVAL_RECEIPT_REQUIRED'
    );
  }
  try {
    validateUserApprovalReceipt(receipt, subject);
  } catch (error) {
    throw new ExecutionGraphError(
      error.message,
      error.code || 'INVALID_APPROVAL_RECEIPT',
      error.details || {}
    );
  }
  return structuredClone(receipt);
}

function executionApprovalSubjectFromNormalized(plan, normalizedTasks, options = {}) {
  const runId = requiredString(options.runId, 'runId');
  const computedPlanHash = hashValue(normalizedPlanForHash(plan, normalizedTasks));
  if (options.planHash !== undefined && String(options.planHash).trim() !== computedPlanHash) {
    throw new ExecutionGraphError(
      'provided planHash does not match the normalized execution plan',
      'PLAN_HASH_MISMATCH',
      { expected: computedPlanHash, actual: String(options.planHash).trim() }
    );
  }

  let specHash;
  if (options.spec !== undefined) {
    const computedSpecHash = hashValue(options.spec);
    if (options.specHash !== undefined && String(options.specHash).trim() !== computedSpecHash) {
      throw new ExecutionGraphError(
        'provided specHash does not match the supplied spec',
        'SPEC_HASH_MISMATCH',
        { expected: computedSpecHash, actual: String(options.specHash).trim() }
      );
    }
    specHash = computedSpecHash;
  } else if (options.specHash !== undefined) {
    specHash = requireSha256(options.specHash, 'specHash');
  } else {
    specHash = hashValue(null);
  }

  return { runId, specHash, planHash: computedPlanHash };
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

function requireSha256(value, field) {
  const text = requiredString(value, field);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new ExecutionGraphError(field + ' must be a sha256 hex digest', 'INVALID_SUBJECT_HASH');
  }
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
