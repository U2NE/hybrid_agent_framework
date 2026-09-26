import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDocumentationDrift } from '../../core/docs/index.mjs';

test('documentation drift selects only durable affected surfaces', () => {
  const result = detectDocumentationDrift({
    files: ['package.json', 'src/api/routes.js', 'tests/api.test.js'],
    description: 'API contract and setup dependency changed',
  });
  assert.equal(result.durableKnowledgeChanged, true);
  assert.ok(result.changedAxes.includes('api'));
  assert.ok(result.changedAxes.includes('dependency'));
  assert.ok(result.changedAxes.includes('testing'));
  assert.ok(result.suggestedDocs.includes('README.md'));
  assert.ok(result.suggestedDocs.includes('docs/API.md'));
});

test('ordinary implementation log does not force durable documentation changes', () => {
  const result = detectDocumentationDrift({
    files: ['src/math/add.js'],
    description: 'Implement arithmetic helper',
  });
  assert.equal(result.durableKnowledgeChanged, false);
  assert.deepEqual(result.suggestedDocs, []);
});


test('routing documentation stays semantically aligned with canonical Luna-first policy', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const policy = JSON.parse(await fs.readFile(path.join(root, 'core/routing/model-routing.json'), 'utf8'));
  const plan = await fs.readFile(path.join(root, 'skills/plan/SKILL.md'), 'utf8');
  const runtimeReadme = await fs.readFile(path.join(root, 'runtime-smoke/README.md'), 'utf8');
  const runtimeDoc = await fs.readFile(path.join(root, 'docs/architecture/RUNTIME-SMOKE.md'), 'utf8');
  const routingDoc = await fs.readFile(path.join(root, 'docs/architecture/MODEL-ROUTING.md'), 'utf8');
  const budgetDoc = await fs.readFile(path.join(root, 'docs/architecture/MODEL-BUDGET.md'), 'utf8');
  const leaseDoc = await fs.readFile(path.join(root, 'docs/architecture/RESOURCE-LEASES.md'), 'utf8');
  const approvalDoc = await fs.readFile(path.join(root, 'docs/architecture/APPROVAL-CONTRACT.md'), 'utf8');

  assert.equal(policy.default_route, 'luna_medium');
  assert.equal(policy.profiles.moderate, 'luna_high');
  assert.equal(policy.profiles.hard, 'luna_xhigh');
  assert.equal(policy.profiles.very_hard, 'luna_max');
  assert.equal(policy.profiles.exceptional, 'sol_high');
  assert.equal(policy.budget_policy.default_max_sol_reservations_per_run, 3);

  assert.match(plan, /raises Luna reasoning effort first/i);
  assert.match(plan, /Sol is reserved for exceptional or unresolved reasoning/i);
  assert.doesNotMatch(plan, /Planner escalates to Sol for high ambiguity/i);

  assert.match(runtimeReadme, /bounded Security Reviewer: Luna max/i);
  assert.match(runtimeReadme, /Code Reviewer: raises Luna effort first/i);
  assert.match(runtimeReadme, /routine Verifier can downshift to Luna medium/i);
  assert.doesNotMatch(runtimeReadme, /Security Reviewer: Sol/i);
  assert.doesNotMatch(runtimeReadme, /Code Reviewer: Sol for the security-sensitive review/i);

  assert.match(runtimeDoc, /bounded security reviewer uses Luna max/i);
  assert.match(routingDoc, /default automatic cap is \*\*3 unique Sol stage-attempt reservations per run\*\*/i);
  assert.match(routingDoc, /MODEL_BUDGET_USER_APPROVAL_REQUIRED/);
  assert.match(budgetDoc, /Lead\/worker agents must not self-issue it/i);
  assert.match(approvalDoc, /sealed execution graph v4/i);
  assert.match(leaseDoc, /Runtime resource extension barrier/i);
  assert.match(leaseDoc, /sealed execution isolation mode/i);
  assert.match(leaseDoc, /hybrid-exec-graph\/v4/);
  assert.match(leaseDoc, /every successful terminal/i);
  assert.match(leaseDoc, /invalid for `current-workspace`/i);
  assert.match(leaseDoc, /drain-required/);
  assert.match(leaseDoc, /new attempt/i);
  assert.match(leaseDoc, /never has its dispatch authorization or sealed task contract mutated in place/i);
  assert.match(leaseDoc, /Evidence-bound release and recovery/i);
  assert.match(leaseDoc, /hybrid-lease-release-proof\/v1/);
  assert.match(leaseDoc, /task_aborted_reconciled/);
  assert.match(leaseDoc, /Raw token-only/i);
  assert.match(leaseDoc, /independently re-reads `TRANSITIONS\.jsonl`/i);
  assert.match(leaseDoc, /missing or corrupted terminal evidence fails closed/i);
  assert.match(leaseDoc, /\.transitions\.lock/);
  assert.match(leaseDoc, /atomic ledger replacement/i);
  assert.match(leaseDoc, /at most one terminal outcome/i);
  assert.match(leaseDoc, /Terminal records persist only the sealed graph `descriptorHash` and non-secret `leaseId`/i);
  assert.match(leaseDoc, /validates descriptor hash, lease ID, revision, executable agent node, attempt, and effect policy/i);
  assert.match(leaseDoc, /completion from an older graph revision never marks the current revision complete/i);
  assert.match(leaseDoc, /`recovered_task_completed` is recovery-only/i);
  assert.match(leaseDoc, /direct terminal commits are independently fenced/i);
  assert.match(leaseDoc, /new terminal transition requires the active durable dispatch authorization/i);
  assert.match(leaseDoc, /non-secret `leaseId`/i);
  assert.match(leaseDoc, /lease token and full capability\/task contract are never copied/i);
  assert.match(leaseDoc, /released authorization may only replay the exact terminal transition/i);
  assert.match(leaseDoc, /initial run graph binding/i);
  assert.match(leaseDoc, /concurrent identical G1 bindings converge/i);
  assert.match(leaseDoc, /conflicting descriptors produce one winner and one `GRAPH_FENCED` loser/i);

  for (const alias of ['.agents/skills/plan/SKILL.md', '.codex/skills/plan/SKILL.md']) {
    const stat = await fs.lstat(path.join(root, alias));
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(
      await fs.realpath(path.join(root, alias)),
      await fs.realpath(path.join(root, 'skills/plan/SKILL.md'))
    );
  }
});

test('current-workspace mutation guard documentation matches the enforced ownership boundary', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const guardDoc = await fs.readFile(
    path.join(root, 'docs/architecture/WORKSPACE-MUTATION-GUARD.md'),
    'utf8'
  );
  const executeSkill = await fs.readFile(
    path.join(root, 'skills/execute/SKILL.md'),
    'utf8'
  );
  const guardCore = await fs.readFile(
    path.join(root, 'core/workspace-guard/index.mjs'),
    'utf8'
  );
  const worktreeCore = await fs.readFile(
    path.join(root, 'core/worktree/index.mjs'),
    'utf8'
  );
  const transitionCore = await fs.readFile(
    path.join(root, 'core/transitions/index.mjs'),
    'utf8'
  );

  assert.match(guardDoc, /observed_changed_paths ⊆ sealed_task_writes/);
  assert.match(guardDoc, /WRITE_SET_VIOLATION/);
  assert.match(guardDoc, /WORKSPACE_BASE_MOVED/);
  assert.match(guardDoc, /repository-global/i);
  assert.match(guardDoc, /Guard completion is necessary but is not itself lease-release authority/);
  assert.match(guardDoc, /task_completed/);
  assert.match(guardDoc, /task_aborted_reconciled/);
  assert.match(guardDoc, /evidence-bound lease release/i);
  assert.match(guardDoc, /hybrid-worktree-owner\/v2/);
  assert.match(guardDoc, /observed detached patch is \*\*not\*\* recovered-completion or lease-release authority/i);
  assert.match(guardDoc, /findCompletedWorktreeIntegration/);
  assert.match(guardDoc, /worktree-integration-required/);
  assert.match(executeSkill, /Multiple concurrent mutating siblings use worktree isolation/);
  assert.match(executeSkill, /hybrid-worktree-owner\/v2/);
  assert.match(executeSkill, /detached patch(?: or worker return)? alone is not completion authority/i);
  assert.match(executeSkill, /completed durable integration journal/i);
  assert.match(executeSkill, /current-workspace mutation guard/);
  assert.match(executeSkill, /Guard completion alone is not release authority/);
  assert.match(executeSkill, /hybrid lease abort/);
  assert.match(executeSkill, /Terminal transitions are cross-process fenced/);
  assert.match(executeSkill, /never create competing terminal IDs/);
  assert.match(guardCore, /WORKSPACE_GUARD_RECONCILIATION_REQUIRED/);
  assert.match(worktreeCore, /hybrid-worktree-owner\/v2/);
  assert.match(worktreeCore, /findCompletedWorktreeIntegration/);
  assert.match(worktreeCore, /hybrid-worktree-integration-receipt\/v1/);
  assert.match(transitionCore, /recoverTaskLease/);
  assert.match(transitionCore, /RECOVERY_INTEGRATION_INVALID/);
  assert.match(transitionCore, /worktree-integration-required/);
});
