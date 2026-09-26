import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessBrowserQa, runBrowserQa } from '../../core/browser/index.mjs';

test('interactive UI work activates functional browser QA and complex/high-risk work adds adversarial browser QA', () => {
  const base = {
    task: {
      request: 'Change checkout button modal behavior',
      files: ['src/components/Checkout.tsx'],
    },
    request: 'Change checkout button modal behavior',
    browserTargetUrl: 'http://127.0.0.1:3000/checkout',
  };
  const bounded = assessBrowserQa(base, { tier: 1, designAssessment: { required: true } });
  assert.equal(bounded.functional, true);
  assert.equal(bounded.adversarial, false);
  assert.equal(bounded.targetUrl, 'http://127.0.0.1:3000/checkout');
  assert.ok(bounded.reasonCodes.includes('BROWSER_INTERACTIVE_UI_SURFACE'));

  const complex = assessBrowserQa(base, { tier: 2, designAssessment: { required: true } });
  assert.equal(complex.functional, true);
  assert.equal(complex.adversarial, true);
  assert.ok(complex.reasonCodes.includes('BROWSER_ADVERSARIAL_COMPLEX'));

  const disabled = assessBrowserQa({ ...base, browserQa: false }, { tier: 3, designAssessment: { required: true } });
  assert.equal(disabled.functional, false);
  assert.equal(disabled.adversarial, false);
});

test('functional browser provider executes bounded Playwright actions and returns structured evidence', async () => {
  const calls = [];
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-browser-test-'));
  const page = fakePage({ calls, statusText: 'ready' });
  const playwright = fakePlaywright(page);
  const result = await runBrowserQa({
    mode: 'functional',
    url: 'http://example.test/app',
    actions: [
      { type: 'click', selector: '#open' },
      { type: 'fill', selector: '#name', value: 'Alice' },
      { type: 'expect-text', selector: '#status', value: 'ready' },
    ],
  }, { playwright, artifactDir });

  assert.equal(result.available, true);
  assert.equal(result.success, true);
  assert.equal(result.source, 'hybrid-playwright-browser-provider');
  assert.equal(result.report.mode, 'functional');
  assert.equal(result.report.attempted, 3);
  assert.equal(result.report.failed, 0);
  assert.ok(calls.includes('click:#open'));
  assert.ok(calls.includes('fill:#name:Alice'));
  assert.ok(result.artifactRef.endsWith('functional-final.png'));
});

test('adversarial browser provider clicks safe controls, probes double-click/malformed input, and skips destructive or cross-origin controls', async () => {
  const calls = [];
  const candidates = [
    { index: 0, tag: 'button', type: '', text: 'Open menu', ariaLabel: '', name: '', href: '', disabled: false },
    { index: 1, tag: 'button', type: '', text: 'Delete account', ariaLabel: '', name: '', href: '', disabled: false },
    { index: 2, tag: 'input', type: 'text', text: '', ariaLabel: 'Search', name: 'search', href: '', disabled: false },
    { index: 3, tag: 'a', type: '', text: 'External', ariaLabel: '', name: '', href: 'https://outside.example/path', disabled: false },
  ];
  const page = fakePage({ calls, candidates });
  const result = await runBrowserQa({
    mode: 'adversarial',
    url: 'http://example.test/app',
    maxActions: 8,
  }, { playwright: fakePlaywright(page), artifactDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-browser-adv-')) });

  assert.equal(result.available, true);
  assert.equal(result.success, true);
  assert.ok(calls.includes('click:auto:0'));
  assert.ok(calls.includes('dblclick:auto:0'));
  assert.ok(calls.some((entry) => entry.startsWith('fill:auto:2:')));
  assert.ok(result.report.probes.some((probe) => probe.error === 'destructive-control'));
  assert.ok(result.report.probes.some((probe) => probe.error === 'cross-origin-link'));
});

test('browser provider fails closed when target URL is missing', async () => {
  const result = await runBrowserQa({ mode: 'functional' }, { playwright: fakePlaywright(fakePage({ calls: [] })) });
  assert.equal(result.available, false);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'browser-target-url-unavailable');
});

function fakePlaywright(page) {
  return {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() { return page; },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };
}

function fakePage({ calls, statusText = '', candidates = [] }) {
  let currentUrl = 'http://example.test/app';
  const autoLocators = new Map();
  const make = (key) => ({
    first() { return this; },
    async click() { calls.push('click:' + key); },
    async dblclick() { calls.push('dblclick:' + key); },
    async fill(value) { calls.push('fill:' + key + ':' + value); },
    async press(keyValue) { calls.push('press:' + key + ':' + keyValue); },
    async check() { calls.push('check:' + key); },
    async uncheck() { calls.push('uncheck:' + key); },
    async selectOption(value) { calls.push('select:' + key + ':' + JSON.stringify(value)); },
    async hover() { calls.push('hover:' + key); },
    async focus() { calls.push('focus:' + key); },
    async isVisible() { return true; },
    async textContent() { return key === '#status' ? statusText : ''; },
  });
  const autoRoot = {
    async evaluateAll() { return candidates; },
    nth(index) {
      if (!autoLocators.has(index)) autoLocators.set(index, make('auto:' + index));
      return autoLocators.get(index);
    },
  };
  return {
    on() {},
    async goto(url) { currentUrl = url; calls.push('goto:' + url); },
    async reload() { calls.push('reload'); },
    async goBack() { calls.push('back'); },
    async goForward() { calls.push('forward'); },
    async waitForTimeout(ms) { calls.push('wait:' + ms); },
    locator(selector) {
      if (selector.includes('button') && selector.includes('[role="button"]')) return autoRoot;
      return make(selector);
    },
    getByRole(role, options = {}) { return make('role:' + role + ':' + String(options.name || '')); },
    getByLabel(label) { return make('label:' + label); },
    getByPlaceholder(value) { return make('placeholder:' + value); },
    getByText(value) { return make('text:' + value); },
    async screenshot({ path: screenshotPath }) { await fs.writeFile(screenshotPath, 'fake'); },
    async title() { return 'Fake app'; },
    url() { return currentUrl; },
    async close() {},
  };
}
