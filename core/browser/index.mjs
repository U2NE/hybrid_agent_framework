import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const BROWSER_QA_SCHEMA = 'hybrid-browser-qa/v1';

const AUTO_CONTROL_SELECTOR = [
  'button',
  '[role="button"]',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
].join(',');

const INTERACTIVE_HINTS = [
  /\b(?:button|click|form|modal|dialog|dropdown|menu|navigation|login|signup|checkout|tab|toggle|refresh|drag|upload)\b/i,
  /버튼|클릭|폼|모달|다이얼로그|드롭다운|메뉴|내비게이션|로그인|회원가입|결제|탭|토글|새로고침|업로드/,
];

const UI_PATH_HINTS = [
  /\.(?:tsx|jsx|vue|svelte|html)$/i,
  /(?:^|\/)(?:components?|pages?|views?|ui|app)(?:\/|$)/i,
];

const DESTRUCTIVE_HINTS = /\b(?:delete|remove|destroy|purchase|buy|pay|checkout|place order|submit order|publish|send|logout|sign out|unsubscribe|disable account)\b|삭제|제거|탈퇴|구매|결제|주문|게시|발행|전송|로그아웃/i;

export function assessBrowserQa(input = {}, options = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const request = String(input.request || task.request || '').trim();
  const files = [
    ...(Array.isArray(task.files) ? task.files : []),
    ...(Array.isArray(task.files_modified) ? task.files_modified : []),
    ...(Array.isArray(input.tasks)
      ? input.tasks.flatMap((item) => item.files_modified || item.filesModified || [])
      : []),
  ].map(String);
  const tier = Number(options.tier ?? input.tier ?? 1);
  const designAssessment = options.designAssessment || {};
  const uiFiles = files.filter((file) => UI_PATH_HINTS.some((pattern) => pattern.test(file)));
  const interactiveHint = INTERACTIVE_HINTS.some((pattern) => pattern.test(request));
  const explicitFunctional =
    input.browserQa === true ||
    input.browserFunctionalQa === true ||
    input.acceptanceRequiresBrowser === true ||
    task.browserQa === true ||
    task.acceptanceRequiresBrowser === true;
  const explicitlyDisabled =
    input.browserQa === false ||
    input.browserFunctionalQa === false ||
    task.browserQa === false;
  const uiBehavior =
    input.uiBehaviorChanged === true ||
    input.interactiveUiChange === true ||
    task.uiBehaviorChanged === true ||
    task.interactiveUiChange === true;
  const uiSurface = designAssessment.required === true || uiFiles.length > 0;
  const functional =
    !explicitlyDisabled &&
    (explicitFunctional || uiBehavior || (uiSurface && interactiveHint));

  const riskSignal =
    input.highRegressionRisk === true ||
    input.concurrencyCritical === true ||
    input.dataIntegrityRisk === true ||
    input.failureProneBoundary === true;
  const adversarial =
    functional &&
    (
      input.browserAdversarialQa === true ||
      task.browserAdversarialQa === true ||
      tier >= 2 ||
      riskSignal
    );

  const reasonCodes = [];
  if (explicitFunctional) reasonCodes.push('BROWSER_QA_EXPLICIT');
  if (uiBehavior) reasonCodes.push('BROWSER_UI_BEHAVIOR_CHANGED');
  if (uiSurface && interactiveHint) reasonCodes.push('BROWSER_INTERACTIVE_UI_SURFACE');
  if (adversarial && tier >= 2) reasonCodes.push('BROWSER_ADVERSARIAL_COMPLEX');
  if (adversarial && riskSignal) reasonCodes.push('BROWSER_ADVERSARIAL_HIGH_RISK');
  if (input.browserAdversarialQa === true || task.browserAdversarialQa === true) {
    reasonCodes.push('BROWSER_ADVERSARIAL_EXPLICIT');
  }

  return {
    schema: BROWSER_QA_SCHEMA,
    functional,
    adversarial,
    targetUrl:
      input.browserTargetUrl ||
      task.browserTargetUrl ||
      input.previewUrl ||
      task.previewUrl ||
      null,
    uiFiles: [...new Set(uiFiles)].sort(),
    reasonCodes: [...new Set(reasonCodes)],
  };
}

export function createBrowserQaProvider(options = {}) {
  return async ({ gap = {}, timeoutMs } = {}) =>
    runBrowserQa(gap, {
      ...options,
      timeoutMs: timeoutMs ?? options.timeoutMs,
    });
}

export async function runBrowserQa(gap = {}, options = {}) {
  const mode = normalizeMode(gap.browserMode || gap.mode || options.mode || 'functional');
  const targetUrl = String(
    gap.url || gap.targetUrl || options.url || options.targetUrl || ''
  ).trim();
  if (!targetUrl) {
    return unavailable('browser-target-url-unavailable');
  }

  const timeoutMs = boundedTimeout(options.timeoutMs ?? gap.timeoutMs);
  let server = null;
  let browser = null;
  let context = null;
  let page = null;
  try {
    const startCommand = normalizeCommand(gap.startCommand || options.startCommand);
    if (startCommand) {
      server = spawn(startCommand[0], startCommand.slice(1), {
        cwd: path.resolve(options.cwd || gap.cwd || '.'),
        env: { ...process.env, ...(options.env || {}), ...(gap.env || {}) },
        stdio: options.serverStdio || 'ignore',
        shell: false,
      });
      await waitForUrl(targetUrl, timeoutMs);
    }

    const playwright = options.playwright || await loadPlaywright();
    const chromium = playwright?.chromium || playwright?.default?.chromium;
    if (!chromium || typeof chromium.launch !== 'function') {
      return unavailable('playwright-unavailable');
    }

    browser = await chromium.launch({
      headless: options.headless !== false,
      ...(options.launchOptions || {}),
      ...(gap.launchOptions || {}),
    });
    context = await browser.newContext({
      ...(options.contextOptions || {}),
      ...(gap.contextOptions || {}),
    });
    page = await context.newPage();

    const telemetry = {
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
    };
    attachTelemetry(page, telemetry);

    await page.goto(targetUrl, {
      waitUntil: gap.waitUntil || options.waitUntil || 'domcontentloaded',
      timeout: timeoutMs,
    });

    const explicitActions = normalizeActions(gap.actions);
    const probes = explicitActions.length
      ? await runExplicitActions(page, explicitActions, { timeoutMs })
      : await exerciseDiscoveredControls(page, targetUrl, {
          mode,
          timeoutMs,
          maxActions: boundedCount(gap.maxActions ?? options.maxActions, mode === 'adversarial' ? 24 : 12),
          allowDestructive: gap.allowDestructive === true || options.allowDestructive === true,
          malformedInputs: gap.malformedInputs !== false && options.malformedInputs !== false,
          doubleClick: gap.doubleClick !== false && options.doubleClick !== false,
        });

    const artifactRef = await captureScreenshot(page, {
      artifactDir: gap.artifactDir || options.artifactDir,
      mode,
    });
    const failed = probes.filter((probe) => probe.status === 'failed');
    const skipped = probes.filter((probe) => probe.status === 'skipped');
    const success =
      failed.length === 0 &&
      telemetry.pageErrors.length === 0 &&
      (
        (gap.failOnConsoleError === true || options.failOnConsoleError === true)
          ? telemetry.consoleErrors.length === 0
          : true
      ) &&
      (
        (gap.failOnRequestFailure === true || options.failOnRequestFailure === true)
          ? telemetry.requestFailures.length === 0
          : true
      );

    let title = '';
    let finalUrl = targetUrl;
    try {
      title = typeof page.title === 'function' ? await page.title() : '';
      finalUrl = typeof page.url === 'function' ? page.url() : targetUrl;
    } catch {
      // Evidence can still be returned if the page closed after a probe.
    }

    const report = {
      schema: BROWSER_QA_SCHEMA,
      mode,
      targetUrl,
      finalUrl,
      title,
      attempted: probes.filter((probe) => probe.status !== 'skipped').length,
      passed: probes.filter((probe) => probe.status === 'passed').length,
      failed: failed.length,
      skipped: skipped.length,
      probes,
      telemetry,
    };

    return {
      available: true,
      success,
      source: 'hybrid-playwright-browser-provider',
      artifactRef,
      summary: JSON.stringify(report),
      report,
    };
  } catch (error) {
    return {
      available: true,
      success: false,
      source: 'hybrid-playwright-browser-provider',
      artifactRef: null,
      summary: JSON.stringify({
        schema: BROWSER_QA_SCHEMA,
        mode,
        targetUrl,
        fatalError: String(error?.message || error),
      }),
      reason: 'browser-qa-execution-failed',
    };
  } finally {
    await safeClose(page);
    await safeClose(context);
    await safeClose(browser);
    await stopServer(server);
  }
}

async function runExplicitActions(page, actions, { timeoutMs }) {
  const probes = [];
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const probe = {
      index,
      action: action.type,
      target: summarizeTarget(action),
      status: 'passed',
      error: null,
    };
    try {
      await executeAction(page, action, timeoutMs);
    } catch (error) {
      probe.status = 'failed';
      probe.error = String(error?.message || error);
    }
    probes.push(probe);
    if (probe.status === 'failed' && action.continueOnFailure !== true) break;
  }
  return probes;
}

async function executeAction(page, action, timeoutMs) {
  switch (action.type) {
    case 'goto':
      await page.goto(requiredString(action.url, 'action.url'), {
        waitUntil: action.waitUntil || 'domcontentloaded',
        timeout: action.timeoutMs || timeoutMs,
      });
      return;
    case 'reload':
      await page.reload({ waitUntil: action.waitUntil || 'domcontentloaded', timeout: action.timeoutMs || timeoutMs });
      return;
    case 'back':
      await page.goBack({ waitUntil: action.waitUntil || 'domcontentloaded', timeout: action.timeoutMs || timeoutMs });
      return;
    case 'forward':
      await page.goForward({ waitUntil: action.waitUntil || 'domcontentloaded', timeout: action.timeoutMs || timeoutMs });
      return;
    case 'wait':
      await page.waitForTimeout(Math.min(Math.max(Number(action.ms || 0), 0), 5000));
      return;
    case 'expect-url': {
      const observed = typeof page.url === 'function' ? page.url() : '';
      if (!matchesExpected(observed, action.value)) {
        throw new Error('expected URL ' + String(action.value) + ', observed ' + observed);
      }
      return;
    }
    case 'expect-text': {
      const locator = resolveLocator(page, action);
      const observed = await locator.textContent({ timeout: action.timeoutMs || timeoutMs });
      if (!matchesExpected(String(observed || ''), action.value)) {
        throw new Error('expected text ' + String(action.value) + ', observed ' + String(observed || ''));
      }
      return;
    }
    case 'expect-visible': {
      const locator = resolveLocator(page, action);
      const visible = await locator.isVisible({ timeout: action.timeoutMs || timeoutMs });
      if (!visible) throw new Error('expected target to be visible');
      return;
    }
    default:
      break;
  }

  const locator = resolveLocator(page, action);
  const timeout = action.timeoutMs || timeoutMs;
  switch (action.type) {
    case 'click':
      await locator.click({ timeout });
      return;
    case 'double-click':
      await locator.dblclick({ timeout });
      return;
    case 'fill':
      await locator.fill(String(action.value ?? ''), { timeout });
      return;
    case 'press':
      await locator.press(requiredString(action.key, 'action.key'), { timeout });
      return;
    case 'check':
      await locator.check({ timeout });
      return;
    case 'uncheck':
      await locator.uncheck({ timeout });
      return;
    case 'select':
      await locator.selectOption(action.value, { timeout });
      return;
    case 'hover':
      await locator.hover({ timeout });
      return;
    default:
      throw new TypeError('unsupported browser action: ' + action.type);
  }
}

async function exerciseDiscoveredControls(page, targetUrl, options) {
  const raw = await page.locator(AUTO_CONTROL_SELECTOR).evaluateAll((elements) =>
    elements.map((element, index) => ({
      index,
      tag: element.tagName.toLowerCase(),
      type: String(element.getAttribute('type') || '').toLowerCase(),
      text: String(element.innerText || element.getAttribute('value') || '').trim().slice(0, 160),
      ariaLabel: String(element.getAttribute('aria-label') || '').trim().slice(0, 160),
      name: String(element.getAttribute('name') || '').trim().slice(0, 160),
      href: element instanceof HTMLAnchorElement ? element.href : '',
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    }))
  );

  const probes = [];
  const candidates = raw.slice(0, Math.max(options.maxActions * 4, options.maxActions));
  for (const candidate of candidates) {
    if (probes.filter((probe) => probe.status !== 'skipped').length >= options.maxActions) break;

    const label = [candidate.text, candidate.ariaLabel, candidate.name].filter(Boolean).join(' ');
    if (candidate.disabled) {
      probes.push(skippedProbe(candidate, 'disabled-control'));
      continue;
    }
    if (!options.allowDestructive && isPotentiallyDestructive(candidate, label)) {
      probes.push(skippedProbe(candidate, 'destructive-control'));
      continue;
    }
    if (candidate.href && !sameOrigin(candidate.href, targetUrl)) {
      probes.push(skippedProbe(candidate, 'cross-origin-link'));
      continue;
    }

    const locator = page.locator(AUTO_CONTROL_SELECTOR).nth(candidate.index);
    const probe = {
      index: candidate.index,
      action: autoActionFor(candidate, options.mode),
      target: compactCandidate(candidate),
      status: 'passed',
      error: null,
    };
    try {
      const visible = await locator.isVisible({ timeout: Math.min(options.timeoutMs, 3000) });
      if (!visible) {
        probe.status = 'skipped';
        probe.error = 'not-visible';
      } else if (isTextInput(candidate) && options.mode === 'adversarial' && options.malformedInputs) {
        await locator.fill("\"'<>$" + "{}[]\\n", { timeout: options.timeoutMs });
      } else if (candidate.tag === 'select') {
        await locator.focus({ timeout: options.timeoutMs });
      } else {
        await locator.click({ timeout: options.timeoutMs });
      }
    } catch (error) {
      probe.status = 'failed';
      probe.error = String(error?.message || error);
    }
    probes.push(probe);

    if (
      options.mode === 'adversarial' &&
      options.doubleClick &&
      probe.status === 'passed' &&
      isClickable(candidate)
    ) {
      const repeated = {
        index: candidate.index,
        action: 'double-click-probe',
        target: compactCandidate(candidate),
        status: 'passed',
        error: null,
      };
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
        const fresh = page.locator(AUTO_CONTROL_SELECTOR).nth(candidate.index);
        if (await fresh.isVisible({ timeout: Math.min(options.timeoutMs, 3000) })) {
          await fresh.dblclick({ timeout: options.timeoutMs });
        } else {
          repeated.status = 'skipped';
          repeated.error = 'not-visible-after-reset';
        }
      } catch (error) {
        repeated.status = 'failed';
        repeated.error = String(error?.message || error);
      }
      probes.push(repeated);
    }

    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    } catch (error) {
      probes.push({
        index: candidate.index,
        action: 'reset',
        target: compactCandidate(candidate),
        status: 'failed',
        error: String(error?.message || error),
      });
      break;
    }
  }

  return probes;
}

function resolveLocator(page, action) {
  if (action.selector) return page.locator(String(action.selector)).first();
  if (action.role) {
    return page.getByRole(String(action.role), {
      ...(action.name !== undefined ? { name: action.name } : {}),
      ...(action.exact !== undefined ? { exact: action.exact === true } : {}),
    }).first();
  }
  if (action.label) return page.getByLabel(String(action.label), { exact: action.exact === true }).first();
  if (action.placeholder) return page.getByPlaceholder(String(action.placeholder), { exact: action.exact === true }).first();
  if (action.text) return page.getByText(String(action.text), { exact: action.exact === true }).first();
  throw new TypeError('browser action requires selector, role/name, label, placeholder, or text');
}

function normalizeActions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('browser actions must be an array');
  return value.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError('browser action at index ' + index + ' must be an object');
    }
    const type = String(action.type || '').trim().toLowerCase();
    if (!type) throw new TypeError('browser action at index ' + index + ' requires type');
    return { ...action, type };
  });
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!['functional', 'adversarial'].includes(mode)) {
    throw new TypeError('browser QA mode must be functional or adversarial');
  }
  return mode;
}

async function loadPlaywright() {
  for (const name of ['playwright', '@playwright/test']) {
    try {
      return await import(name);
    } catch (error) {
      if (!isModuleNotFound(error)) throw error;
    }
  }
  return null;
}

function isModuleNotFound(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Cannot find module/.test(String(error?.message || ''));
}

function attachTelemetry(page, telemetry) {
  if (typeof page.on !== 'function') return;
  page.on('console', (message) => {
    try {
      if (message.type() === 'error') telemetry.consoleErrors.push(truncate(message.text()));
    } catch {}
  });
  page.on('pageerror', (error) => telemetry.pageErrors.push(truncate(error?.message || error)));
  page.on('requestfailed', (request) => {
    try {
      telemetry.requestFailures.push(truncate(request.url() + ' ' + (request.failure()?.errorText || 'failed')));
    } catch {}
  });
}

async function captureScreenshot(page, { artifactDir, mode }) {
  if (!page || typeof page.screenshot !== 'function') return null;
  const dir = artifactDir
    ? path.resolve(artifactDir)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-browser-qa-'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, mode + '-final.png');
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

function unavailable(reason) {
  return {
    available: false,
    success: false,
    source: 'hybrid-playwright-browser-provider',
    artifactRef: null,
    summary: '',
    reason,
  };
}

function normalizeCommand(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item)) {
    throw new TypeError('browser startCommand must be a non-empty argv array');
  }
  return value;
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('browser target did not become ready: ' + url + (lastError ? ' (' + lastError.message + ')' : ''));
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.killed) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function safeClose(value) {
  try {
    if (value && typeof value.close === 'function') await value.close();
  } catch {}
}

function boundedTimeout(value) {
  const timeout = Number(value || 15000);
  if (!Number.isFinite(timeout) || timeout <= 0) return 15000;
  return Math.min(Math.max(Math.floor(timeout), 500), 60000);
}

function boundedCount(value, fallback) {
  const count = Number(value ?? fallback);
  if (!Number.isFinite(count) || count <= 0) return fallback;
  return Math.min(Math.max(Math.floor(count), 1), 50);
}

function requiredString(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(label + ' is required');
  return text;
}

function matchesExpected(observed, expected) {
  if (expected instanceof RegExp) return expected.test(observed);
  return observed.includes(String(expected ?? ''));
}

function summarizeTarget(action) {
  return action.selector || action.name || action.label || action.placeholder || action.text || action.url || null;
}

function skippedProbe(candidate, reason) {
  return {
    index: candidate.index,
    action: autoActionFor(candidate, 'functional'),
    target: compactCandidate(candidate),
    status: 'skipped',
    error: reason,
  };
}

function compactCandidate(candidate) {
  return {
    tag: candidate.tag,
    type: candidate.type,
    text: candidate.text,
    ariaLabel: candidate.ariaLabel,
    name: candidate.name,
    href: candidate.href,
  };
}

function autoActionFor(candidate, mode) {
  if (isTextInput(candidate) && mode === 'adversarial') return 'malformed-input';
  if (candidate.tag === 'select') return 'focus-select';
  return 'click';
}

function isTextInput(candidate) {
  return (
    candidate.tag === 'textarea' ||
    (
      candidate.tag === 'input' &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'color', 'range'].includes(candidate.type)
    )
  );
}

function isClickable(candidate) {
  return (
    candidate.tag === 'button' ||
    candidate.tag === 'a' ||
    candidate.tag === 'summary' ||
    (candidate.tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(candidate.type))
  );
}

function isPotentiallyDestructive(candidate, label) {
  if (candidate.tag === 'input' && ['submit', 'reset', 'file'].includes(candidate.type)) return true;
  return DESTRUCTIVE_HINTS.test(String(label || ''));
}

function sameOrigin(candidateUrl, targetUrl) {
  try {
    return new URL(candidateUrl, targetUrl).origin === new URL(targetUrl).origin;
  } catch {
    return false;
  }
}

function truncate(value, max = 500) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max) + '…';
}
