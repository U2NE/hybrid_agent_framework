import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installProject, validateCodexRuntimeSurface } from '../../scripts/install-project.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const installer = path.join(root, 'scripts', 'install-project.mjs');

async function fixture() {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-install-'));
  await execFileAsync('git', ['init', '-q', target]);
  return target;
}

function noCodexEnv() {
  return { ...process.env, PATH: '/usr/bin:/bin' };
}

test('project installer succeeds without Codex CLI and preserves project-owned config/instructions', async () => {
  const target = await fixture();
  await fs.mkdir(path.join(target, '.codex'), { recursive: true });
  await fs.writeFile(path.join(target, '.codex', 'config.toml'), [
    '[features]',
    'multi_agent = true',
    '',
    '[agents]',
    'max_threads = 4',
    'max_depth = 7',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(target, 'AGENTS.md'), '# Existing Rules\n\nKeep me.\n');

  const { stdout, stderr } = await execFileAsync(process.execPath, [installer, target], { env: noCodexEnv() });
  assert.match(stdout, /Hybrid project installation complete/);
  assert.match(stderr, /Codex CLI validation skipped/);

  const config = await fs.readFile(path.join(target, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /max_threads = 4/);
  assert.match(config, /enabled = true/);
  assert.match(config, /max_depth = 7/);
  assert.match(config, /\[agents\."hybrid-scout"\]/);
  assert.match(config, /config_file = "agents\/hybrid-scout\.toml"/);

  const agents = await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8');
  assert.match(agents, /# Existing Rules/);
  assert.match(agents, /hybrid-agent-framework:start/);
  assert.match(agents, /\$hybrid/);
  assert.match(agents, /Luna effort ladder/);
  assert.match(agents, /session\/default model inheritance is prohibited/i);
  assert.match(agents, /runQualityClosure\(\)/);

  const qualityClosure = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'orchestrator', 'quality-closure.mjs'),
    'utf8'
  );
  assert.match(qualityClosure, /export async function runQualityClosure/);

  const leaseCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'leases', 'index.mjs'),
    'utf8'
  );
  assert.match(leaseCore, /export class ResourceLeaseStore/);
  assert.match(leaseCore, /withGraphRevisionFence/);
  assert.match(leaseCore, /isolationMode/);
  assert.match(leaseCore, /isolation_mode/);

  const executionGraphCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'execution-graph', 'index.mjs'),
    'utf8'
  );
  assert.match(executionGraphCore, /hybrid-exec-graph\/v4/);
  assert.match(executionGraphCore, /EXECUTION_ISOLATION_MISMATCH/);
  assert.match(executionGraphCore, /isolationMode/);
  assert.match(agents, /active dispatch authorization/);
  assert.match(agents, /Initial run graph binding, graph advancement, and lease acquisition share the lease-store revision fence/);
  assert.match(agents, /concurrent conflicting initial descriptors fail closed with one winner/);

  const worktreeCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'worktree', 'index.mjs'),
    'utf8'
  );
  assert.match(worktreeCore, /hybrid-worktree-integration\/v1/);
  assert.match(worktreeCore, /hybrid-worktree-owner\/v2/);
  assert.match(worktreeCore, /readIntegrationJournal/);
  assert.match(worktreeCore, /findCompletedWorktreeIntegration/);
  assert.match(agents, /deterministic durable integration queue/);
  assert.match(agents, /detached observed patch or worker return alone is not successful-completion or lease-release authority/i);
  assert.match(agents, /Both `task_completed` and `recovered_task_completed` under worktree isolation require/i);
  assert.match(agents, /completed integration journal for the exact attempt\/lease/i);
  assert.match(agents, /task-ID deterministic/);

  const workspaceGuardCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'workspace-guard', 'index.mjs'),
    'utf8'
  );
  assert.match(workspaceGuardCore, /WRITE_SET_VIOLATION/);
  assert.match(workspaceGuardCore, /beginCurrentWorkspaceGuard/);
  assert.match(agents, /hybrid workspace-guard begin/);
  assert.match(agents, /hybrid workspace-guard complete/);
  assert.match(agents, /MUST NOT auto-expand the task write set/);

  const installedHelp = await execFileAsync(
    process.execPath,
    [path.join(target, '.hybrid', 'bin', 'hybrid.mjs'), 'help'],
    { cwd: target }
  );
  assert.match(installedHelp.stdout, /hybrid lease acquire/);
  assert.match(installedHelp.stdout, /hybrid lease extend/);
  assert.match(installedHelp.stdout, /hybrid lease release/);
  assert.match(installedHelp.stdout, /hybrid lease abort/);
  assert.match(installedHelp.stdout, /hybrid model-budget reserve/);
  assert.match(installedHelp.stdout, /hybrid model-budget verify/);
  assert.match(installedHelp.stdout, /hybrid revision propose/);
  assert.match(installedHelp.stdout, /hybrid revision apply/);
  assert.match(installedHelp.stdout, /hybrid workspace-guard begin/);
  assert.match(installedHelp.stdout, /hybrid workspace-guard complete/);

  const skill = await fs.readFile(path.join(target, '.agents', 'skills', 'hybrid', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: hybrid\ndescription: .+\n---/m);
  assert.match(skill, /repository-global workspace mutation guard/);
  assert.match(skill, /WRITE_SET_VIOLATION/);
  const executeSkill = await fs.readFile(path.join(target, '.agents', 'skills', 'execute', 'SKILL.md'), 'utf8');
  assert.match(executeSkill, /Multiple concurrent mutating siblings use worktree isolation/);
  assert.match(executeSkill, /hybrid-worktree-owner\/v2/);
  assert.match(executeSkill, /detached patch or worker return alone is not completion authority/i);
  assert.match(executeSkill, /both ordinary `task_completed` and recovery `recovered_task_completed` require/i);
  assert.match(executeSkill, /scheduler-selected isolation mode is sealed in execution graph v4/i);
  assert.match(executeSkill, /completed durable integration journal/i);
  assert.match(executeSkill, /`recovered_task_completed` is recovery-only/i);
  assert.match(executeSkill, /current-workspace mutation guard/);
  assert.match(executeSkill, /hybrid lease extend/);
  assert.match(executeSkill, /drain-required/);
  assert.match(executeSkill, /Guard completion alone is not release authority/);
  assert.match(executeSkill, /hybrid lease abort/);
  assert.match(executeSkill, /ExecutionRunStore\.releaseTaskLease/);
  assert.match(executeSkill, /Terminal transitions are cross-process fenced/);
  assert.match(executeSkill, /Persist only the non-secret `leaseId` plus sealed `descriptorHash`/i);
  assert.match(executeSkill, /recovery must not reuse completion evidence from an older graph revision/i);
  assert.match(executeSkill, /Terminal commit must receive the task's durable dispatch authorization/);
  assert.match(executeSkill, /Persist only the non-secret `leaseId`/);
  assert.match(executeSkill, /never copy the lease token or full authorization/);
  assert.match(executeSkill, /released authorization may replay only its exact existing terminal transition/i);
  await assert.rejects(fs.access(path.join(target, '.codex', 'skills', 'hybrid', 'SKILL.md')));

  const role = await fs.readFile(path.join(target, '.codex', 'agents', 'hybrid-scout.toml'), 'utf8');
  assert.match(role, /^name = "hybrid-scout"$/m);
  assert.match(role, /^description = "Repository scout"$/m);
  assert.match(role, /developer_instructions/);
  assert.doesNotMatch(role, /^model\s*=/m);

  const state = await fs.readFile(path.join(target, '.planning', 'STATE.md'), 'utf8');
  assert.match(state, /hybrid-state:v1/);
  assert.match(state, /"schema": "hybrid-state\/v1"/);

  const approvalCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'approval', 'index.mjs'),
    'utf8'
  );
  assert.match(approvalCore, /export function createUserApprovalReceipt/);
  const installedAgents = await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8');
  assert.match(installedAgents, /User approval is an authority boundary/);
  assert.match(installedAgents, /MUST NOT self-issue a receipt/);
  assert.match(installedAgents, /hybrid revision propose/);
  assert.match(installedAgents, /hybrid revision apply/);
  assert.match(installedAgents, /never reuse the parent approval/);
  assert.match(installedAgents, /hybrid lease extend/);
  assert.match(installedAgents, /drain-required/);
  assert.match(installedAgents, /fresh attempt on that child/);
  assert.match(installedAgents, /Raw token-only\/null-result release is forbidden/);
  assert.match(installedAgents, /task_aborted_reconciled/);
  assert.match(installedAgents, /only one terminal outcome is permitted per descriptor\/revision\/task\/attempt/);
  assert.match(installedAgents, /stale-revision completion is not recovery authority/);
  assert.match(installedAgents, /created with the task dispatch authorization/);
  assert.match(installedAgents, /New terminal creation requires the durable lease to still be active/);
  assert.match(installedAgents, /Never persist the lease token or full authorization/);
  assert.match(installedAgents, /`recovered_task_completed` is recovery-only/i);
  assert.match(installedAgents, /per-run durable model budget/);
  assert.match(installedAgents, /default automatic cap is 3 unique Sol stage-attempts per run/);
  assert.match(installedAgents, /MUST NOT self-issue or fabricate a model-budget approval receipt/);

  const modelBudgetCore = await fs.readFile(
    path.join(target, '.hybrid', 'core', 'routing', 'budget.mjs'),
    'utf8'
  );
  assert.match(modelBudgetCore, /export class ModelBudgetStore/);
  assert.match(modelBudgetCore, /MODEL_BUDGET_USER_APPROVAL_REQUIRED/);

  const routingPolicy = JSON.parse(
    await fs.readFile(path.join(target, '.hybrid', 'core', 'routing', 'model-routing.json'), 'utf8')
  );
  assert.equal(routingPolicy.default_model_tier, 'luna');
  assert.equal(routingPolicy.heavy_model_tier, 'sol');
  assert.equal(routingPolicy.fallback, 'fail-closed');
  assert.equal(routingPolicy.budget_policy.default_max_sol_reservations_per_run, 3);
});

test('installed actor artifact producer contract keeps inspected-only paths out of legacy files for read-only QA roles', async () => {
  const target = await fixture();
  await installProject(target, { skipCodexValidation: true });

  const agents = await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8');
  assert.match(agents, /`inspectedFiles`/);
  assert.match(agents, /`modifiedFiles`/);
  assert.match(agents, /Read-only reviewers\/testers\/verifiers MUST use `modifiedFiles: \[\]`/i);
  assert.match(agents, /MUST NOT put inspected-only paths in legacy `files`/i);
  assert.match(agents, /`files` is compatibility-only for older modified-file claims/i);

  const hybridSkill = await fs.readFile(path.join(target, '.agents', 'skills', 'hybrid', 'SKILL.md'), 'utf8');
  assert.match(hybridSkill, /paths only read\/inspected go in `inspectedFiles`/i);
  assert.match(hybridSkill, /paths actually changed by that actor go in `modifiedFiles`/i);
  assert.match(hybridSkill, /MUST NOT copy inspected paths into legacy `files`/i);

  const executeSkill = await fs.readFile(path.join(target, '.agents', 'skills', 'execute', 'SKILL.md'), 'utf8');
  assert.match(executeSkill, /read-only file observation in `inspectedFiles`/i);
  assert.match(executeSkill, /actual writes in `modifiedFiles`/i);
  assert.match(executeSkill, /must never place inspected-only paths in legacy `files`/i);

  for (const role of ['tester', 'code-reviewer', 'adversarial-reviewer', 'security-reviewer', 'design-reviewer', 'verifier']) {
    const config = await fs.readFile(path.join(target, '.codex', 'agents', 'hybrid-' + role + '.toml'), 'utf8');
    assert.match(config, /put files you only read or inspect in `inspectedFiles`/i, role);
    assert.match(config, /set `modifiedFiles: \[\]`/i, role);
    assert.match(config, /Never put inspected-only paths in legacy `files`/i, role);
  }

  const implementer = await fs.readFile(path.join(target, '.codex', 'agents', 'hybrid-implementer.toml'), 'utf8');
  assert.match(implementer, /files you only inspected in `inspectedFiles`/i);
  assert.match(implementer, /only files you actually changed in `modifiedFiles`/i);
  assert.match(implementer, /Do not emit new `files` claims/i);
});

test('Codex CLI presence adds config validation while missing auth remains runtime pending', async () => {
  const target = await fixture();
  await installProject(target, { skipCodexValidation: true });
  const fake = path.join(target, 'fake-codex.mjs');
  await fs.writeFile(fake, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({',
    '  schemaVersion: 1,',
    '  codexVersion: "0.156.1-test",',
    '  checks: {',
    '    "config.load": { status: "ok", summary: "config loaded" },',
    '    "auth.credentials": { status: "fail", summary: "no Codex credentials were found" }',
    '  }',
    '}));',
    'process.exitCode = 1;',
    '',
  ].join('\n'), { mode: 0o755 });

  const result = await validateCodexRuntimeSurface(target, { codexBin: fake });
  assert.equal(result.configStatus, 'verified');
  assert.equal(result.runtimeStatus, 'pending');
  assert.equal(result.codexVersion, '0.156.1-test');
  assert.match(result.runtimeSummary, /no Codex credentials/);
});

test('installer adds documented concurrency capacity when target has not selected one', async () => {
  const target = await fixture();
  await installProject(target, { skipCodexValidation: true });
  const config = await fs.readFile(path.join(target, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /max_concurrent_threads_per_session = 8/);
});

test('installer preserves existing custom agents and unrelated agent settings', async () => {
  const target = await fixture();
  await fs.mkdir(path.join(target, '.codex'), { recursive: true });
  await fs.writeFile(path.join(target, '.codex', 'config.toml'), [
    '[agents]',
    'enabled = false',
    'max_concurrent_threads_per_session = 7',
    '',
    '[agents.reviewer]',
    'description = "Existing reviewer"',
    'config_file = "agents/reviewer.toml"',
    '',
  ].join('\n'));

  await installProject(target, { skipCodexValidation: true });
  const config = await fs.readFile(path.join(target, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /enabled = true/);
  assert.match(config, /max_concurrent_threads_per_session = 7/);
  assert.match(config, /\[agents\.reviewer\]/);
  assert.match(config, /\[agents\."hybrid-verifier"\]/);
});

test('installer does not overwrite pre-existing project planning docs', async () => {
  const target = await fixture();
  await fs.mkdir(path.join(target, '.planning'), { recursive: true });
  await fs.writeFile(path.join(target, '.planning', 'PROJECT.md'), '# My Existing Project\n');
  await installProject(target, { skipCodexValidation: true });
  assert.equal(await fs.readFile(path.join(target, '.planning', 'PROJECT.md'), 'utf8'), '# My Existing Project\n');
});

test('reinstall is idempotent for managed registrations and AGENTS block', async () => {
  const target = await fixture();
  await installProject(target, { skipCodexValidation: true });
  await installProject(target, { skipCodexValidation: true });
  const config = await fs.readFile(path.join(target, '.codex', 'config.toml'), 'utf8');
  assert.equal((config.match(/hybrid-agent-framework:agents:start/g) || []).length, 1);
  assert.equal((config.match(/\[agents\."hybrid-scout"\]/g) || []).length, 1);
  const agents = await fs.readFile(path.join(target, 'AGENTS.md'), 'utf8');
  assert.equal((agents.match(/hybrid-agent-framework:start/g) || []).length, 1);
});

test('dry run does not write project files', async () => {
  const target = await fixture();
  const { stdout } = await execFileAsync(process.execPath, [installer, target, '--dry-run'], { env: noCodexEnv() });
  assert.match(stdout, /Dry run complete/);
  await assert.rejects(fs.access(path.join(target, '.hybrid', 'manifest.json')));
});


test('installer preserves project-owned ordinary agent files and installs Hybrid-prefixed files', async () => {
  const target = await fixture();
  const dir = path.join(target, '.codex', 'agents');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scout.toml'), 'name = "project-scout"\n');
  await fs.writeFile(path.join(dir, 'planner.toml'), 'name = "project-planner"\n');

  await installProject(target, { skipCodexValidation: true });

  assert.equal(
    await fs.readFile(path.join(dir, 'scout.toml'), 'utf8'),
    'name = "project-scout"\n'
  );
  assert.equal(
    await fs.readFile(path.join(dir, 'planner.toml'), 'utf8'),
    'name = "project-planner"\n'
  );
  assert.match(
    await fs.readFile(path.join(dir, 'hybrid-scout.toml'), 'utf8'),
    /^name = "hybrid-scout"$/m
  );
  const installedPlanner = await fs.readFile(path.join(dir, 'hybrid-planner.toml'), 'utf8');
  assert.match(installedPlanner, /^name = "hybrid-planner"$/m);
  assert.match(installedPlanner, /^sandbox_mode = "read-only"$/m);
  const installedDesignExecutor = await fs.readFile(path.join(dir, 'hybrid-design-executor.toml'), 'utf8');
  assert.match(installedDesignExecutor, /^name = "hybrid-design-executor"$/m);
  assert.match(installedDesignExecutor, /^sandbox_mode = "workspace-write"$/m);
  const installedDesignReviewer = await fs.readFile(path.join(dir, 'hybrid-design-reviewer.toml'), 'utf8');
  assert.match(installedDesignReviewer, /^sandbox_mode = "read-only"$/m);
  const installedAdversarialReviewer = await fs.readFile(path.join(dir, 'hybrid-adversarial-reviewer.toml'), 'utf8');
  assert.match(installedAdversarialReviewer, /^name = "hybrid-adversarial-reviewer"$/m);
  assert.match(installedAdversarialReviewer, /^sandbox_mode = "read-only"$/m);
});

test('installer refuses to overwrite a pre-existing reserved Hybrid agent file on first install', async () => {
  const target = await fixture();
  const dir = path.join(target, '.codex', 'agents');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'hybrid-scout.toml'), 'name = "project-owned"\n');

  await assert.rejects(
    () => installProject(target, { skipCodexValidation: true }),
    /refusing to overwrite pre-existing project agent file/
  );
});

test('installer leaves max_depth absent when the target did not choose one', async () => {
  const target = await fixture();
  await installProject(target, { skipCodexValidation: true });
  const config = await fs.readFile(path.join(target, '.codex', 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /^max_depth\s*=/m);
});
