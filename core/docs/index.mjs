export const DOC_DRIFT_AXES = Object.freeze([
  'architecture',
  'api',
  'responsibility',
  'dependency',
  'setup',
  'testing',
  'state',
  'decision',
]);

export function detectDocumentationDrift(change = {}) {
  const files = (change.files || []).map(String);
  const text = [change.description || '', ...(change.tags || []), ...files].join(' ').toLowerCase();

  const impact = {
    architecture: change.architectureChanged === true || /architecture|component|module boundary|dataflow/.test(text),
    api: change.apiChanged === true || /api|route|endpoint|schema|contract|interface/.test(text),
    responsibility: change.responsibilityChanged === true || /responsibilit|ownership|module move|rename/.test(text),
    dependency: change.dependencyChanged === true || /package\.json|lockfile|dependency|dependencies|requirements\.txt|pyproject/.test(text),
    setup: change.setupChanged === true || /setup|install|bootstrap|docker|env|configuration|config/.test(text),
    testing: change.testingChanged === true || /test|spec|fixture|ci|workflow/.test(text),
    state: change.stateChanged === true || /state|roadmap|phase|milestone/.test(text),
    decision: change.decisionChanged === true || /decision|adr|tradeoff|architectural choice/.test(text),
  };

  const changedAxes = DOC_DRIFT_AXES.filter((axis) => impact[axis]);
  const suggested = new Set();

  if (impact.architecture || impact.responsibility) {
    suggested.add('.planning/architecture/OVERVIEW.md');
    suggested.add('.planning/architecture/COMPONENTS.md');
  }
  if (impact.api) suggested.add('docs/API.md');
  if (impact.dependency || impact.setup) suggested.add('README.md');
  if (impact.testing) suggested.add('docs/TESTING.md');
  if (impact.state) suggested.add('.planning/STATE.md');
  if (impact.decision) suggested.add('.planning/decisions/ADR-*.md');

  return {
    durableKnowledgeChanged: changedAxes.length > 0,
    axes: impact,
    changedAxes,
    suggestedDocs: [...suggested],
  };
}
