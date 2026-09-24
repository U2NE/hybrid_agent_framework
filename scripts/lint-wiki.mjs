#!/usr/bin/env node
import path from 'node:path';
import { lintWiki } from '../core/wiki/index.mjs';

const root = path.resolve(process.argv[2] || '.ai/wiki');
const result = await lintWiki({ root });
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
