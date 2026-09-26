import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

test('browser-qa CLI fails closed with structured output when browser target is unavailable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybrid-browser-cli-'));
  const input = path.join(dir, 'browser.json');
  await fs.writeFile(input, JSON.stringify({ mode: 'functional' }));

  await assert.rejects(
    () => execFileAsync(process.execPath, [path.join(root, 'bin/hybrid.mjs'), 'browser-qa', input, dir], {
      cwd: root,
      encoding: 'utf8',
    }),
    (error) => {
      assert.equal(error.code, 2);
      const parsed = JSON.parse(error.stdout);
      assert.equal(parsed.available, false);
      assert.equal(parsed.success, false);
      assert.equal(parsed.reason, 'browser-target-url-unavailable');
      return true;
    }
  );
});
