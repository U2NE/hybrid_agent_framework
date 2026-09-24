import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  resolveHybridRuntimeRoot,
  stableHash,
  stableRepoKey,
  stableStringify,
} from '../runtime/index.mjs';

export const CONTEXT_CACHE_SCHEMA = 'hybrid-context-cache/v1';

export async function createContextSnapshot(input = {}) {
  const repoRoot = path.resolve(String(input.repoRoot || '.'));
  const relevantFiles = [...new Set((input.relevantFiles || []).map(String))].sort();
  const fileEntries = [];

  for (const relative of relevantFiles) {
    const absolute = path.resolve(repoRoot, relative);
    let bytes = null;
    try {
      bytes = await fs.readFile(absolute);
    } catch {
      bytes = null;
    }
    fileEntries.push({
      path: normalizeRelative(repoRoot, absolute),
      exists: bytes !== null,
      hash: bytes === null ? null : stableHash(bytes.toString('base64')),
      ...(input.includeFileContent === true && bytes !== null
        ? { content: bytes.toString('utf8') }
        : {}),
    });
  }

  const facts = {
    goal: String(input.goal || ''),
    acceptanceCriteria: unique(input.acceptanceCriteria || input.acceptance_criteria || []),
    constraints: unique(input.constraints || []),
    relevantInterfaces: unique(input.relevantInterfaces || []),
    decisions: unique(input.decisions || []),
  };

  const keyMaterial = {
    schema: CONTEXT_CACHE_SCHEMA,
    repository: stableRepoKey(repoRoot),
    gitRevision: String(input.gitRevision || ''),
    specHash: hashArtifact(input.specHash, input.spec),
    planHash: hashArtifact(input.planHash, input.plan),
    scope: String(input.scope || 'shared'),
    relevantFiles: fileEntries.map(({ path: file, exists, hash }) => ({ path: file, exists, hash })),
    facts,
  };
  const key = stableHash(stableStringify(keyMaterial));

  return {
    schema: CONTEXT_CACHE_SCHEMA,
    key,
    keyMaterial,
    shared: {
      ...facts,
      relevantFiles: fileEntries,
    },
  };
}

export async function getOrCreateContextSnapshot(input = {}, options = {}) {
  const fresh = await createContextSnapshot(input);
  const runtimeRoot = options.runtimeRoot ||
    resolveHybridRuntimeRoot(input.repoRoot || '.', options);
  const cachePath = contextCachePath(runtimeRoot, fresh.key);

  try {
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (
      cached?.schema === CONTEXT_CACHE_SCHEMA &&
      cached?.key === fresh.key &&
      stableHash(stableStringify(cached.keyMaterial)) === stableHash(stableStringify(fresh.keyMaterial))
    ) {
      return {
        snapshot: cached,
        cacheHit: true,
        cachePath,
        cacheError: null,
      };
    }
  } catch {
    // Missing/corrupt/unreadable cache is a safe cache miss.
  }

  let cacheError = null;
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const tmp = cachePath + '.tmp-' + process.pid + '-' + Date.now();
    await fs.writeFile(tmp, JSON.stringify(fresh, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, cachePath);
  } catch (error) {
    cacheError = String(error?.message || error);
  }

  return {
    snapshot: fresh,
    cacheHit: false,
    cachePath,
    cacheError,
  };
}

export function contextCachePath(runtimeRoot, key) {
  return path.join(path.resolve(runtimeRoot), 'cache', 'context', key + '.json');
}

function hashArtifact(explicitHash, artifact) {
  if (explicitHash) return String(explicitHash);
  if (artifact == null) return null;
  return stableHash(
    typeof artifact === 'string' ? artifact : stableStringify(artifact)
  );
}

function normalizeRelative(repoRoot, absolute) {
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, '/');
  return relative.startsWith('../') ? absolute.replace(/\\/g, '/') : relative;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(String).filter(Boolean))];
}
