import { promises as fs } from 'node:fs';
import path from 'node:path';

export const STATE_SCHEMA = 'hybrid-state/v1';
export const STATE_SCHEMA_VERSION = 1;
const OPEN = '<!-- hybrid-state:v1';
const CLOSE = '-->';

export class StateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StateError';
    this.code = code;
  }
}

export class StateStore {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.planningDir = path.join(this.projectRoot, '.planning');
    this.statePath = path.join(this.planningDir, 'STATE.md');
  }

  async exists() {
    try {
      await fs.access(this.statePath);
      return true;
    } catch {
      return false;
    }
  }

  async init(initial = {}) {
    if (await this.exists()) {
      throw new StateError('STATE.md already exists; initialization is explicit and non-destructive', 'EXISTS');
    }
    const state = normalizeState({ ...initial, revision: initial.revision ?? 1 });
    await this.write(state);
    return state;
  }

  async load() {
    let text;
    try {
      text = await fs.readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new StateError('STATE.md is missing', 'MISSING');
      throw error;
    }

    const state = parseStateDocument(text);
    return normalizeState(state);
  }

  async update(mutator) {
    const current = await this.load();
    const draft = structuredClone(current);
    const next = await mutator(draft);
    const candidate = normalizeState(next || draft);
    candidate.revision = current.revision + 1;
    candidate.updatedAt = new Date().toISOString();
    await this.write(candidate);
    return candidate;
  }

  async write(state) {
    const normalized = normalizeState(state);
    await fs.mkdir(this.planningDir, { recursive: true });

    const tmp = path.join(
      this.planningDir,
      '.STATE.md.tmp-' + process.pid + '-' + Date.now()
    );

    const body = renderStateDocument(normalized);
    await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o644 });
    await fs.rename(tmp, this.statePath);
  }
}

export function renderStateDocument(state) {
  const normalized = normalizeState(state);
  const json = JSON.stringify(normalized, null, 2);
  return [
    '# Project State',
    '',
    OPEN,
    json,
    CLOSE,
    '',
    '## Current',
    '',
    '- Schema: ' + normalized.schema,
    '- Phase: ' + normalized.phase,
    '- Status: ' + normalized.status,
    '- Next action: ' + normalized.nextAction,
    '- Revision: ' + normalized.revision,
    '- Updated: ' + normalized.updatedAt,
    '',
    'This file is canonical project state. Do not silently reconstruct or reset it if the machine-readable block is corrupt or uses an unsupported schema.',
    '',
  ].join('\n');
}

export function parseStateDocument(text) {
  const start = text.indexOf(OPEN);
  if (start < 0) throw new StateError('STATE.md has no hybrid-state marker', 'CORRUPT');

  const jsonStart = start + OPEN.length;
  const end = text.indexOf(CLOSE, jsonStart);
  if (end < 0) throw new StateError('STATE.md state block is unterminated', 'CORRUPT');

  const raw = text.slice(jsonStart, end).trim();
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new StateError('STATE.md contains invalid JSON: ' + error.message, 'CORRUPT');
  }
}

function normalizeState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new StateError('state must be an object', 'INVALID');
  }

  // Backward compatibility: pre-audit v1 state may omit the string schema but
  // already carries schemaVersion=1 and the hybrid-state:v1 document marker.
  if (state.schema != null && state.schema !== STATE_SCHEMA) {
    throw new StateError('unsupported state schema: ' + state.schema, 'UNSUPPORTED_SCHEMA');
  }
  if (
    state.schemaVersion != null &&
    Number(state.schemaVersion) !== STATE_SCHEMA_VERSION
  ) {
    throw new StateError(
      'unsupported state schemaVersion: ' + state.schemaVersion,
      'UNSUPPORTED_SCHEMA'
    );
  }

  return {
    schema: STATE_SCHEMA,
    schemaVersion: STATE_SCHEMA_VERSION,
    phase: String(state.phase || 'bootstrap'),
    status: String(state.status || 'active'),
    nextAction: String(state.nextAction || 'inspect project state'),
    blockers: Array.isArray(state.blockers) ? state.blockers : [],
    activeSpec: state.activeSpec || null,
    activePlan: state.activePlan || null,
    revision: Number.isInteger(state.revision) && state.revision > 0 ? state.revision : 1,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
}
