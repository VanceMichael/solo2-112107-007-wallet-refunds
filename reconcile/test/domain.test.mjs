// 领域规则单元测试：金额币种隔离、碰撞隔离、退款状态扣减、税台调整决策。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, sum, groupByCurrency, CurrencyMismatchError } from '../lib/money.mjs';
import { reduce, derive } from '../lib/projection.mjs';
import { planAdjustments } from '../lib/tax-desk.mjs';

const at = '2026-11-30T08:00:00.000Z';
const ev = (type, data) => ({ type, ingestedAt: at, data });

function sales(store, receipt, line, gross, eligible = true, ccy = 'CNY') {
  return ev('sales-line-received', { store, receipt, line, gross_minor: gross, currency: ccy, eligible });
}
function allocation(store, receipt, line, child, network, merchant, original, amount) {
  return ev('allocation-received', {
    store, receipt, line, child, network, merchant, original, amount_minor: amount, currency: 'CNY',
  });
}
function refund(id, store, receipt, line, child, minor) {
  return ev('refund-received', { id, store, receipt, line, child, minor, currency: 'CNY' });
}
function wallet(partial) {
  return ev('wallet-event-received', {
    event: partial.event, network: partial.network, merchant: partial.merchant,
    original: partial.original, child: partial.child, state: partial.state,
    refund: partial.refund,
    charged_minor: partial.charged_minor ?? -100, charged_ccy: partial.charged_ccy ?? 'USD',
    settled_minor: partial.settled_minor ?? -10000, settled_ccy: partial.settled_ccy ?? 'CNY',
    arrivedAt: at, batchSequence: 'P1', batchDay: '2026-11-30', pageStatus: 'arrived',
    ...(partial.supersedes ? { supersedes: partial.supersedes } : {}),
  });
}
function material(ref, store, receipt, state, declared, lines = ['L1']) {
  return ev('tax-material-received', {
    ref, store, receipt, state, declared_minor: declared, currency: 'CNY', eligible_lines: lines,
  });
}

test('金额只能同币种相加，跨币种直接报错', () => {
  assert.throws(() => sum([money(100, 'CNY'), money(2, 'USD')]), CurrencyMismatchError);
  assert.equal(sum([money(100, 'CNY'), money(50, 'CNY')]).minor, 150);
  const buckets = groupByCurrency([money(-100, 'CNY'), money(-2, 'USD'), money(-3, 'USD')]);
  assert.deepEqual(buckets.CNY, { minor: -100, ccy: 'CNY' });
  assert.deepEqual(buckets.USD, { minor: -5, ccy: 'USD' });
});

test('同一钱包定位键候选分摊不唯一时隔离争议行，无共享额度的同行记录继续过账', () => {
  const events = [
    sales('M1', 'R1', 'L1', 80000),
    sales('M9', 'R9', 'L1', 30000),
    // 两个不同门店的分账凭据共用了完全相同的钱包定位键（同 child）-> 碰撞
    allocation('M1', 'R1', 'L1', 'S11', 'A', 'P1', 'X1', 50000),
    allocation('M9', 'R9', 'L1', 'S11', 'A', 'P1', 'X1', 30000),
    wallet({ event: 'E1', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF1' }),
    refund('RF1', 'M1', 'R1', 'L1', 'S11', 10000),
    // 另一行只使用网络 B 的独立额度，不受碰撞影响
    sales('M1', 'R1', 'L2', 20000),
    allocation('M1', 'R1', 'L2', 'S12', 'B', 'P1', 'X2', 20000),
    wallet({ event: 'E2', network: 'B', merchant: 'P1', original: 'X2', child: 'S12', state: 'confirmed', refund: 'RF2' }),
    refund('RF2', 'M1', 'R1', 'L2', 'S12', 5000),
  ];
  const model = derive(reduce(events));
  assert.equal(model.reviews.length, 1);
  assert.equal(model.reviews[0].kind, 'locator_ambiguous');
  assert.deepEqual(model.reviews[0].blockedLines.sort(), ['M1/R1/L1', 'M9/R9/L1']);

  const r1 = model.receipts.find((r) => r.receipt === 'R1');
  const l2 = r1.refunds.find((x) => x.refundId === 'RF2');
  assert.equal(l2.walletState, 'confirmed'); // 无共享额度的同行记录正常过账
  assert.equal(l2.blocked, false);
  const l1 = r1.lines.find((x) => x.line === 'L1');
  assert.equal(l1.blocked, true);
});

test('钱包事件退款引用与分账子单冲突时冻结自身行，退款归属行的自洽记录照常确认', () => {
  const events = [
    sales('M1', 'R1', 'L1', 80000),
    sales('M2', 'R1', 'L1', 30000),
    allocation('M1', 'R1', 'L1', 'S11', 'A', 'P1', 'X1', 50000),
    allocation('M2', 'R1', 'L1', 'S22', 'A', 'P2', 'X1', 30000),
    refund('RF2', 'M1', 'R1', 'L1', 'S11', 20000),
    // E6 拿着 M2 子单的引用却声称退 RF2
    wallet({ event: 'E6', network: 'A', merchant: 'P2', original: 'X1', child: 'S22', state: 'confirmed', refund: 'RF2' }),
    // E5 在 M1 子单上证据自洽，应继续过账
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF2' }),
  ];
  const model = derive(reduce(events));
  const conflict = model.reviews.find((r) => r.kind === 'refund_locator_conflict');
  assert.ok(conflict);
  assert.deepEqual(conflict.blockedLines, ['M2/R1/L1']);
  assert.ok(conflict.referencedLines.includes('M1/R1/L1')); // 只圈定引用，不冻结

  const m2 = model.receipts.find((r) => r.store === 'M2');
  assert.equal(m2.lines[0].blocked, true);
  const m1 = model.receipts.find((r) => r.store === 'M1');
  assert.equal(m1.lines[0].blocked, false);
  const rf2 = m1.refunds.find((x) => x.refundId === 'RF2');
  assert.equal(rf2.walletState, 'confirmed'); // 自洽记录仍被确认
});

test('重发同一钱包事件幂等，pending/rejected 不扣净额，confirmed 扣，reversed 撤销', () => {
  const base = [
    sales('M1', 'R1', 'L1', 80000),
    allocation('M1', 'R1', 'L1', 'S11', 'A', 'P1', 'X1', 50000),
    refund('RF2', 'M1', 'R1', 'L1', 'S11', 20000),
    material('TX1', 'M1', 'R1', 'locked', 70000),
  ];

  // 阶段一：只有 pending
  let model = derive(reduce([
    ...base,
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'pending', refund: 'RF2' }),
  ]));
  assert.equal(model.walletEvents.length, 1);
  assert.equal(model.materials[0].eligibleNet.minor, 70000); // pending 不扣

  // 重发 + confirmed
  model = derive(reduce([
    ...base,
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'pending', refund: 'RF2' }),
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF2' }),
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF2' }),
  ]));
  assert.equal(model.walletEvents.length, 1); // 重发只保留一份
  assert.equal(model.materials[0].eligibleNet.minor, 60000); // 70000 - 钱包实退清算 10000
  assert.equal(model.materials[0].reduced, true);

  // rejected 不扣
  model = derive(reduce([
    ...base,
    wallet({ event: 'E8', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'rejected', refund: 'RF2' }),
  ]));
  assert.equal(model.materials[0].eligibleNet.minor, 70000);

  // reversed 撤销此前的 confirmed
  model = derive(reduce([
    ...base,
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF2' }),
    { ...wallet({ event: 'E9', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'reversed', refund: 'RF2', supersedes: 'E5' }),
      ingestedAt: '2026-12-01T08:00:00.000Z' },
  ]));
  assert.equal(model.materials[0].eligibleNet.minor, 70000); // 冲正后净额恢复
});

test('税台调整决策：待申报改待办、锁定提交、兑付转人工、重发不复发', () => {
  const mk = (state) => derive(reduce([
    sales('M1', 'R1', 'L1', 80000),
    allocation('M1', 'R1', 'L1', 'S11', 'A', 'P1', 'X1', 50000),
    refund('RF2', 'M1', 'R1', 'L1', 'S11', 20000),
    material('TX1', 'M1', 'R1', state, 70000),
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF2' }),
  ]));

  assert.equal(planAdjustments(mk('draft'))[0].action, 'update_todo');
  const locked = planAdjustments(mk('locked'));
  assert.equal(locked[0].action, 'submit_adjust');
  // 同样的证据组合再跑一次：幂等跳过，不复发调整
  const withPortal = mk('locked');
  withPortal.portalRequests.push({
    key: locked[0].key, action: 'adjust', result: 'pending', facts: { materialRef: 'TX1' },
  });
  const again = planAdjustments(withPortal);
  assert.equal(again[0].action, 'skip');
  // 已确认材料允许范围内调整
  assert.equal(planAdjustments(mk('accepted'))[0].action, 'submit_adjust');
  // 已兑付转人工
  const redeemed = planAdjustments(mk('redeemed'));
  assert.equal(redeemed[0].action, 'manual');
  // 已兑付的人工案件立案后重跑也不得重复立案
  const redeemedAgain = mk('redeemed');
  redeemedAgain.manualCases.push({ key: redeemed[0].key, materialRef: 'TX1' });
  assert.equal(planAdjustments(redeemedAgain)[0].action, 'skip');
});

test('商户折扣不是钱包实退款：只有钱包清算额进入合资格扣减', () => {
  // 收银退款申请 30000（含累计折扣口径），但钱包实际只确认清算 20000
  const model = derive(reduce([
    sales('M1', 'R1', 'L1', 80000),
    allocation('M1', 'R1', 'L1', 'S11', 'A', 'P1', 'X1', 50000),
    ev('refund-received', { id: 'RF9', store: 'M1', receipt: 'R1', line: 'L1', child: 'S11', minor: 30000, currency: 'CNY' }),
    material('TX1', 'M1', 'R1', 'locked', 70000),
    wallet({ event: 'E5', network: 'A', merchant: 'P1', original: 'X1', child: 'S11', state: 'confirmed', refund: 'RF9', settled_minor: -20000 }),
  ]));
  const receipt = model.receipts[0];
  assert.equal(receipt.refunds[0].requested.minor, 30000); // 收银申请口径保留
  assert.equal(receipt.refunds[0].settled.minor, 20000);   // 视图取绝对值后的钱包实退款
  assert.equal(model.materials[0].eligibleNet.minor, 50000); // 只按实退 20000 扣
});
