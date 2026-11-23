// 收件流程：按阶段从来源服务拉取七类资料，校验、留档原始载荷、规范化后落事件。
// 可持续运行的关键：
// - 同一文件内容指纹不变 -> 跳过（重发/重复跑不产生重复事件）；
// - 结算索引换日换批次 -> 新批次事件，旧批次观察保留；清单声明而 404 的页记为 missing，
//   与钱包记录里的 rejected/reversed 严格区分（文件暂缺不是业务拒绝）；
// - 钱包事件按 network+event 幂等，重复 E5 只保留一份业务事实；
// - 经办跨日重跑仍从原小票视角核对，因为所有状态都从事件日志重放。

import { fetchJson } from './source-client.mjs';
import { fingerprint, Store } from './store.mjs';
import {
  requireArray, requireBoolean, requireInteger, requireObject, requireOneOf, requireString,
} from './validate.mjs';

const RESOURCES = ['sales', 'allocations', 'refunds', 'settlement-index', 'wallet-a', 'wallet-b', 'wallet-c', 'tax'];
const WALLET_STATES = ['pending', 'confirmed', 'rejected', 'reversed'];

function validateSalesRow(row, path) {
  requireObject(row, path);
  return {
    store: requireString(row.store, `${path}.store`),
    receipt: requireString(row.receipt, `${path}.receipt`),
    line: requireString(row.line, `${path}.line`),
    gross_minor: requireInteger(row.gross_minor, `${path}.gross_minor`),
    currency: requireString(row.currency, `${path}.currency`),
    eligible: requireBoolean(row.eligible, `${path}.eligible`),
  };
}

function validateAllocation(row, path) {
  requireObject(row, path);
  return {
    store: requireString(row.store, `${path}.store`),
    receipt: requireString(row.receipt, `${path}.receipt`),
    line: requireString(row.line, `${path}.line`),
    child: requireString(row.child, `${path}.child`),
    network: requireString(row.network, `${path}.network`),
    merchant: requireString(row.merchant, `${path}.merchant`),
    original: requireString(row.original, `${path}.original`),
    amount_minor: requireInteger(row.amount_minor, `${path}.amount_minor`),
    currency: requireString(row.currency, `${path}.currency`),
  };
}

function validateRefund(row, path) {
  requireObject(row, path);
  return {
    id: requireString(row.id, `${path}.id`),
    store: requireString(row.store, `${path}.store`),
    receipt: requireString(row.receipt, `${path}.receipt`),
    line: requireString(row.line, `${path}.line`),
    child: requireString(row.child, `${path}.child`),
    minor: requireInteger(row.minor, `${path}.minor`),
    currency: requireString(row.currency, `${path}.currency`),
  };
}

function validateWallet(row, path) {
  requireObject(row, path);
  const state = requireOneOf(row.state, `${path}.state`, WALLET_STATES);
  const event = {
    event: requireString(row.event, `${path}.event`),
    network: requireString(row.network, `${path}.network`),
    merchant: requireString(row.merchant, `${path}.merchant`),
    original: requireString(row.original, `${path}.original`),
    child: requireString(row.child, `${path}.child`),
    state,
    charged_minor: requireInteger(row.charged_minor, `${path}.charged_minor`),
    charged_ccy: requireString(row.charged_ccy, `${path}.charged_ccy`),
    settled_minor: requireInteger(row.settled_minor, `${path}.settled_minor`),
    settled_ccy: requireString(row.settled_ccy, `${path}.settled_ccy`),
  };
  if (row.refund != null) event.refund = requireString(row.refund, `${path}.refund`);
  if (state === 'reversed') {
    event.supersedes = requireString(row.supersedes, `${path}.supersedes（reversed 必须带）`);
  }
  return event;
}

function validateTax(row, path) {
  requireObject(row, path);
  requireArray(row.eligible_lines, `${path}.eligible_lines`);
  return {
    ref: requireString(row.ref, `${path}.ref`),
    store: requireString(row.store, `${path}.store`),
    receipt: requireString(row.receipt, `${path}.receipt`),
    eligible_lines: row.eligible_lines.map((line, i) => requireString(line, `${path}.eligible_lines[${i}]`)),
    state: requireOneOf(row.state, `${path}.state`, ['locked', 'accepted', 'redeemed', 'draft']),
    declared_minor: requireInteger(row.declared_minor, `${path}.declared_minor`),
    currency: requireString(row.currency, `${path}.currency`),
  };
}

// 收取一个阶段的全部资料，返回追加的事件数统计。
export async function ingestPhase({ baseUrl, phase, store, now = () => new Date().toISOString() }) {
  if (!(store instanceof Store)) throw new TypeError('store 必须是 Store 实例');
  const stats = { phase, fetched: [], missing: [], failed: [], events: 0, duplicates: 0 };
  const ingestedAt = now();

  const pull = async (resource) => {
    const url = `${baseUrl.replace(/\/$/, '')}/v1/${phase}/${resource}`;
    const response = await fetchJson(url);
    return { resource, url, ...response };
  };

  // 先拉结算索引，决定本批次有哪些钱包页；索引本身暂缺则本阶段无法继续。
  const indexResult = await pull('settlement-index');
  if (indexResult.status === 404) {
    stats.missing.push('settlement-index');
    return stats;
  }
  const index = requireObject(indexResult.data, 'settlement-index');
  requireString(index.day, 'settlement-index.day');
  requireString(index.sequence, 'settlement-index.sequence');
  requireArray(index.pages, 'settlement-index.pages');

  const pages = index.pages.map((page, i) => ({
    name: requireString(page, `settlement-index.pages[${i}]`),
    status: 'declared',
  }));

  // 并行拉取其余资料；404 的钱包页按清单标记 missing。
  const others = RESOURCES.filter((r) => r !== 'settlement-index');
  const results = await Promise.all(others.map((resource) => pull(resource).catch((error) => ({ resource, error }))));

  const byResource = new Map();
  for (const result of results) {
    if (result.error) {
      stats.failed.push({ resource: result.resource, message: result.error.message });
      continue;
    }
    byResource.set(result.resource, result);
    if (result.status === 404) stats.missing.push(result.resource);
    else stats.fetched.push(result.resource);
  }

  for (const page of pages) {
    const result = byResource.get(page.name);
    if (!result || result.status === 404) page.status = 'missing'; // 文件暂缺：等下一次发布，不是拒绝
    else page.status = 'arrived';
  }

  // 批次观察事件：指纹只由业务内容（日、批次、各页到达状态）决定，
  // 不含观察时间戳——完全相同的重跑必须去重；页从 missing 变 arrived 才形成新观察。
  const batchData = { day: index.day, sequence: index.sequence, pages, observedAt: ingestedAt };
  const dedupBasis = { day: index.day, sequence: index.sequence, pages };
  appendIfChanged(store, {
    type: 'batch-observed',
    phase,
    ingestedAt,
    payloadHash: fingerprint(dedupBasis),
    data: batchData,
  }, stats);

  const listResource = (resource, validator, eventType, mapper) => {
    const result = byResource.get(resource);
    if (!result || result.status === 404) return;
    const rows = requireArray(result.data, resource);
    rows.forEach((row, i) => {
      const valid = validator(row, `${resource}[${i}]`);
      const event = {
        type: eventType, phase, ingestedAt, resource,
        payloadHash: fingerprint(valid),
        data: mapper ? mapper(valid) : valid,
      };
      appendIfChanged(store, event, stats);
    });
  };

  listResource('sales', validateSalesRow, 'sales-line-received');
  listResource('allocations', validateAllocation, 'allocation-received');
  listResource('refunds', validateRefund, 'refund-received');
  listResource('tax', validateTax, 'tax-material-received');

  // 钱包页：每条记录打上批次与页到达状态，便于区分“已到的拒绝/冲正”与“文件暂缺”。
  for (const page of pages) {
    const result = byResource.get(page.name);
    if (!result || result.status === 404) continue;
    const rows = requireArray(result.data, page.name);
    rows.forEach((row, i) => {
      const valid = validateWallet(row, `${page.name}[${i}]`);
      appendIfChanged(store, {
        type: 'wallet-event-received', phase, ingestedAt, resource: page.name,
        payloadHash: fingerprint(valid),
        data: {
          ...valid,
          arrivedAt: ingestedAt,
          batchSequence: index.sequence,
          batchDay: index.day,
          pageStatus: page.status,
        },
      }, stats);
    });
  }

  return stats;
}

// 内容指纹去重：同一份来件重复投递（含跨日重跑）不再产生事件。
function appendIfChanged(store, event, stats) {
  if (store.hasInboxHash(event.payloadHash)) {
    stats.duplicates += 1;
    return;
  }
  store.append(event);
  stats.events += 1;
}
