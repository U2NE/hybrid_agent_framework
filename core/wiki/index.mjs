import { promises as fs } from 'node:fs';
import path from 'node:path';

const WIKI_REF = /\[\[([^\]]+)\]\]/g;

export async function ingestWiki({ root, slug, title, category = 'uncategorized', tags = [], body, updated = new Date() }) {
  const safeSlug = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(safeSlug)) throw new Error('unsafe wiki slug');
  if (typeof body !== 'string' || !body.trim()) throw new Error('wiki body is required');

  const normalizedTags = [...new Set((Array.isArray(tags) ? tags : []).map(String).map((x) => x.trim()).filter(Boolean))];
  const date = updated instanceof Date ? updated : new Date(updated);
  if (Number.isNaN(date.getTime())) throw new Error('invalid wiki updated date');

  const page = [
    '---',
    'title: ' + String(title || safeSlug),
    'category: ' + String(category || 'uncategorized'),
    'tags: [' + normalizedTags.join(', ') + ']',
    'updated: ' + date.toISOString().slice(0, 10),
    '---',
    '# ' + String(title || safeSlug),
    '',
    body.trim(),
    '',
  ].join('\n');

  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, safeSlug + '.md');
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(temp, page, 'utf8');
  await fs.rename(temp, target);
  return { slug: safeSlug, path: target };
}

export async function lintWiki({ root, now = new Date(), staleDays = 45, maxBytes = 20000 }) {
  const pages = await loadWikiPages(root);
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const incoming = new Map(pages.map((page) => [page.slug, 0]));
  const brokenLinks = [];

  for (const page of pages) {
    for (const ref of page.links) {
      if (!bySlug.has(ref)) {
        brokenLinks.push({ page: page.slug, target: ref });
      } else {
        incoming.set(ref, (incoming.get(ref) || 0) + 1);
      }
    }
  }

  const stalePages = pages
    .filter((page) => isStale(page.meta.updated, now, staleDays))
    .map((page) => page.slug);

  const oversizedPages = pages
    .filter((page) => page.bytes > maxBytes)
    .map((page) => ({ page: page.slug, bytes: page.bytes }));

  const orphanPages = pages
    .filter((page) => page.slug !== 'index' && (incoming.get(page.slug) || 0) === 0)
    .map((page) => page.slug);

  const contradictions = findStructuralContradictions(pages);

  return {
    ok:
      brokenLinks.length === 0 &&
      stalePages.length === 0 &&
      oversizedPages.length === 0 &&
      orphanPages.length === 0 &&
      contradictions.length === 0,
    brokenLinks,
    stalePages,
    oversizedPages,
    orphanPages,
    contradictions,
    pageCount: pages.length,
  };
}

export async function queryWiki({ root, query, category = null, tags = [] }) {
  const terms = tokenize(query);
  const pages = await loadWikiPages(root);

  return pages
    .filter((page) => !category || page.meta.category === category)
    .filter((page) => !tags.length || tags.every((tag) => page.meta.tags.includes(tag)))
    .map((page) => {
      const haystack = tokenize(page.title + ' ' + page.content + ' ' + page.meta.tags.join(' '));
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { page: page.slug, title: page.title, score, category: page.meta.category };
    })
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((a, b) => b.score - a.score || a.page.localeCompare(b.page));
}

export async function loadWikiPages(root) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const pages = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(root, entry.name);
    const content = await fs.readFile(filePath, 'utf8');
    const stat = await fs.stat(filePath);
    const parsed = parseFrontmatter(content);
    const slug = entry.name.replace(/\.md$/, '');
    pages.push({
      slug,
      title: parsed.meta.title || firstHeading(parsed.body) || slug,
      meta: {
        category: parsed.meta.category || 'uncategorized',
        tags: splitList(parsed.meta.tags),
        updated: parsed.meta.updated || null,
        canonical: parsed.meta.canonical || null,
        status: parsed.meta.status || null,
        value: parsed.meta.value || null,
      },
      links: [...parsed.body.matchAll(WIKI_REF)].map((match) => match[1].trim()),
      content: parsed.body,
      bytes: stat.size,
    });
  }
  return pages;
}

export function findStructuralContradictions(pages) {
  const groups = new Map();

  for (const page of pages) {
    if (!page.meta.canonical) continue;
    const list = groups.get(page.meta.canonical) || [];
    list.push(page);
    groups.set(page.meta.canonical, list);
  }

  const contradictions = [];
  for (const [canonical, group] of groups) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map((p) => JSON.stringify([p.meta.status, p.meta.value])));
    if (signatures.size > 1) {
      contradictions.push({
        canonical,
        pages: group.map((p) => p.slug),
      });
    }
  }
  return contradictions;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(4, end).split('\n')) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { meta, body: text.slice(end + 5) };
}

function splitList(value) {
  if (!value) return [];
  const stripped = String(value).replace(/^\[/, '').replace(/\]$/, '');
  return stripped.split(',').map((x) => x.trim()).filter(Boolean);
}

function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣_-]+/u)
    .filter(Boolean);
}

function isStale(updated, now, staleDays) {
  if (!updated) return false;
  const date = new Date(updated);
  if (Number.isNaN(date.getTime())) return true;
  return now.getTime() - date.getTime() > staleDays * 24 * 60 * 60 * 1000;
}
