import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDocumentationDrift } from '../../core/docs/index.mjs';

test('documentation drift selects only durable affected surfaces', () => {
  const result = detectDocumentationDrift({
    files: ['package.json', 'src/api/routes.js', 'tests/api.test.js'],
    description: 'API contract and setup dependency changed',
  });
  assert.equal(result.durableKnowledgeChanged, true);
  assert.ok(result.changedAxes.includes('api'));
  assert.ok(result.changedAxes.includes('dependency'));
  assert.ok(result.changedAxes.includes('testing'));
  assert.ok(result.suggestedDocs.includes('README.md'));
  assert.ok(result.suggestedDocs.includes('docs/API.md'));
});

test('ordinary implementation log does not force durable documentation changes', () => {
  const result = detectDocumentationDrift({
    files: ['src/math/add.js'],
    description: 'Implement arithmetic helper',
  });
  assert.equal(result.durableKnowledgeChanged, false);
  assert.deepEqual(result.suggestedDocs, []);
});
