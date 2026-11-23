// 对账查询：把投影结果组织成经办与财务日常需要的视图。
// 所有金额输出均为 { minor, ccy } 最小单位；多币种按币种分桶，绝不跨币种相加。

import { reduce, derive, materialDeskStatus } from './projection.mjs';

export function buildModel(events) {
  return derive(reduce(events));
}

// 某张小票的完整对账视图：已确认购买、退款、后续调整各自引用的原始依据。
export function queryReceipt(model, store, receipt) {
  const view = model.receipts.find((r) => r.store === store && r.receipt === receipt);
  if (!view) return null;

  const purchaseEvidence = view.purchaseEvidence.map((entry) => ({
    allocation: entry.allocation,
    sources: [
      { source: '分账子单', ref: entry.allocation.child, locator: {
        network: entry.allocation.network, merchant: entry.allocation.merchant,
        original: entry.allocation.original, child: entry.allocation.child,
      } },
      ...entry.walletEvents.map((w) => ({
        source: `钱包网络批次${w.batch.sequence}`,
        ref: w.event, state: w.state, charged: w.charged, settled: w.settled, batch: w.batch,
      })),
    ],
  }));

  const refundEvidence = view.refundEvidence.map((r) => ({
    refundId: r.refundId,
    line: r.line,
    requested: r.requested,
    walletState: r.walletState,
    charged: r.charged,
    settled: r.settled,
    blocked: r.blocked,
    sources: [
      { source: '收银端', ref: r.evidence.posRefund.id, locator: { store: r.evidence.posRefund.store, receipt: r.evidence.posRefund.receipt, line: r.evidence.posRefund.line } },
      ...(r.evidence.allocation ? [{
        source: '分账子单', ref: r.evidence.allocation.child,
        amount: r.evidence.allocation.amount,
        locator: {
          network: r.evidence.allocation.network, merchant: r.evidence.allocation.merchant,
          original: r.evidence.allocation.original, child: r.evidence.allocation.child,
        },
      }] : []),
      ...r.evidence.wallet.map((w) => ({
        source: w.source, ref: w.event, state: w.state,
        charged: w.charged, settled: w.settled,
        locator: { network: w.network, merchant: w.merchant, original: w.original, child: w.child },
        batch: w.batch,
      })),
    ],
  }));

  // 后续调整：该小票关联的全部税台材料及其门户调整请求。
  const adjustments = model.materials
    .filter((m) => m.store === store && m.receipt === receipt)
    .map((m) => {
      const desk = materialDeskStatus(m, model.portalRequests);
      return {
        materialRef: m.ref, materialState: m.state,
        declared: m.declared, eligibleNet: m.eligibleNet,
        confirmedReductions: m.confirmedReductions,
        usable: desk.usable,
        pendingAdjustment: desk.pendingAdjustment,
        acceptedAdjustment: desk.acceptedAdjustment,
      };
    });

  const manualCases = collectManualCases(model, store, receipt);

  return {
    receipt: { store, receipt },
    financeStatus: view.financeStatus,
    lines: view.lines,
    totals: view.totals,
    purchaseEvidence,
    refundEvidence,
    adjustments,
    manualCases,
    reviewsTouching: model.reviews.filter((rv) =>
      rv.referencedLines.some((lk) => lk.startsWith(`${store}/${receipt}/`))),
  };
}

// 人工案件在事件日志里是 manual-case-opened，投影未直接暴露，这里从事件补取。
function collectManualCases(model, store, receipt) {
  return (model.manualCases ?? []).filter((c) => c.store === store && c.receipt === receipt);
}

// 税台拿旧材料编号来问：一查便知原材料能否使用、是否有调整等确认。
export function queryMaterial(model, materialRef) {
  const material = model.materials.find((m) => m.ref === materialRef);
  if (!material) return null;
  const desk = materialDeskStatus(material, model.portalRequests);
  return {
    materialRef: material.ref,
    store: material.store,
    receipt: material.receipt,
    state: material.state,
    eligibleLines: material.eligibleLines,
    declared: material.declared,
    currentEligibleNet: material.eligibleNet,
    reductions: material.confirmedReductions,
    usable: desk.usable,
    pendingAdjustment: desk.pendingAdjustment,
    acceptedAdjustment: desk.acceptedAdjustment,
    answer: desk.usable
      ? '原材料当前可使用'
      : `原材料当前不可使用：${desk.pendingAdjustment ? '已有一笔调整等待税台确认' : material.state === 'redeemed' ? '材料已兑付，差额走人工处置' : '存在未决事项'}`,
  };
}

export function listReviews(model) {
  return model.reviews.map((rv) => ({
    id: rv.id,
    kind: rv.kind,
    reason: rv.reason,
    locator: rv.locator,
    walletEvents: rv.walletEvents,
    blockedLines: rv.blockedLines,
    referencedLines: rv.referencedLines,
  }));
}

export function financeOverview(model) {
  return model.receipts.map((r) => ({
    store: r.store,
    receipt: r.receipt,
    financeStatus: r.financeStatus,
    totals: r.totals,
    refundCount: r.refunds.length,
    underReview: r.lines.some((l) => l.underReview || l.blocked),
  }));
}
