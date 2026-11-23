// 投影：把事件日志重放成当前可查询的对账状态。
// 纯函数模块，不做任何外部 IO，便于单元测试与从任意事件序列重建。
//
// 设计要点：
// - 三方编号各自保留，绑定只认 (network, merchant, original, child) 这个钱包定位键；
// - 钱包事件按网络内事件号去重，重发（如重复 E5）天然幂等；
// - 同一分账子单分摊到同一小票的多行是正常业务；同一钱包定位键跨小票命中才是碰撞；
// - 碰撞或候选不唯一时圈出“待核对”，只冻结有争议的行，没有共享额度的同行记录照常处理；
// - 合资格净额只按“已确认”的钱包实退款（清算额）扣减，pending 不扣、rejected 不扣、
//   reversed 撤销先前 confirmed 的影响；商户累计折扣不是钱包实退款，从不进入扣减。

import { createHash } from 'node:crypto';
import { money, sum, abs, groupByCurrency } from './money.mjs';

const locatorKey = (e) => `${e.network}|${e.merchant}|${e.original}|${e.child}`;
const lineKey = (store, receipt, line) => `${store}/${receipt}/${line}`;
const refundKey = (store, receipt, refundId) => `${store}/${receipt}#${refundId}`;
const reviewId = (type, fingerprintText) =>
  `RV-${type}-${createHash('sha1').update(fingerprintText).digest('hex').slice(0, 10)}`;

export function reduce(events) {
  const state = {
    salesLines: new Map(),       // lineKey -> 收银行（含 eligible/gross/currency）
    allocations: new Map(),      // lineKey+child -> 分摊凭据
    refunds: new Map(),          // refundKey -> 收银端退款行
    walletEvents: new Map(),     // network|event -> 规范化钱包事件（重发覆盖）
    batches: new Map(),          // sequence -> 批次观察记录（含页状态）
    materials: new Map(),        // 退税台材料编号 -> 材料
    portalRequests: new Map(),   // 请求号 -> 门户请求/回执
    todoUpdates: [],             // 待申报材料的本地待办净额更新
    manualCases: [],             // 已兑付等无法走门户的人工处置案件
    meta: { lastIngest: null },
  };

  for (const event of events) {
    switch (event.type) {
      case 'sales-line-received':
        state.salesLines.set(lineKey(event.data.store, event.data.receipt, event.data.line), event.data);
        break;
      case 'allocation-received': {
        const d = event.data;
        state.allocations.set(`${lineKey(d.store, d.receipt, d.line)}|${d.child}`, d);
        break;
      }
      case 'refund-received': {
        const d = event.data;
        state.refunds.set(refundKey(d.store, d.receipt, d.id), d);
        break;
      }
      case 'batch-observed':
        state.batches.set(event.data.sequence, event.data);
        break;
      case 'wallet-event-received':
        state.walletEvents.set(`${event.data.network}|${event.data.event}`, event.data);
        break;
      case 'tax-material-received':
        state.materials.set(event.data.ref, event.data);
        break;
      case 'portal-request-recorded':
        state.portalRequests.set(event.data.key, event.data);
        break;
      case 'tax-todo-updated':
        state.todoUpdates.push(event.data);
        break;
      case 'manual-case-opened':
        state.manualCases.push(event.data);
        break;
      default:
        // 未知事件忽略而非崩溃，保证旧日志在新版本下仍可重放。
        break;
    }
    state.meta.lastIngest = event.ingestedAt ?? state.meta.lastIngest;
  }
  return state;
}

function indexAllocations(allocations) {
  const byLocator = new Map();
  for (const a of allocations.values()) {
    const key = locatorKey(a);
    if (!byLocator.has(key)) byLocator.set(key, []);
    byLocator.get(key).push(a);
  }
  return byLocator;
}

// 同一业务事实可能重发或被 reversed 撤销；按到达顺序取最新业务状态。
function currentWalletState(eventsForKey) {
  return [...eventsForKey].sort((a, b) => a.arrivedAt.localeCompare(b.arrivedAt)).at(-1);
}

function splitLocator(locator) {
  const [network, merchant, original, child] = locator.split('|');
  return { network, merchant, original, child };
}

function summarizeAllocation(a) {
  return {
    store: a.store, receipt: a.receipt, line: a.line, child: a.child,
    network: a.network, merchant: a.merchant, original: a.original,
    amount: money(a.amount_minor, a.currency),
  };
}

function allocationsForRefund(state, refund) {
  return [...state.allocations.values()].filter(
    (a) => a.store === refund.store && a.receipt === refund.receipt && a.child === refund.child,
  );
}

// 派生全部视图。返回的金额对象一律是 { minor, ccy } 最小单位整数。
export function derive(state) {
  const reviews = new Map();
  const blockedLines = new Set();    // 因争议被冻结、不得自动过账的收银行 key
  const referencedLines = new Set(); // 仅列入待核对圈、但额度未被冻结的收银行
  const blockedLocators = new Set();
  const allocationsByLocator = indexAllocations(state.allocations);
  const walletDisposition = new Map();
  const refundEvidence = new Map();  // refundKey -> { refund, walletEvents }
  const bindings = [];               // { locator, allocation, walletEvents }

  const eventsByLocator = new Map();
  for (const w of state.walletEvents.values()) {
    const key = locatorKey(w);
    if (!eventsByLocator.has(key)) eventsByLocator.set(key, []);
    eventsByLocator.get(key).push(w);
  }

  for (const [locator, walletList] of eventsByLocator) {
    const candidates = allocationsByLocator.get(locator) ?? [];
    const latest = currentWalletState(walletList);
    const markQuarantine = (review) => {
      reviews.set(review.id, review);
      for (const w of walletList) {
        walletDisposition.set(`${w.network}|${w.event}`, { status: 'quarantined', review: review.id });
      }
      blockedLocators.add(locator);
    };

    if (candidates.length === 0) {
      const id = reviewId('locator-unmatched', locator);
      const referenced = collectRefundLinesForLocator(state, locator);
      markQuarantine({
        id, kind: 'locator_unmatched', reason: '钱包原交易引用在分账凭据中无候选',
        locator: splitLocator(locator), walletEvents: walletList.map((w) => w.event),
        blockedLines: [], referencedLines: referenced, blocked: true,
      });
      for (const lk of referenced) referencedLines.add(lk);
      continue;
    }

    // 同一分账子单分摊到同一小票的多行是正常业务；
    // 同一钱包定位键落到不同小票（或不同门店）才是无法唯一绑定的碰撞。
    const distinctReceipts = [...new Set(candidates.map((a) => `${a.store}/${a.receipt}`))];
    if (distinctReceipts.length > 1) {
      const id = reviewId('locator-ambiguous', locator);
      const lineSet = [...new Set(candidates.map((a) => lineKey(a.store, a.receipt, a.line)))];
      markQuarantine({
        id, kind: 'locator_ambiguous', reason: '原交易引用跨小票对应多个候选分摊，无法唯一绑定',
        locator: splitLocator(locator), walletEvents: walletList.map((w) => w.event),
        blockedLines: lineSet, referencedLines: lineSet,
        candidates: candidates.map(summarizeAllocation), blocked: true,
      });
      for (const lk of lineSet) blockedLines.add(lk);
      continue;
    }

    const allocation = candidates[0];
    const ownLines = candidates.map((a) => lineKey(a.store, a.receipt, a.line));

    if (latest.refund) {
      const sameId = [...state.refunds.values()].filter((r) => r.id === latest.refund);
      if (sameId.length === 0) {
        const id = reviewId('refund-unknown', `${locator}|${latest.refund}`);
        markQuarantine({
          id, kind: 'refund_unknown', reason: '钱包事件引用的收银退款行在任何小票上都不存在',
          locator: splitLocator(locator), walletEvents: [latest.event],
          blockedLines: ownLines, referencedLines: ownLines, blocked: true,
        });
        for (const lk of ownLines) blockedLines.add(lk);
        continue;
      }
      const refund = sameId[0];
      const consistent = sameId.length === 1
        && refund.store === allocation.store
        && refund.receipt === allocation.receipt
        && refund.child === allocation.child;
      if (!consistent) {
        // 典型碰撞：E6 拿着 M2 子单的原交易引用却声称退 RF2（RF2 实际属于 M1 的 S11）。
        // 冻结钱包事件自己绑定的行；退款实际归属行只“圈定引用”，其自洽的其他记录照常过账。
        const id = reviewId('refund-conflict', `${locator}|${latest.refund}`);
        const refundLines = [...new Set(sameId.flatMap((r) =>
          allocationsForRefund(state, r).map((a) => lineKey(a.store, a.receipt, a.line))))];
        markQuarantine({
          id, kind: 'refund_locator_conflict',
          reason: sameId.length > 1
            ? '收银退款号在多张小票上重复，无法确定唯一归属'
            : '钱包定位键与收银退款声明的分账子单不一致，疑似原交易引用碰撞',
          locator: splitLocator(locator), walletEvents: [latest.event],
          refund: { id: refund.id, store: refund.store, receipt: refund.receipt, line: refund.line, child: refund.child },
          blockedLines: ownLines,
          referencedLines: [...new Set([...ownLines, ...refundLines])],
          blocked: true,
        });
        for (const lk of ownLines) blockedLines.add(lk);
        for (const rl of refundLines) referencedLines.add(rl);
        continue;
      }
    }

    // 证据自洽：逐行绑定并过账。
    for (const a of candidates) {
      bindings.push({ locator, allocation: a, walletEvents: walletList });
    }
    for (const w of walletList) {
      walletDisposition.set(`${w.network}|${w.event}`, { status: 'applied', allocation: summarizeAllocation(allocation) });
    }
    if (latest.refund) {
      const rk = refundKey(allocation.store, allocation.receipt, latest.refund);
      const entry = refundEvidence.get(rk) ?? { refund: state.refunds.get(rk), walletEvents: [] };
      // 同一收银退款可能先 pending 后 confirmed（不同事件），全部保留，视图取最新。
      entry.walletEvents = [...entry.walletEvents, ...walletList];
      refundEvidence.set(rk, entry);
    }
  }

  const amountChecks = buildAmountChecks(bindings);
  const receiptViews = buildReceiptViews(state, { bindings, walletDisposition, refundEvidence, blockedLines, referencedLines });
  const materialViews = buildMaterialViews(state, refundEvidence, blockedLines);

  return {
    batches: [...state.batches.values()],
    bindings: bindings.map((b) => ({ locator: splitLocator(b.locator), allocation: summarizeAllocation(b.allocation) })),
    reviews: [...reviews.values()],
    receipts: receiptViews,
    materials: materialViews,
    walletEvents: [...state.walletEvents.values()].map((w) => ({
      ...w, disposition: walletDisposition.get(`${w.network}|${w.event}`) ?? { status: 'quarantined', reason: '未参与绑定推导' },
    })),
    amountChecks,
    portalRequests: [...state.portalRequests.values()],
    todoUpdates: state.todoUpdates,
    manualCases: state.manualCases,
  };
}

function collectRefundLinesForLocator(state, locator) {
  const { network, merchant, original } = splitLocator(locator);
  const lines = new Set();
  for (const r of state.refunds.values()) {
    const linked = [...state.allocations.values()].filter(
      (a) => a.store === r.store && a.receipt === r.receipt && a.child === r.child
        && a.network === network && a.merchant === merchant && a.original === original,
    );
    for (const a of linked) lines.add(lineKey(a.store, a.receipt, a.line));
  }
  return [...lines];
}

// 逐绑定核对：分账凭据金额（小票币种）vs 钱包网络记录的 charged/settled（各带币种）。
function buildAmountChecks(bindings) {
  const checks = [];
  for (const binding of bindings) {
    const { allocation } = binding;
    const latest = currentWalletState(binding.walletEvents);
    const check = {
      locator: splitLocator(binding.locator),
      allocationAmount: money(allocation.amount_minor, allocation.currency),
      charged: money(latest.charged_minor, latest.charged_ccy),
      settled: money(latest.settled_minor, latest.settled_ccy),
      matches: [],
      mismatches: [],
    };
    // 清算额与分账额只有同币种才能直接比；不同币种各自记录，绝不换算相加。
    if (latest.settled_ccy === allocation.currency) {
      check.matches.push({
        kind: 'settled-vs-allocation',
        equal: Math.abs(latest.settled_minor) === allocation.amount_minor,
        allocation: check.allocationAmount, settled: check.settled,
      });
    } else {
      check.mismatches.push({
        kind: 'settled-vs-allocation',
        reason: '清算币种与分账币种不同，需按各自币种最小单位分别核对，不可跨币种相加',
        allocation: check.allocationAmount, settled: check.settled,
      });
    }
    checks.push(check);
  }
  return checks;
}

function buildReceiptViews(state, ctx) {
  const receipts = new Map();
  const ensure = (store, receipt) => {
    const key = `${store}/${receipt}`;
    if (!receipts.has(key)) {
      receipts.set(key, {
        store, receipt, key,
        lines: [], refunds: [], allocations: [],
        purchaseEvidence: [], refundEvidence: [],
        financeStatus: 'pending_clearance',
        flags: new Set(),
      });
    }
    return receipts.get(key);
  };

  for (const line of state.salesLines.values()) {
    const view = ensure(line.store, line.receipt);
    const lk = lineKey(line.store, line.receipt, line.line);
    view.lines.push({
      line: line.line,
      gross: money(line.gross_minor, line.currency),
      eligible: line.eligible,
      underReview: ctx.referencedLines.has(lk),
      blocked: ctx.blockedLines.has(lk),
    });
  }

  for (const a of state.allocations.values()) {
    ensure(a.store, a.receipt).allocations.push(summarizeAllocation(a));
  }

  // 购买依据：每条绑定的分账凭据 + 对应钱包网络记录。
  for (const binding of ctx.bindings) {
    const a = binding.allocation;
    const view = ensure(a.store, a.receipt);
    view.purchaseEvidence.push({
      allocation: summarizeAllocation(a),
      walletEvents: binding.walletEvents.map((w) => ({
        event: w.event, state: w.state,
        charged: money(w.charged_minor, w.charged_ccy),
        settled: money(w.settled_minor, w.settled_ccy),
        batch: { sequence: w.batchSequence, day: w.batchDay, arrivedAt: w.arrivedAt, pageStatus: w.pageStatus },
      })),
    });
  }

  // 退款依据：收银退款行 + 匹配的分摊凭据 + 钱包网络记录，按实际行匹配，不混入折扣。
  for (const [, entry] of ctx.refundEvidence) {
    const refund = entry.refund;
    const view = ensure(refund.store, refund.receipt);
    const latest = currentWalletState(entry.walletEvents);
    const settled = abs(money(latest.settled_minor, latest.settled_ccy));
    const charged = abs(money(latest.charged_minor, latest.charged_ccy));
    const lk = lineKey(refund.store, refund.receipt, refund.line);
    const allocation = allocationsForRefund(state, refund)[0] ?? null;
    view.refunds.push({
      refundId: refund.id, line: refund.line, child: refund.child,
      requested: money(refund.minor, refund.currency),
      walletState: latest.state,
      charged, settled,
      blocked: ctx.blockedLines.has(lk),
      evidence: {
        posRefund: { source: '收银端', id: refund.id, store: refund.store, receipt: refund.receipt, line: refund.line },
        allocation: allocation ? summarizeAllocation(allocation) : null,
        wallet: entry.walletEvents.map((w) => ({
          source: `钱包网络${w.network}`, network: w.network, event: w.event, state: w.state,
          original: w.original, child: w.child, merchant: w.merchant,
          charged: money(w.charged_minor, w.charged_ccy),
          settled: money(w.settled_minor, w.settled_ccy),
          batch: { sequence: w.batchSequence, day: w.batchDay, arrivedAt: w.arrivedAt },
        })),
      },
    });
    view.refundEvidence.push(view.refunds.at(-1));
  }

  for (const view of receipts.values()) {
    const statuses = collectFinanceStatuses(state, view);
    view.flags = [...view.flags];
    if (statuses.has('manual_review')) view.financeStatus = 'manual_review';
    else if (statuses.has('refund_in_clearance')) view.financeStatus = 'refund_in_clearance';
    else if (statuses.has('awaiting_clearance')) view.financeStatus = 'awaiting_clearance';
    else view.financeStatus = 'pending_clearance';

    // 金额按币种分桶汇总：同币种可合计，跨币种永不相加。
    view.totals = {
      gross: groupByCurrency(view.lines.map((l) => l.gross)),
      refundSettled: groupByCurrency(view.refunds.filter((r) => r.walletState === 'confirmed').map((r) => r.settled)),
      refundCharged: groupByCurrency(view.refunds.filter((r) => r.walletState === 'confirmed').map((r) => r.charged)),
    };
  }
  return [...receipts.values()];
}

function collectFinanceStatuses(state, view) {
  const found = new Set();
  if (view.lines.some((l) => l.blocked)) found.add('manual_review');
  for (const refund of view.refunds) {
    if (refund.blocked) found.add('manual_review');
    if (refund.walletState === 'confirmed') found.add('refund_in_clearance');
    if (refund.walletState === 'pending' || refund.walletState === 'rejected') found.add('awaiting_clearance');
  }
  // 批次已到但页暂缺：仍在等待清算，而不是业务拒绝。
  for (const batch of state.batches.values()) {
    for (const page of batch.pages) {
      if (page.status === 'missing') found.add('awaiting_clearance');
    }
  }
  return found;
}

function buildMaterialViews(state, refundEvidence, blockedLines) {
  const views = [];
  for (const material of state.materials.values()) {
    // 已确认的钱包实退款，按材料 eligible_lines 过滤，只认清算币种与材料币种一致的部分。
    const confirmedReductions = [];
    for (const [, entry] of refundEvidence) {
      const refund = entry.refund;
      if (refund.store !== material.store || refund.receipt !== material.receipt) continue;
      if (!material.eligible_lines.includes(refund.line)) continue;
      const lk = lineKey(refund.store, refund.receipt, refund.line);
      if (blockedLines.has(lk)) continue; // 待核对行不参与净额，等人工结论
      const latest = currentWalletState(entry.walletEvents);
      if (latest.state !== 'confirmed') continue;
      if (latest.settled_ccy !== material.currency) continue; // 跨币种不并入材料净额
      confirmedReductions.push({
        refundId: refund.id, line: refund.line,
        amount: abs(money(latest.settled_minor, latest.settled_ccy)),
        walletEvent: latest.event, settledEvidence: latest,
      });
    }
    const reductionTotal = sum(confirmedReductions.map((r) => r.amount), '合资格退款汇总');
    const declared = money(material.declared_minor, material.currency);
    const eligibleNet = money(
      Math.max(0, declared.minor - (reductionTotal?.minor ?? 0)),
      material.currency,
    );
    views.push({
      ref: material.ref,
      store: material.store,
      receipt: material.receipt,
      receiptKey: `${material.store}/${material.receipt}`,
      state: material.state,
      eligibleLines: material.eligible_lines,
      declared,
      confirmedReductions,
      reductionTotal,
      eligibleNet,
      reduced: (reductionTotal?.minor ?? 0) > 0,
      currency: material.currency,
    });
  }
  return views;
}

// 供税台模块使用：给定材料视图与门户请求，判断当前可用性与待确认调整。
export function materialDeskStatus(materialView, portalRequests) {
  // 提交时业务事实放在 payload.facts 内，兼容两种存放位置。
  const factsOf = (req) => req.facts ?? req.payload?.facts;
  const pendingAdjustment = portalRequests.find(
    (req) => req.action === 'adjust' && factsOf(req)?.materialRef === materialView.ref
      && req.result !== 'accepted' && req.result !== 'rejected',
  );
  const acceptedAdjustment = portalRequests.find(
    (req) => req.action === 'adjust' && factsOf(req)?.materialRef === materialView.ref && req.result === 'accepted',
  );
  let usable = true;
  if (materialView.state === 'redeemed') usable = false;
  if (pendingAdjustment) usable = false;
  return {
    materialRef: materialView.ref,
    usable,
    state: materialView.state,
    pendingAdjustment: pendingAdjustment
      ? { key: pendingAdjustment.key, sourceRef: pendingAdjustment.sourceRef, result: pendingAdjustment.result }
      : null,
    acceptedAdjustment: acceptedAdjustment
      ? { key: acceptedAdjustment.key, sourceRef: acceptedAdjustment.sourceRef }
      : null,
    currentEligibleNet: materialView.eligibleNet,
  };
}

export { lineKey, refundKey, locatorKey };
