// 退税材料调整决策。
// 迟到的最终退款回执若降低合资格净额：
//   材料仍在“待申报” -> 只更新本地待办，不向税台发调整（材料尚未锁，直接改待办即可）；
//   已锁定（locked）-> 通过门户提交 adjust，等待税台确认；
//   已确认（accepted）-> 只能在税台允许的调整范围内（原 eligible_lines、净额下调）提交；
//   已兑付（redeemed）-> 门户不再受理，差额转人工处置。
// 钱包重发确认不应复发调整：按 (材料, 退款依据集合) 派生幂等键，证据不变就不重复提交。

import { postPortal } from './source-client.mjs';
import { materialDeskStatus } from './projection.mjs';

function adjustmentKey(materialView) {
  // 幂等键由材料号 + 全部已确认退款的钱包事件号 + 当前净额组成；
  // 重发同一钱包事件不会改变组成，键不变，门户侧也按同键同报文返回原回执。
  const basis = materialView.confirmedReductions
    .map((r) => `${r.refundId}:${r.walletEvent}`)
    .sort()
    .join('|');
  return `ADJ-${materialView.ref}-${createShortHash(`${basis}|${materialView.eligibleNet.minor}`)}`;
}

function createShortHash(text) {
  // 内联简短哈希，避免本模块再依赖投影内部实现。
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// 计算本次需要落库的调整决定（纯函数，不触网）。
export function planAdjustments(derived) {
  const existingPortalRequests = derived.portalRequests;
  const decisions = [];
  for (const material of derived.materials) {
    if (!material.reduced) continue; // 净额没有下降，什么都不做
    const key = adjustmentKey(material);
    const already = existingPortalRequests.find((req) => req.key === key)
      || derived.manualCases.find((c) => c.key === key)
      || derived.todoUpdates.find((t) => t.key === key);
    const desk = materialDeskStatus(material, existingPortalRequests);

    const base = {
      key,
      materialRef: material.ref,
      store: material.store,
      receipt: material.receipt,
      declared: material.declared,
      eligibleNet: material.eligibleNet,
      reductionTotal: material.reductionTotal,
      basis: material.confirmedReductions.map((r) => ({
        refundId: r.refundId, line: r.line, walletEvent: r.walletEvent, amount: r.amount,
      })),
    };

    if (already) {
      decisions.push({ ...base, action: 'skip', reason: '该证据组合的调整请求已存在（钱包重发不复发调整）', request: already });
      continue;
    }

    if (material.state === 'redeemed') {
      decisions.push({ ...base, action: 'manual', reason: '材料已兑付，税台门户不再受理调整，差额转人工处置' });
      continue;
    }

    if (desk.pendingAdjustment) {
      decisions.push({ ...base, action: 'skip', reason: '已有一笔调整等待税台确认，等待回执即可' });
      continue;
    }

    if (material.state === 'accepted') {
      // 税台允许范围：只能引用原 eligible_lines，且只能下调净额。
      const outsideLines = material.confirmedReductions.some((r) => !material.eligibleLines.includes(r.line));
      if (outsideLines || material.eligibleNet.minor >= material.declared.minor) {
        decisions.push({ ...base, action: 'manual', reason: '调整超出税台允许范围（原 eligible_lines 内净额下调），转人工' });
        continue;
      }
      decisions.push({ ...base, action: 'submit_adjust', reason: '材料已确认，在允许范围内提交净额调整' });
      continue;
    }

    if (material.state === 'locked') {
      decisions.push({ ...base, action: 'submit_adjust', reason: '材料已锁定，迟到退款降低净额，提交调整等待税台确认' });
      continue;
    }

    // 待申报（draft/pending 等未锁状态）：只更新本地待办。
    decisions.push({ ...base, action: 'update_todo', reason: '材料仍在待申报，直接更新本地待办净额，不提交税台调整' });
  }
  return decisions;
}

// 执行需要门户交互的决定，返回要追加的事件列表。
export async function executeDecisions(decisions, portalUrl) {
  const events = [];
  for (const decision of decisions) {
    if (decision.action === 'update_todo') {
      events.push({
        type: 'tax-todo-updated',
        at: new Date().toISOString(),
        data: {
          materialRef: decision.materialRef, key: decision.key,
          eligibleNet: decision.eligibleNet, basis: decision.basis, reason: decision.reason,
        },
      });
      continue;
    }
    if (decision.action === 'manual') {
      events.push({
        type: 'manual-case-opened',
        at: new Date().toISOString(),
        data: {
          materialRef: decision.materialRef, key: decision.key,
          difference: decision.reductionTotal, eligibleNet: decision.eligibleNet, reason: decision.reason,
        },
      });
      continue;
    }
    if (decision.action !== 'submit_adjust') continue;

    const payload = {
      action: 'adjust',
      key: decision.key,
      facts: {
        materialRef: decision.materialRef,
        store: decision.store,
        receipt: decision.receipt,
        declaredMinor: decision.declared.minor,
        currency: decision.declared.ccy,
        revisedEligibleNetMinor: decision.eligibleNet.minor,
        eligibleLines: decision.basis.map((b) => b.line),
        refundBasis: decision.basis,
      },
    };
    const response = await postPortal(portalUrl, payload);
    const recorded = {
      type: 'portal-request-recorded',
      at: new Date().toISOString(),
      data: {
        key: decision.key,
        action: 'adjust',
        materialRef: decision.materialRef,
        payload,
        httpStatus: response.status,
        sourceRef: response.data?.sourceRef ?? null,
        result: response.data?.result ?? null,
        raw: response.data,
        // 503 时门户可能已收到请求：登记为待核实，后续用 inspect 确认，绝不重复提交新键。
        needsInspect: response.status === 503,
      },
    };
    events.push(recorded);
  }
  return events;
}

// 用 inspect 核实待确认/待核实的门户请求，更新本地回执状态。
export async function inspectRequests(portalRequests, portalUrl) {
  const events = [];
  for (const req of portalRequests) {
    if (req.action !== 'adjust') continue;
    if (req.result === 'accepted' || req.result === 'rejected') continue;
    const payload = { action: 'inspect', key: req.key };
    const response = await postPortal(portalUrl, payload);
    if (response.status !== 200) continue;
    events.push({
      type: 'portal-request-recorded',
      at: new Date().toISOString(),
      data: {
        key: req.key,
        action: 'adjust',
        materialRef: req.materialRef,
        payload: req.payload,
        httpStatus: response.status,
        sourceRef: response.data?.sourceRef ?? req.sourceRef,
        result: response.data?.result ?? req.result,
        raw: response.data,
        needsInspect: false,
        inspectedAt: new Date().toISOString(),
      },
    });
  }
  return events;
}
