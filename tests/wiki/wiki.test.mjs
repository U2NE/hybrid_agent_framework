import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestWiki, lintWiki, queryWiki } from '../../core/wiki/index.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-wiki-'));

  await fs.writeFile(path.join(root, 'index.md'), [
    '---',
    'title: Index',
    'updated: 2026-09-20',
    '---',
    '# Index',
    'See [[architecture]].',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(root, 'architecture.md'), [
    '---',
    'title: Architecture',
    'category: architecture',
    'tags: [core, design]',
    'updated: 2025-01-01',
    '---',
    '# Architecture',
    'Uses [[missing-page]].',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(root, 'orphan.md'), [
    '---',
    'title: Orphan',
    'updated: 2026-09-20',
    '---',
    '# Orphan',
    'No incoming refs.',
    '',
  ].join('\n'));

  return root;
}

test('wiki lint detects broken links, orphan pages, and stale docs', async () => {
  const root = await fixture();
  const result = await lintWiki({
    root,
    now: new Date('2026-09-24T00:00:00Z'),
    staleDays: 45,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.brokenLinks, [{ page: 'architecture', target: 'missing-page' }]);
  assert.ok(result.orphanPages.includes('orphan'));
  assert.ok(result.stalePages.includes('architecture'));
});

test('wiki query filters by category and terms', async () => {
  const root = await fixture();
  const result = await queryWiki({ root, query: 'architecture core', category: 'architecture' });
  assert.equal(result[0].page, 'architecture');
});

test('wiki ingest writes a durable derived page that can be queried', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-wiki-ingest-'));
  await ingestWiki({
    root,
    slug: 'debugging-auth',
    title: 'Auth Debugging',
    category: 'debugging',
    tags: ['auth', 'debugging'],
    body: 'Token refresh failures are diagnosed at the boundary.',
    updated: new Date('2026-09-24T00:00:00Z'),
  });
  const result = await queryWiki({ root, query: 'token refresh', category: 'debugging' });
  assert.equal(result[0].page, 'debugging-auth');
});
