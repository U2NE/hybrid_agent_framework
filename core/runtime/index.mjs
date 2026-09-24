import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const RUNTIME_SCHEMA = 'hybrid-runtime/v1';

export function stableRepoKey(repoRoot) {
  const absolute = path.resolve(String(repoRoot || '.'));
  return createHash('sha256').update(absolute).digest('hex').slice(0, 24);
}

export function resolveHybridRuntimeRoot(repoRoot, options = {}) {
  const env = options.env || process.env;
  if (env.HYBRID_RUNTIME_DIR) return path.resolve(env.HYBRID_RUNTIME_DIR);
  const tmp = options.tmpdir || os.tmpdir();
  return path.join(tmp, 'hybrid-agent-framework', stableRepoKey(repoRoot));
}

export function stableHash(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  return createHash('sha256').update(text).digest('hex');
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortValue(item)])
  );
}
