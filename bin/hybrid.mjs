#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { classifyTask } from '../core/classifier/index.mjs';
import { compilePlan, parsePlanDocument, validatePlan } from '../core/planning/index.mjs';
import { prepareExecution } from '../core/orchestrator/index.mjs';
import { StateStore } from '../core/state/index.mjs';
import { ExecutionRunStore } from '../core/transitions/index.mjs';
import { ResourceLeaseStore } from '../core/leases/index.mjs';
import {
  proposeMaterialRevision,
  sealApprovedMaterialRevision,
} from '../core/execution-graph/index.mjs';
import { ModelBudgetStore } from '../core/routing/budget.mjs';
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

    case 'lease': {
      const sub = args[0];
      const runId = required(args[1], 'run id');

      if (sub === 'acquire') {
        const taskId = required(args[2], 'task id');
        const attemptId = required(args[3], 'attempt id');
        const root = path.resolve(args[4] || '.');
        const graph = await new ExecutionRunStore(root, runId).loadGraph();
        const result = await new ResourceLeaseStore(root, runId).acquire(
          graph,
          taskId,
          attemptId
        );
        print(result);
      } else if (sub === 'release') {
        const leaseId = required(args[2], 'lease id');
        const leaseToken = required(args[3], 'lease token');
        const root = path.resolve(args[4] || '.');
        print(await new ResourceLeaseStore(root, runId).release(
          leaseId,
          leaseToken,
          null
        ));
      } else if (sub === 'list') {
        const root = path.resolve(args[2] || '.');
        print(await new ResourceLeaseStore(root, runId).list());
      } else if (sub === 'verify') {
        const authorizationPath = required(args[2], 'authorization JSON path');
        const root = path.resolve(args[3] || '.');
        const graph = await new ExecutionRunStore(root, runId).loadGraph();
        const authorization = await readJsonFile(authorizationPath);
        const store = new ResourceLeaseStore(root, runId);
        await store.assertAuthorization(graph, authorization);
        print({ valid: true, leaseId: authorization.leaseId });
      } else {
        throw new Error(
          'usage: hybrid lease <acquire|release|list|verify> <run-id> ...'
        );
      }
      break;
    }

    case 'revision': {
      const sub = args[0];
      const runId = required(args[1], 'run id');
      const inputPath = required(args[2], 'revision input JSON path');
      const root = path.resolve(args[3] || '.');
      const input = await readJsonFile(inputPath);
      const runStore = new ExecutionRunStore(root, runId);
      const parentGraph = await runStore.loadGraph();

      if (sub === 'propose') {
        const plan = requiredObject(input.plan, 'revision plan');
        print(proposeMaterialRevision(parentGraph, plan, input));
      } else if (sub === 'apply') {
        const plan = requiredObject(input.plan, 'revision plan');
        const proposal = requiredObject(input.proposal, 'revision proposal');
        const approvalReceipt = requiredObject(
          input.approvalReceipt,
          'user approval receipt'
        );
        const child = sealApprovedMaterialRevision(
          parentGraph,
          plan,
          proposal,
          {
            ...(input.spec !== undefined ? { spec: input.spec } : {}),
            approvalReceipt,
          }
        );
        const advanced = await runStore.advanceGraph(child);
        print({
          status: advanced.status,
          graph: advanced.graph,
          path: advanced.path,
        });
      } else {
        throw new Error(
          'usage: hybrid revision <propose|apply> <run-id> <input.json> [project-root]'
        );
      }
      break;
    }

    case 'model-budget': {
      const sub = args[0];
      const runId = required(args[1], 'run id');

      if (sub === 'reserve') {
        const stageId = required(args[2], 'stage id');
        const attemptId = required(args[3], 'attempt id');
        const routePath = required(args[4], 'route JSON path');
        const root = path.resolve(args[5] || '.');
        const route = await readJsonFile(routePath);
        print(await new ModelBudgetStore(root, runId).reserve(
          route,
          stageId,
          attemptId
        ));
      } else if (sub === 'verify') {
        const stageId = required(args[2], 'stage id');
        const attemptId = required(args[3], 'attempt id');
        const routePath = required(args[4], 'route JSON path');
        const authorizationPath = required(args[5], 'authorization JSON path');
        const root = path.resolve(args[6] || '.');
        const route = await readJsonFile(routePath);
        const authorization = await readJsonFile(authorizationPath);
        print(await new ModelBudgetStore(root, runId).verify(
          route,
          stageId,
          attemptId,
          authorization
        ));
      } else if (sub === 'approve') {
        const receiptPath = required(args[2], 'user approval receipt JSON path');
        const root = path.resolve(args[3] || '.');
        const receipt = await readJsonFile(receiptPath);
        print(await new ModelBudgetStore(root, runId).approveLimit(receipt));
      } else if (sub === 'list') {
        const root = path.resolve(args[2] || '.');
        print(await new ModelBudgetStore(root, runId).list());
      } else {
        throw new Error(
          'usage: hybrid model-budget <reserve|verify|approve|list> <run-id> ...'
        );
      }
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

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('missing or invalid ' + label);
  }
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
    '  hybrid lease acquire <run-id> <task-id> <attempt-id> [project-root]',
    '  hybrid lease verify <run-id> <authorization.json> [project-root]',
    '  hybrid lease release <run-id> <lease-id> <lease-token> [project-root]',
    '  hybrid lease list <run-id> [project-root]',
    '  hybrid revision propose <run-id> <input.json> [project-root]',
    '  hybrid revision apply <run-id> <input.json> [project-root]',
    '  hybrid model-budget reserve <run-id> <stage-id> <attempt-id> <route.json> [project-root]',
    '  hybrid model-budget verify <run-id> <stage-id> <attempt-id> <route.json> <authorization.json> [project-root]',
    '  hybrid model-budget approve <run-id> <user-approval-receipt.json> [project-root]',
    '  hybrid model-budget list <run-id> [project-root]',
    '  hybrid state init [project-root]',
    '  hybrid state get [project-root]',
    '  hybrid wiki lint [wiki-root]',
    '  hybrid wiki query [wiki-root] <terms>',
    '  hybrid wiki ingest [wiki-root] <entry.json>',
  ].join('\n');
}
