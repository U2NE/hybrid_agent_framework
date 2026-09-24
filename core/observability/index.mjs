import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveHybridRuntimeRoot } from '../runtime/index.mjs';

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[_-]?key|credential/i;
const OMIT_KEY = /^(?:prompt|fullPrompt|conversation|fullConversation|hiddenReasoning|reasoning|sourceCode|rawSource)$/i;

export function sanitizeRuntimeEvent(event = {}) {
  const source = event && typeof event === 'object' ? event : {};
  const safe = sanitizeValue(source);
  return {
    timestamp: source.timestamp || new Date().toISOString(),
    ...safe,
  };
}

export async function appendRuntimeEvent(input = {}, options = {}) {
  const repoRoot = input.repoRoot || options.repoRoot || '.';
  const runtimeRoot = options.runtimeRoot ||
    resolveHybridRuntimeRoot(repoRoot, options);
  const runId = safeSegment(input.runId || 'run');
  const eventPath = path.join(runtimeRoot, 'runs', runId, 'events.jsonl');
  const event = sanitizeRuntimeEvent(input.event || input);

  try {
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.appendFile(eventPath, JSON.stringify(event) + '\n', 'utf8');
    return { ok: true, eventPath, event };
  } catch (error) {
    return {
      ok: false,
      eventPath,
      event,
      error: String(error?.message || error),
    };
  }
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (OMIT_KEY.test(key)) continue;
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeValue(item);
  }
  return out;
}

function safeSegment(value) {
  return String(value || 'run')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'run';
}
