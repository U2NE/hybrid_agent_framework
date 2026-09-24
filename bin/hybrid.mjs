#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { classifyTask } from '../core/classifier/index.mjs';
import { compilePlan, parsePlanDocument, validatePlan } from '../core/planning/index.mjs';
import { prepareExecution } from '../core/orchestrator/index.mjs';
import { StateStore } from '../core/state/index.mjs';
import { ingestWiki, lintWiki, queryWiki } from '../core/wiki/index.mjs';

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'classify':
      print(classifyTask({ request: args.join(' ') }));
      break;

    case 'validate-plan': {
      const plan = await readPlanFile(required(args[0], 'plan path'));
      print(validatePlan(plan));
      break;
    }

    case 'schedule': {
      const plan = await readPlanFile(required(args[0], 'plan path'));
      print(compilePlan(plan).waveSummary);
      break;
    }

    case 'prepare': {
      const input = await readJsonFile(required(args[0], 'input JSON path'));
      print(prepareExecution(input));
      break;
    }

    case 'state': {
      const sub = args[0];
      const root = path.resolve(args[1] || '.');
      const store = new StateStore(root);
      if (sub === 'get') print(await store.load());
      else if (sub === 'init') {
        if (await store.exists()) throw new Error('STATE.md already exists');
        print(await store.init({
          phase: '00-bootstrap',
          status: 'active',
          nextAction: 'classify the incoming request',
        }));
      } else {
        throw new Error('usage: hybrid state <get|init> [project-root]');
      }
      break;
    }

    case 'wiki': {
      const sub = args[0];
      const root = path.resolve(args[1] || '.ai/wiki');
      if (sub === 'lint') print(await lintWiki({ root }));
      else if (sub === 'query') print(await queryWiki({ root, query: args.slice(2).join(' ') }));
      else if (sub === 'ingest') {
        const entry = await readJsonFile(required(args[2], 'wiki entry JSON path'));
        print(await ingestWiki({ root, ...entry }));
      } else throw new Error('usage: hybrid wiki <lint|query|ingest> [wiki-root] [query|entry.json]');
      break;
    }

    case 'help':
    case undefined:
      console.log(help());
      break;

    default:
      throw new Error('unknown command: ' + command + '\n\n' + help());
  }
} catch (error) {
  console.error('hybrid:', error.message);
  process.exitCode = 1;
}

async function readJsonFile(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
}

async function readPlanFile(file) {
  const resolved = path.resolve(file);
  const text = await fs.readFile(resolved, 'utf8');
  return resolved.endsWith('.json') ? JSON.parse(text) : parsePlanDocument(text);
}

function required(value, label) {
  if (!value) throw new Error('missing ' + label);
  return value;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function help() {
  return [
    'Hybrid CLI',
    '',
    '  hybrid classify <request>',
    '  hybrid validate-plan <PLAN.md|plan.json>',
    '  hybrid schedule <PLAN.md|plan.json>',
    '  hybrid prepare <input.json>',
    '  hybrid state init [project-root]',
    '  hybrid state get [project-root]',
    '  hybrid wiki lint [wiki-root]',
    '  hybrid wiki query [wiki-root] <terms>',
    '  hybrid wiki ingest [wiki-root] <entry.json>',
  ].join('\n');
}
