#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StateStore } from '../core/state/index.mjs';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(scriptPath), '..');

const HYBRID_ROLES = Object.freeze({
  scout: 'Repository scout',
  researcher: 'Technical researcher and requirements analyst',
  planner: 'Execution planner',
  'design-architect': 'UI design architect',
  'design-executor': 'Leased UI design implementation worker',
  'design-reviewer': 'Independent UI design reviewer',
  architect: 'Architecture reviewer',
  'plan-auditor': 'Plan auditor',
  implementer: 'Implementation worker',
  tester: 'Independent tester',
  'code-reviewer': 'Independent code reviewer',
  'adversarial-reviewer': 'Independent adversarial break-it reviewer',
  'security-reviewer': 'Conditional security reviewer',
  verifier: 'Final verifier',
  'knowledge-synthesizer': 'Knowledge synthesizer',
});

const CONFIG_START = '# hybrid-agent-framework:agents:start';
const CONFIG_END = '# hybrid-agent-framework:agents:end';

if (isMainModule()) {
  const target = path.resolve(process.argv[2] || '.');
  const dryRun = process.argv.includes('--dry-run');

  try {
    const result = await installProject(target, { dryRun });
    console.log(dryRun ? 'Dry run complete.' : 'Hybrid project installation complete.');

    if (!dryRun && result.codexValidation) {
      const validation = result.codexValidation;
      if (validation.status === 'skipped') {
        console.warn('WARN: Codex CLI validation skipped: ' + validation.reason);
      } else {
        console.log(
          'Codex validation: config=' + validation.configStatus +
          ', runtime=' + validation.runtimeStatus +
          (validation.codexVersion ? ', version=' + validation.codexVersion : '')
        );
      }
    }
  } catch (error) {
    console.error('install-project:', error.message);
    process.exitCode = 1;
  }
}

export async function installProject(targetRoot, options = {}) {
  const root = path.resolve(targetRoot);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('target is not a directory: ' + root);
  if (!(await exists(path.join(root, '.git')))) {
    throw new Error('target must be a git repository (missing .git): ' + root);
  }

  const operations = [];

  for (const dir of ['core', 'bin', 'LICENSES']) {
    await collectTreeCopies(path.join(sourceRoot, dir), path.join(root, '.hybrid', dir), operations);
  }

  operations.push({
    kind: 'copy',
    source: path.join(sourceRoot, 'LICENSE'),
    target: path.join(root, '.hybrid', 'LICENSE'),
  });

  // Installed custom-agent registrations and files both use the Hybrid prefix.
  // This avoids overwriting a target repository's own scout.toml/planner.toml
  // and similar conventional role filenames.
  const priorHybridInstall = await exists(path.join(root, '.hybrid', 'manifest.json'));
  for (const role of Object.keys(HYBRID_ROLES)) {
    const source = path.join(sourceRoot, '.codex', 'agents', role + '.toml');
    const agentContent = await fs.readFile(source, 'utf8');
    const installedRole = roleName(role);
    const target = path.join(root, '.codex', 'agents', installedRole + '.toml');

    if (!priorHybridInstall && await exists(target)) {
      throw new Error('refusing to overwrite pre-existing project agent file: ' + target);
    }

    operations.push({
      kind: 'write',
      target,
      content: renderInstalledAgentConfig(agentContent, role),
    });
  }

  // Current repository-local Codex skill discovery uses .agents/skills/.
  // Installation copies the single canonical source instead of creating a
  // second editable framework source tree in the target repository.
  for (const skill of ['hybrid', 'clarify', 'plan', 'execute', 'review', 'wiki']) {
    operations.push({
      kind: 'copy',
      source: path.join(sourceRoot, 'skills', skill, 'SKILL.md'),
      target: path.join(root, '.agents', 'skills', skill, 'SKILL.md'),
    });
  }

  const manifest = {
    name: 'codex-hybrid-agent-framework',
    version: '0.1.0',
    installedAt: new Date().toISOString(),
    codexSurface: {
      roles: '.codex/config.toml + .codex/agents/hybrid-*.toml',
      skills: '.agents/skills/*/SKILL.md',
    },
    modelRouting: {
      policy: '.hybrid/core/routing/model-routing.json',
      defaultRoute: 'luna_medium',
      fallback: 'fail-closed',
    },
    sourceUpstreams: {
      gsdCore: '9db80da9a047ddaa9cc8812a5d6adab446fe8433',
      ohMyClaudecode: '9fd35ece5d6de65b511bf43b55e42c499e4fc194',
    },
  };

  operations.push({
    kind: 'write',
    target: path.join(root, '.hybrid', 'manifest.json'),
    content: JSON.stringify(manifest, null, 2) + '\n',
  });

  const configPath = path.join(root, '.codex', 'config.toml');
  const oldConfig = await readOptional(configPath);
  operations.push({
    kind: 'write',
    target: configPath,
    content: ensureCurrentAgentsConfig(oldConfig || ''),
  });

  const agentsPath = path.join(root, 'AGENTS.md');
  const oldAgents = await readOptional(agentsPath);
  operations.push({
    kind: 'write',
    target: agentsPath,
    content: mergeAgentsInstructions(oldAgents || ''),
  });

  const bootstrapDocs = {
    '.planning/PROJECT.md':
      '# Project\n\nProject context has not been synthesized yet. Run the Hybrid scout/requirements flow before complex implementation.\n',
    '.planning/REQUIREMENTS.md':
      '# Requirements\n\nNo durable requirements captured yet.\n',
    '.planning/ROADMAP.md':
      '# Roadmap\n\nNo project roadmap captured yet.\n',
    '.ai/wiki/index.md':
      '---\ntitle: Project Wiki\ncategory: index\ntags: [index]\n---\n# Project Wiki\n\nDerived knowledge projection. Canonical state is under `.planning/`.\n',
  };

  for (const [relative, bootstrapContent] of Object.entries(bootstrapDocs)) {
    const targetPath = path.join(root, relative);
    if (!(await exists(targetPath))) {
      operations.push({ kind: 'write', target: targetPath, content: bootstrapContent });
    }
  }

  if (options.dryRun) {
    for (const op of operations) console.log(op.kind + ' ' + path.relative(root, op.target));
    if (!(await exists(path.join(root, '.planning', 'STATE.md')))) {
      console.log('init .planning/STATE.md');
    }
    return {
      root,
      operations: operations.length,
      dryRun: true,
      codexValidation: { status: 'skipped', reason: 'dry-run' },
    };
  }

  for (const op of operations) {
    await fs.mkdir(path.dirname(op.target), { recursive: true });
    if (op.kind === 'copy') await fs.copyFile(op.source, op.target);
    else await atomicWrite(op.target, op.content);
  }

  const stateStore = new StateStore(root);
  if (!(await stateStore.exists())) {
    await stateStore.init({
      phase: 'onboarding',
      status: 'active',
      nextAction: 'classify request and scout repository',
    });
  }

  const codexValidation = options.skipCodexValidation
    ? { status: 'skipped', reason: 'disabled by caller' }
    : await validateCodexRuntimeSurface(root, { codexBin: options.codexBin });

  return {
    root,
    operations: operations.length,
    dryRun: false,
    codexValidation,
  };
}

export function renderInstalledAgentConfig(content, role) {
  const expected = new RegExp(
    '^name\\s*=\\s*"' + escapeRegExp(role) + '"\\s*$',
    'm'
  );
  if (!expected.test(content)) {
    throw new Error('source agent config has no matching name field for role: ' + role);
  }
  return content.replace(expected, 'name = "hybrid-' + role + '"');
}

export async function validateCodexRuntimeSurface(root, options = {}) {
  const codexBin = options.codexBin || await findExecutable('codex');
  if (!codexBin) {
    return {
      status: 'skipped',
      reason: 'codex CLI not found on PATH; project-local agents/skills remain installed',
      configStatus: 'not-run',
      runtimeStatus: 'not-run',
      codexVersion: null,
    };
  }

  // Treat the project .codex directory as an isolated CODEX_HOME so doctor
  // validates the generated config and role layers without mutating user state.
  const isolatedHome = path.join(root, '.codex');
  const schemaRun = await runDoctor(codexBin, root, {
    ...process.env,
    CODEX_HOME: isolatedHome,
  }, true);

  // Runtime readiness is intentionally separate. A missing login/API key is a
  // pending runtime validation, not an installer failure.
  const runtimeRun = await runDoctor(codexBin, root, process.env, false);

  const configCheck = schemaRun.report?.checks?.['config.load'];
  const authCheck = runtimeRun.report?.checks?.['auth.credentials'];
  const configStatus = configCheck?.status === 'ok' ? 'verified' : 'warning';
  const runtimeStatus = authCheck?.status === 'ok' ? 'ready' : 'pending';

  return {
    status: configStatus === 'verified' ? 'ok' : 'warning',
    configStatus,
    runtimeStatus,
    codexVersion: schemaRun.report?.codexVersion || runtimeRun.report?.codexVersion || null,
    configSummary: configCheck?.summary || schemaRun.error || 'config validation unavailable',
    runtimeSummary: authCheck?.summary || runtimeRun.error || 'runtime validation unavailable',
  };
}

export function ensureCurrentAgentsConfig(content) {
  const eol = String(content || '').includes('\r\n') ? '\r\n' : '\n';
  let text = String(content || '').replace(/\r\n/g, '\n');

  // Replace only the block previously managed by Hybrid.
  const managedStart = text.indexOf(CONFIG_START);
  const managedEnd = text.indexOf(CONFIG_END);
  if (managedStart >= 0 && managedEnd >= managedStart) {
    text = text.slice(0, managedStart) + text.slice(managedEnd + CONFIG_END.length);
  }

  let lines = text.split('\n');

  // Refuse to shadow a user-defined role with a reserved Hybrid-prefixed name.
  for (const role of Object.keys(HYBRID_ROLES)) {
    const escaped = escapeRegExp('hybrid-' + role);
    const conflict = new RegExp(
      '^\\s*\\[agents\\.(?:"' + escaped + '"|' + escaped + ')\\]\\s*$'
    );
    if (lines.some((line) => conflict.test(line))) {
      throw new Error('target already defines reserved Hybrid agent role: hybrid-' + role);
    }
  }

  // Flatness is enforced by lead-only sibling dispatch and worker
  // no-delegation instructions. Preserve a target-owned max_depth exactly when
  // present; Hybrid does not depend on rewriting it. Add only documented
  // concurrency capacity when the target has not selected a thread limit.
  const agentsIndex = lines.findIndex((line) => line.trim() === '[agents]');
  if (agentsIndex >= 0) {
    const end = sectionEnd(lines, agentsIndex);
    const enabledIndex = findKey(lines, agentsIndex + 1, end, 'enabled');
    const concurrentIndex = findKey(
      lines,
      agentsIndex + 1,
      end,
      'max_concurrent_threads_per_session'
    );
    const legacyThreadsIndex = findKey(lines, agentsIndex + 1, end, 'max_threads');

    if (enabledIndex >= 0) lines[enabledIndex] = 'enabled = true';

    const additions = [];
    if (enabledIndex < 0) additions.push('enabled = true');
    if (concurrentIndex < 0 && legacyThreadsIndex < 0) {
      additions.push('max_concurrent_threads_per_session = 8');
    }
    if (additions.length) lines.splice(agentsIndex + 1, 0, ...additions);
  } else {
    const firstAgentChild = lines.findIndex((line) => /^\s*\[agents\./.test(line));
    const rootBlock = [
      '[agents]',
      'enabled = true',
      'max_concurrent_threads_per_session = 8',
      '',
    ];

    if (firstAgentChild >= 0) lines.splice(firstAgentChild, 0, ...rootBlock);
    else {
      while (lines.length && lines.at(-1).trim() === '') lines.pop();
      if (lines.length) lines.push('');
      lines.push(...rootBlock);
    }
  }

  while (lines.length && lines.at(-1).trim() === '') lines.pop();
  if (lines.length) lines.push('');

  lines.push(CONFIG_START);
  for (const [role, description] of Object.entries(HYBRID_ROLES)) {
    lines.push(`[agents."${roleName(role)}"]`);
    lines.push('description = ' + JSON.stringify(description));
    lines.push('config_file = ' + JSON.stringify('agents/' + roleName(role) + '.toml'));
    lines.push('');
  }
  lines.push(CONFIG_END);

  return lines.join(eol).trimEnd() + eol;
}

// Backward-compatible exported name for callers/tests created during bootstrap.
export const ensureFlatAgentsConfig = ensureCurrentAgentsConfig;

export function mergeAgentsInstructions(content) {
  const start = '<!-- hybrid-agent-framework:start -->';
  const end = '<!-- hybrid-agent-framework:end -->';
  const block = [
    start,
    '## Hybrid Agent Framework',
    '',
    '- For feature, fix, refactor, or implementation requests, invoke `$hybrid` first.',
    '- Tier 0/1 work should load only the relevant files; do not read the whole planning tree for a tiny change.',
    '- For Tier 2/3 work or resume/recovery, read `.planning/PROJECT.md`, `.planning/STATE.md`, then the active SPEC/PLAN.',
    '- Use `.planning/` as canonical state; `.ai/wiki/` is derived.',
    '- Scout the repository before asking user questions that code can answer.',
    '- Keep dispatch flat: only the lead spawns sibling Hybrid roles; workers return results and never recursively delegate.',
    '- Enforce role capabilities through `.hybrid/core/capabilities/index.mjs`: planners/reviewers/testers/verifiers are read-only, mutating tasks must belong to an authorized writer role, and sealed execution graphs carry the deterministic capability grant.',
    '- User approval is an authority boundary. For any execution path requiring approval, first expose the exact `approvalSubject` (run/spec/plan hashes), then accept an `approvalReceipt` only after an explicit user approval event. Lead/worker agents MUST NOT self-issue a receipt and treat it as user approval. A receipt is integrity-bound through `.hybrid/core/approval/index.mjs`; non-material scheduling/resource amendments may preserve it. For a product/API/schema/scope/requirement/security semantic revision, use `hybrid revision propose` to bind a changed PLAN/SPEC to the current parent graph, obtain a fresh explicit user receipt, then use `hybrid revision apply`; never reuse the parent approval or mutate/publish the child before approval.',
    '- For material visual/UI work, use the conditional design lane: Design Architect returns a read-only design contract, Design Executor owns only explicitly leased `ui:<surface>` plus file resources, and Design Reviewer independently checks the result. Do not duplicate the same implementation across Design Executor and Implementer.',
    '- Serialize same-file writers and respect task dependencies. Multiple concurrent mutating siblings use worktree isolation. When scheduler isolation selects worktree mode, the lead owns create → isolated cwd → observed patch handoff → deterministic durable integration queue → verification → cleanup via `.hybrid/core/worktree/index.mjs`. Integration order is task-ID deterministic, not worker-completion order; concurrent integrators must serialize on the durable queue, and unexplained restart/workspace state fails closed for reconciliation. When a mutating task runs in current-workspace mode, after lease acquisition run `hybrid workspace-guard begin` before spawn and `hybrid workspace-guard complete` after the worker returns; after guard completion, commit a durable terminal `task_completed`/`recovered_task_completed` transition with evidence and release the lease through that transition; guard completion alone is not release authority. `WRITE_SET_VIOLATION` or `WORKSPACE_BASE_MOVED` requires reconciliation and MUST NOT auto-expand the task write set.',
    '- Before spawning any mutating task, acquire its durable pre-execution resource lease from the current sealed graph through `.hybrid/core/leases/index.mjs` (or `node .hybrid/bin/hybrid.mjs lease acquire ...`). A spawn without a current active dispatch authorization is not permitted. Lease conflicts fail closed; never bypass them by launching another worker. Release only through `ExecutionRunStore.releaseTaskLease()` (or `hybrid lease release`) using a durable terminal transition that matches the exact graph/task/attempt and has evidence. Transition commits are cross-process serialized through the durable run ledger; only one terminal outcome is permitted per graph/task/attempt, and competing terminal IDs must fail closed. Raw token-only/null-result release is forbidden. For an abandoned attempt, use `hybrid lease abort` with reconciliation evidence so `task_aborted_reconciled` is durably committed before release. Initial run graph binding, graph advancement, and lease acquisition share the lease-store revision fence; concurrent conflicting initial descriptors fail closed with one winner. Do not advance to a child execution graph while any lease on the current graph remains active. If a worker discovers an additional non-material semantic resource requirement, use `hybrid lease extend`: it never mutates the live authorization in place. Active old-revision leases yield `drain-required`; complete them with a durable terminal transition or reconcile them through `hybrid lease abort`, then evidence-bound release them, retry the extension to publish the child graph, and acquire a fresh attempt on that child. File/read/write contract changes or material product/API/schema/scope/security changes must use the material revision approval path.',
    '- Route automatic work through the ordered Luna effort ladder first; static difficulty may raise a stage to Luna max, but Sol is entered only after Luna max is actually exhausted for that affected stage, according to `.hybrid/core/routing/model-routing.json`.',
    '- Sol execution is additionally gated by the per-run durable model budget in `.hybrid/core/routing/budget.mjs`. Before every Sol spawn, reserve the exact stage/attempt route, retain the returned budget authorization, and verify it immediately before spawn. The default automatic cap is 3 unique Sol stage-attempts per run; once exhausted, stop for explicit user approval. Lead/worker agents MUST NOT self-issue or fabricate a model-budget approval receipt to raise the cap.',
    '- Every Hybrid-controlled inference must use the explicit allowlisted model and reasoning effort resolved by `.hybrid/core/routing/model-routing.json`; session/default model inheritance is prohibited. Pass both values explicitly on every worker spawn and record bounded `requestedModel` / `requestedReasoningEffort` metadata in linked provenance. If the routed override is unavailable or rejected, fail closed without retrying model-less or substituting another model.',
    '- Separate implementation from final testing/review/verification. Normal Tier 0 task mutation is owned by one Implementer followed by lightweight verification; the Lead MUST NOT substitute for that Implementer. Before any Implementer-owned mutation, run the provenance-wired preparation path and spawn the required Implementer. If the required worker cannot be spawned, fail closed without mutating its files.',
    '- Keep review responsibilities distinct: Code Reviewer checks SPEC/correctness/regression evidence, while Adversarial Reviewer is read-only and actively searches for counterexamples, invariant violations, boundary/concurrency/retry/recovery failures on complex or explicitly high-regression-risk work. Do not add the adversarial lane to routine Tier 0/1 work.',
    '- Use `.hybrid/core/orchestrator/index.mjs` `prepareExecutionWithProvenance()` for normal installed execution preparation. Finalize task normalization/classification first (pure `prepareExecution()` may be used for zero-I/O inspection), then call the wired wrapper exactly once for the selected execution revision. Do not persist trial preparations or manually replay `decisionTrace`.',
    '- Preserve the Tier 0 fast path: Implementer → deterministic lightweight verification → Lead-owned completion provenance/audit, with no routine QA fan-out. When the existing tier/risk path requires generic quality closure, use `runQualityClosure()` from `.hybrid/core/orchestrator/index.mjs`; its default path owns Lead decision/event persistence, repair/proof reassessment, and completion gating without adding a new agent role.',
    '- Keep Decision Provenance passive and structured: the lead alone writes central orchestration decisions; workers return bounded metadata and may write only their own actor artifact through the worker-scoped API.',
    '- Central action-bearing events must use the Lead-owned orchestration event writer (or Lead provenance session). When an action belongs to an existing decision, retain/load that decision object and use `writeActionForDecision(decision, event)` rather than manually transcribing its decision ID or routed model metadata. Public low-level `appendRuntimeEvent()` is passive-only and cannot write decision/action ownership records.',
    '- Each implementation worker writes one bounded completion self-report only to its own actor artifact; worker self-reports remain `reported`. Use an observed native worker ID when available, otherwise explicitly distinguish a framework-logical worker ID.',
    '- Link actual orchestration actions to their decisions when available. Runtime events record what happened, Decision Provenance records the selected control-flow action, actor artifacts record bounded worker activity, and deterministic audit checks their agreement.',
    '- Before provenance-backed completion, the Lead runs installed `auditDecisionTrace()` over the run decisions/events/actor artifacts and persists the derived `audit.json` through `writeAuditArtifact()` or the Lead provenance session.',
    '- Never record chain-of-thought, hidden reasoning, scratchpads, prompts, conversations, source text, whole diffs, or raw secret-bearing output in runtime events, decisions, actor artifacts, or audit reports.',
    '- Run security review only for trust-boundary-sensitive changes.',
    '- Stop targeted fix loops after three iterations and preserve failure evidence.',
    '- Hybrid deterministic helpers are available with `node .hybrid/bin/hybrid.mjs help`.',
    end,
  ].join('\n');

  const current = String(content || '');
  const startAt = current.indexOf(start);
  const endAt = current.indexOf(end);

  if (startAt >= 0 && endAt >= startAt) {
    return current.slice(0, startAt) + block + current.slice(endAt + end.length);
  }

  const prefix = current.trimEnd();
  return (prefix ? prefix + '\n\n' : '') + block + '\n';
}

async function collectTreeCopies(source, target, operations, filter = () => true) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await collectTreeCopies(from, to, operations, filter);
    else if (entry.isFile() && filter(entry.name)) {
      operations.push({ kind: 'copy', source: from, target: to });
    }
  }
}

async function atomicWrite(target, content) {
  const temp = target + '.hybrid-tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, target);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32'
    ? [name + '.exe', name + '.cmd', name + '.bat', name]
    : [name];

  for (const dir of pathEntries) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (await exists(full)) return full;
    }
  }
  return null;
}

async function runDoctor(codexBin, root, env, strict) {
  const args = strict ? ['--strict-config', 'doctor', '--json'] : ['doctor', '--json'];

  try {
    const { stdout, stderr } = await execFileAsync(codexBin, args, {
      cwd: root,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { report: parseDoctor(stdout), error: stderr || null };
  } catch (error) {
    return {
      report: parseDoctor(error.stdout),
      error: String(error.stderr || error.message || 'codex doctor failed').trim(),
    };
  }
}

function parseDoctor(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout));
  } catch {
    return null;
  }
}

function sectionEnd(lines, sectionIndex) {
  let end = sectionIndex + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return end;
}

function findKey(lines, start, end, key) {
  const pattern = new RegExp('^\\s*' + escapeRegExp(key) + '\\s*=');
  for (let i = start; i < end; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function roleName(role) {
  return 'hybrid-' + role;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(scriptPath);
}
