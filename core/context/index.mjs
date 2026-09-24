import { getOrCreateContextSnapshot } from './cache.mjs';

const DEFAULT_CONTEXT_BUDGET_CHARS = 24000;
const CRITICAL_SECTION_PATTERNS = [
  /^goal$/i,
  /^acceptance criteria$/i,
  /^acceptance$/i,
  /^constraints$/i,
  /^relevant files(?:\/interfaces)?$/i,
  /^relevant interfaces$/i,
  /^dependencies$/i,
  /^decisions$/i,
  /^required verification$/i,
  /^verification$/i,
];

export function buildWorkerContext(task, options = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');

  const context = {
    goal: String(task.goal || ''),
    acceptanceCriteria: unique(task.acceptance_criteria || task.acceptanceCriteria || []),
    constraints: unique(task.constraints || options.constraints || []),
    relevantFiles: unique(task.relevantFiles || task.files_modified || []),
    relevantInterfaces: unique(task.relevantInterfaces || []),
    dependencies: unique(task.depends_on || task.dependencies || []),
    decisions: unique(task.decisions || options.decisions || []),
    requiredVerification: unique(
      task.requiredVerification ??
      (task.verify ? [task.verify] : (options.requiredVerification || []))
    ),
    dependencyOutputs: sanitizeDependencyOutputs(
      task.dependencyOutputs || options.dependencyOutputs || {},
      options
    ),
  };

  if (options.specPath) context.specPath = options.specPath;
  if (options.planPath) context.planPath = options.planPath;
  if (options.phasePath) context.phasePath = options.phasePath;

  return reduceWorkerContext(context, options);
}


export async function buildWorkerContextWithCache(task, options = {}) {
  const context = buildWorkerContext(task, options);
  const reuseCount = Number(options.reuseCount || 0);
  const useCache =
    options.reuseSharedContext === true &&
    reuseCount > 1 &&
    Number(options.tier ?? 1) > 0 &&
    options.repoRoot;

  if (!useCache) {
    return {
      context,
      sharedSnapshot: null,
      cacheUsed: false,
      cacheHit: false,
      cacheError: null,
      cachePath: null,
    };
  }

  const result = await getOrCreateContextSnapshot({
    repoRoot: options.repoRoot,
    gitRevision: options.gitRevision || '',
    spec: options.spec,
    specHash: options.specHash,
    plan: options.plan,
    planHash: options.planHash,
    scope: options.scope || 'quality-closure',
    goal: context.goal,
    acceptanceCriteria: context.acceptanceCriteria,
    constraints: context.constraints,
    relevantInterfaces: context.relevantInterfaces,
    decisions: context.decisions,
    relevantFiles: context.relevantFiles,
  }, {
    runtimeRoot: options.runtimeRoot,
    env: options.env,
    tmpdir: options.tmpdir,
  });

  if (result.cacheError) {
    return {
      context,
      sharedSnapshot: null,
      cacheUsed: true,
      cacheHit: false,
      cacheError: result.cacheError,
      cachePath: result.cachePath,
    };
  }

  return {
    context,
    sharedSnapshot: result.snapshot,
    cacheUsed: true,
    cacheHit: result.cacheHit,
    cacheError: null,
    cachePath: result.cachePath,
  };
}

export function renderWorkerContext(context) {
  return [
    '# Worker Context',
    '',
    '## Goal',
    context.goal || '(missing)',
    '',
    '## Acceptance Criteria',
    bullets(context.acceptanceCriteria),
    '',
    '## Constraints',
    bullets(context.constraints),
    '',
    '## Relevant Files',
    bullets(context.relevantFiles),
    '',
    '## Relevant Interfaces',
    bullets(context.relevantInterfaces),
    '',
    '## Dependencies',
    bullets(context.dependencies),
    '',
    '## Decisions',
    bullets(context.decisions),
    '',
    '## Required Verification',
    bullets(context.requiredVerification),
    '',
    '## Dependency Outputs',
    renderDependencyOutputs(context.dependencyOutputs),
    '',
    context.specPath ? 'SPEC: ' + context.specPath : '',
    context.planPath ? 'PLAN: ' + context.planPath : '',
    context.phasePath ? 'Phase: ' + context.phasePath : '',
    '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

export function measureContext(contextOrText) {
  const text = typeof contextOrText === 'string'
    ? contextOrText
    : renderWorkerContext(contextOrText || {});
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    estimatedTokens: Math.ceil(text.length / 4),
  };
}

export function reduceWorkerContext(context, options = {}) {
  const budgetChars = positiveInt(options.budgetChars, DEFAULT_CONTEXT_BUDGET_CHARS);
  const normalized = structuredClone(context);
  const critical = {
    goal: normalized.goal,
    acceptanceCriteria: normalized.acceptanceCriteria,
    constraints: normalized.constraints,
    relevantFiles: normalized.relevantFiles,
    relevantInterfaces: normalized.relevantInterfaces,
    dependencies: normalized.dependencies,
    decisions: normalized.decisions,
    requiredVerification: normalized.requiredVerification,
  };

  const criticalSize = measureContext({
    ...critical,
    dependencyOutputs: {},
  }).chars;

  // Critical worker contract is never truncated. If it alone exceeds the
  // nominal budget, report that fact by preserving it and dropping optional
  // dependency prose rather than deleting requirements.
  const remaining = Math.max(0, budgetChars - criticalSize - 512);
  normalized.dependencyOutputs = reduceDependencyOutputs(
    normalized.dependencyOutputs || {},
    remaining
  );

  return normalized;
}

export function reduceMarkdownArtifact(markdown, budgetChars) {
  const source = String(markdown || '');
  const budget = Math.max(0, Number(budgetChars) || 0);
  if (!budget || source.length <= budget) return source;

  const sections = parseMarkdownSections(source);
  if (sections.length <= 1) return reducePlainText(source, budget);

  const critical = [];
  const secondary = [];
  for (const section of sections) {
    if (section.heading && CRITICAL_SECTION_PATTERNS.some((pattern) => pattern.test(section.heading))) {
      critical.push(section);
    } else {
      secondary.push(section);
    }
  }

  const chosen = [];
  let used = 0;

  // Preserve all critical sections even if they exceed the nominal budget.
  for (const section of critical) {
    chosen.push(section);
    used += section.raw.length;
  }

  for (const section of secondary) {
    if (used + section.raw.length <= budget) {
      chosen.push(section);
      used += section.raw.length;
    }
  }

  if (!chosen.length) return reducePlainText(source, budget);

  // Restore original document ordering for deterministic prompts.
  chosen.sort((a, b) => a.index - b.index);
  const reduced = chosen.map((section) => section.raw.trimEnd()).join('\n\n').trim();
  const omitted = sections.length - chosen.length;
  return omitted > 0
    ? reduced + '\n\n<!-- context-reduced: omitted ' + omitted + ' lower-priority section(s) -->'
    : reduced;
}

function sanitizeDependencyOutputs(outputs, options) {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return {};
  const filtered = Object.entries(outputs)
    .filter(([key]) => key && key !== 'conversation' && key !== 'fullTranscript')
    .sort(([a], [b]) => a.localeCompare(b));

  return Object.fromEntries(
    filtered.map(([key, value]) => [key, normalizeDependencyValue(value, options)])
  );
}

function normalizeDependencyValue(value, options) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => normalizeDependencyValue(item, options));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 100)
        .map(([key, item]) => [key, normalizeDependencyValue(item, options)])
    );
  }
  return value;
}

function reduceDependencyOutputs(outputs, budgetChars) {
  const entries = Object.entries(outputs || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || budgetChars <= 0) return {};

  const result = {};
  let remaining = budgetChars;

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const slotsLeft = entries.length - i;
    const share = Math.max(256, Math.floor(remaining / slotsLeft));
    const reduced = reduceValue(value, share);
    result[key] = reduced;
    remaining = Math.max(0, remaining - serializedSize(key, reduced));
  }

  return result;
}

function reduceValue(value, budgetChars) {
  if (typeof value === 'string') {
    return looksLikeMarkdown(value)
      ? reduceMarkdownArtifact(value, budgetChars)
      : reducePlainText(value, budgetChars);
  }
  if (Array.isArray(value)) {
    const out = [];
    let remaining = budgetChars;
    for (let i = 0; i < value.length && remaining > 0; i++) {
      const reduced = reduceValue(value[i], Math.max(128, Math.floor(remaining / (value.length - i))));
      out.push(reduced);
      remaining -= JSON.stringify(reduced).length;
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    let remaining = budgetChars;
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < entries.length && remaining > 0; i++) {
      const [key, item] = entries[i];
      const reduced = reduceValue(item, Math.max(128, Math.floor(remaining / (entries.length - i))));
      out[key] = reduced;
      remaining -= serializedSize(key, reduced);
    }
    return out;
  }
  return value;
}

function parseMarkdownSections(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  let current = { index: 0, heading: null, lines: [] };

  const flush = () => {
    if (!current.lines.length) return;
    sections.push({
      index: current.index,
      heading: current.heading,
      raw: current.lines.join('\n'),
    });
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = {
        index: sections.length,
        heading: match[2].trim(),
        lines: [line],
      };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

function looksLikeMarkdown(value) {
  return /^#{1,6}\s+/m.test(value);
}

function reducePlainText(value, budgetChars) {
  const source = String(value || '');
  if (source.length <= budgetChars) return source;
  if (budgetChars <= 64) return '[context reduced]';
  const marker = '\n...[lower-priority context reduced]...\n';
  const available = Math.max(0, budgetChars - marker.length);
  const head = Math.ceil(available * 0.65);
  const tail = available - head;
  return source.slice(0, head) + marker + source.slice(source.length - tail);
}

function serializedSize(key, value) {
  return String(key).length + JSON.stringify(value).length + 4;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((x) => x.trim()).filter(Boolean))];
}

function bullets(values) {
  return values && values.length ? values.map((x) => '- ' + x).join('\n') : '- (none)';
}

function renderDependencyOutputs(outputs) {
  const entries = Object.entries(outputs || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return '- (none)';
  return entries.map(([key, value]) => '- ' + key + ': ' + JSON.stringify(value)).join('\n');
}
