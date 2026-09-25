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

  const skill = await fs.readFile(path.join(target, '.agents', 'skills', 'hybrid', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: hybrid\ndescription: .+\n---/m);
  await assert.rejects(fs.access(path.join(target, '.codex', 'skills', 'hybrid', 'SKILL.md')));

  const role = await fs.readFile(path.join(target, '.codex', 'agents', 'hybrid-scout.toml'), 'utf8');
  assert.match(role, /^name = "hybrid-scout"$/m);
  assert.match(role, /^description = "Repository scout"$/m);
  assert.match(role, /developer_instructions/);
  assert.doesNotMatch(role, /^model\s*=/m);

  const state = await fs.readFile(path.join(target, '.planning', 'STATE.md'), 'utf8');
  assert.match(state, /hybrid-state:v1/);
  assert.match(state, /"schema": "hybrid-state\/v1"/);

  const routingPolicy = JSON.parse(
    await fs.readFile(path.join(target, '.hybrid', 'core', 'routing', 'model-routing.json'), 'utf8')
  );
  assert.equal(routingPolicy.default_model_tier, 'luna');
  assert.equal(routingPolicy.heavy_model_tier, 'sol');
  assert.equal(routingPolicy.fallback, 'fail-closed');
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
  assert.match(
    await fs.readFile(path.join(dir, 'hybrid-planner.toml'), 'utf8'),
    /^name = "hybrid-planner"$/m
  );
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
