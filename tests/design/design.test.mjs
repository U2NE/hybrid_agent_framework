import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDesignWork,
  uiResourceForSurface,
} from '../../core/design/index.mjs';

test('ordinary backend work does not activate the design lane', () => {
  const assessment = assessDesignWork({
    request: 'Update auth token validation',
    tasks: [{ id: 'api', owner: 'implementer', files_modified: ['src/auth/token.ts'] }],
  });
  assert.equal(assessment.required, false);
});

test('generic software design wording alone is not treated as visual UI work', () => {
  assert.equal(
    assessDesignWork({ request: 'design task model architecture' }).required,
    false
  );
});

test('visual UI request and design executor ownership activate the design lane', () => {
  const visual = assessDesignWork({
    request: 'Redesign checkout layout and responsive spacing',
    task: { files: ['src/components/Checkout.tsx'] },
  });
  assert.equal(visual.required, true);
  assert.equal(visual.visualComplexity, 'high');
  assert.ok(visual.reasonCodes.includes('DESIGN_REQUEST_HINT'));

  const owned = assessDesignWork({
    request: 'Update checkout',
    tasks: [{
      id: 'ui',
      owner: 'design-executor',
      files_modified: ['src/components/Checkout.tsx'],
    }],
  });
  assert.equal(owned.required, true);
  assert.ok(owned.reasonCodes.includes('DESIGN_EXECUTOR_TASK'));
});

test('explicit disable wins over path and request hints', () => {
  const assessment = assessDesignWork({
    request: 'Redesign checkout layout',
    needsDesign: false,
    task: { files: ['src/components/Checkout.tsx'] },
  });
  assert.equal(assessment.required, false);
  assert.deepEqual(assessment.reasonCodes, ['DESIGN_EXPLICITLY_DISABLED']);
});

test('uiResourceForSurface produces a stable exclusive semantic lease', () => {
  assert.deepEqual(uiResourceForSurface(' checkout / payment '), {
    key: 'ui:checkout-/-payment',
    mode: 'exclusive',
  });
  assert.throws(() => uiResourceForSurface(''), /non-empty/);
});
