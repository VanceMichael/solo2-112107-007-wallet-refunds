#!/usr/bin/env node
// 门店对账员的可持续收件流程 CLI。
//
// 用法：
//   node reconcile/cli.mjs ingest [--phase opening|interim|confirmed] [--all]
//   node reconcile/cli.mjs run [--phase ...]   收件 + 税台调整决策 + 门户核实 + 刷新快照
//   node reconcile/cli.mjs inspect             用 inspect 核实门户待确认请求
//   node reconcile/cli.mjs receipt <store> <receipt>
//   node reconcile/cli.mjs material <materialRef>
//   node reconcile/cli.mjs reviews
//   node reconcile/cli.mjs overview
//   node reconcile/cli.mjs rebuild             忽略快照，从事件日志完整重放
//
// 环境变量：SOURCE_URL（默认 http://127.0.0.1:4173）、RECONCILE_DIR（默认 ./reconcile-data）。
// 命令逻辑全部在 runCommand 中，既可由本 CLI 入口调用，也可在测试里同进程驱动。

import { pathToFileURL } from 'node:url';
import { Store } from './lib/store.mjs';
import { ingestPhase } from './lib/ingest.mjs';
import { buildModel, queryReceipt, queryMaterial, listReviews, financeOverview } from './lib/queries.mjs';
import { planAdjustments, executeDecisions, inspectRequests } from './lib/tax-desk.mjs';

export const PHASES = ['opening', 'interim', 'confirmed'];

function parseArgs(argv) {
  const args = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        args.flags.set(key, true);
      } else {
        args.flags.set(key, next);
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadModel(store) {
  return buildModel(store.readEvents());
}

function refreshSnapshot(store) {
  const model = loadModel(store);
  store.writeSnapshot({ rebuiltAt: new Date().toISOString(), model });
  return model;
}

async function cmdIngest(store, args, baseUrl) {
  const all = args.flags.get('all') === true;
  const requested = args.flags.get('phase');
  const phases = all ? PHASES : (requested ? [requested] : ['confirmed']);
  const collected = [];
  for (const phase of phases) {
    if (!PHASES.includes(phase)) throw new Error(`未知阶段 ${phase}`);
    collected.push(await ingestPhase({ baseUrl, phase, store }));
  }
  return collected.length === 1 ? collected[0] : collected;
}

async function cmdRun(store, args, baseUrl) {
  await cmdIngest(store, args, baseUrl);
  const model = loadModel(store);

  // 税台调整决策：待申报改待办、锁定/已确认走门户、已兑付转人工。
  // 门户回执是异步到达的：这里只登记提交结果，回执核实由显式的 inspect 命令负责。
  const decisions = planAdjustments(model);
  const phase = args.flags.get('phase') ?? 'confirmed';
  const portalUrl = `${baseUrl}/v1/${phase}/portal`;
  const events = [];
  for (const decision of decisions) {
    const produced = await executeDecisions([decision], portalUrl);
    events.push(...produced);
  }
  for (const event of events) store.append(event);

  const finalModel = refreshSnapshot(store);
  return {
    decisions: decisions.map(({ payload, ...d }) => d),
    newEvents: events.length,
    reviews: listReviews(finalModel),
    overview: financeOverview(finalModel),
  };
}

async function cmdInspect(store, args, baseUrl) {
  const phase = args.flags.get('phase') ?? 'confirmed';
  const portalUrl = `${baseUrl}/v1/${phase}/portal`;
  const events = await inspectRequests(loadModel(store).portalRequests, portalUrl);
  for (const event of events) store.append(event);
  refreshSnapshot(store);
  return { inspected: events.length, requests: loadModel(store).portalRequests };
}

// 库入口：给定命令、原始 argv、来源地址与数据目录，返回可 JSON 序列化的结果。
export async function runCommand(command, argv, { baseUrl, dataDir }) {
  const args = parseArgs(argv);
  const store = new Store(dataDir);
  store.acquire();
  try {
    switch (command) {
      case 'ingest': {
        const result = await cmdIngest(store, args, baseUrl);
        refreshSnapshot(store);
        return result;
      }
      case 'run':
        return cmdRun(store, args, baseUrl);
      case 'inspect':
        return cmdInspect(store, args, baseUrl);
      case 'receipt': {
        const [shop, receipt] = args._;
        const view = queryReceipt(loadModel(store), shop, receipt);
        return view ?? { error: `未找到小票 ${shop}/${receipt}` };
      }
      case 'material': {
        const [materialRef] = args._;
        const view = queryMaterial(loadModel(store), materialRef);
        return view ?? { error: `未找到税台材料 ${materialRef}` };
      }
      case 'reviews':
        return listReviews(loadModel(store));
      case 'overview':
        return financeOverview(loadModel(store));
      case 'rebuild':
        return refreshSnapshot(store);
      default:
        throw new Error(`未知命令 ${command}`);
    }
  } finally {
    store.release();
  }
}

// 仅在直接作为脚本运行时解析环境变量与 argv。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = process.env.SOURCE_PORT ?? '4173';
  const baseUrl = process.env.SOURCE_URL ?? `http://127.0.0.1:${port}`;
  const dataDir = process.env.RECONCILE_DIR ?? new URL('../reconcile-data', import.meta.url).pathname;
  const [command, ...rest] = process.argv.slice(2);
  runCommand(command ?? 'overview', rest, { baseUrl, dataDir })
    .then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`))
    .catch((error) => {
      process.exitCode = 1;
      process.stderr.write(`${error.message}\n`);
    });
}
