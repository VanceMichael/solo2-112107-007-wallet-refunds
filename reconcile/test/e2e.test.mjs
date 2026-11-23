// 端到端：启动合成来源，在同进程内跑完 opening -> interim -> confirmed 的完整收件、
// 碰撞隔离、税台调整与门户幂等流程。真实 HTTP 调用都保留，只省去孙进程 spawn
// （受限沙箱会阻断孙进程网络，同进程驱动在任何环境都可重复）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeSource } from '../../source.mjs';
import { runCommand } from '../cli.mjs';

let server;
let baseUrl;
let dataDir;

before(async () => {
  server = makeSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  dataDir = mkdtempSync(join(tmpdir(), 'reconcile-e2e-'));
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function run(command, argv = []) {
  return runCommand(command, argv, { baseUrl, dataDir });
}
const snapshot = () => JSON.parse(readFileSync(join(dataDir, 'snapshot.json'), 'utf8')).model;

test('三阶段收件：批次换日、暂缺页、重发与碰撞隔离', async () => {
  // opening：钱包 A 的 RF2 仍 pending，钱包 B 的 RF1 已确认
  const opening = await run('run', ['--phase', 'opening']);
  assert.ok(opening.overview.some((r) => r.receipt === 'R1'));
  const r1Opening = await run('receipt', ['M1', 'R1']);
  assert.equal(r1Opening.financeStatus, 'refund_in_clearance'); // 已有一笔 confirmed
  const tx1Opening = await run('material', ['TX1']);
  assert.equal(tx1Opening.currentEligibleNet.minor, 60000); // 70000 - RF1 实退 10000
  // RF1 已确认且 TX1 已锁定：第一笔调整应已提交等待税台确认（RF2 仍 pending 不参与）
  assert.ok(tx1Opening.pendingAdjustment);
  assert.equal(tx1Opening.usable, false);

  // interim：批次换日 P22 -> P23，wallet-c 在清单里但文件暂缺
  await run('run', ['--phase', 'interim']);
  const p23 = snapshot().batches.find((b) => b.sequence === 'P23');
  assert.equal(p23.pages.find((p) => p.name === 'wallet-c').status, 'missing'); // 文件暂缺
  assert.equal(p23.pages.find((p) => p.name === 'wallet-a').status, 'arrived');

  // E6 碰撞：M2 子单引用却声称退 RF2 -> M2/R1/L1 被冻结，M1 的 E3 pending 不受影响
  const reviews = await run('reviews');
  const conflict = reviews.find((r) => r.kind === 'refund_locator_conflict');
  assert.ok(conflict, '应圈出原交易引用碰撞');
  assert.deepEqual(conflict.blockedLines, ['M2/R1/L1']);
  assert.ok(conflict.referencedLines.includes('M1/R1/L1'));
  const m2 = await run('receipt', ['M2', 'R1']);
  assert.equal(m2.lines[0].blocked, true);
  const m1 = await run('receipt', ['M1', 'R1']);
  assert.equal(m1.lines.find((l) => l.line === 'L1').blocked, false); // 无共享额度继续处理

  // confirmed：wallet-c 到达，重复 E5 只算一次；RF2 最终确认
  await run('run', ['--phase', 'confirmed']);
  const e5 = snapshot().walletEvents.filter((w) => w.event === 'E5');
  assert.equal(e5.length, 1, '重复 E5 是重发，只能保留一条业务事实');
  assert.equal(e5[0].disposition.status, 'applied');

  // RF2 实退 20000 进入清算，TX1 净额从 60000 再降到 40000
  const r1 = await run('receipt', ['M1', 'R1']);
  const rf2 = r1.refundEvidence.find((x) => x.refundId === 'RF2');
  assert.equal(rf2.walletState, 'confirmed');
  assert.deepEqual(rf2.settled, { minor: 20000, ccy: 'CNY' });
  assert.deepEqual(rf2.charged, { minor: 2800, ccy: 'USD' }); // 消费者币种另记，不混加
  // 多币种分桶：CNY 与 USD/JPY 各自合计（视图取退款绝对值）
  assert.equal(r1.totals.refundSettled.CNY.minor, 30000); // RF1 10000 + RF2 20000
  assert.equal(r1.totals.refundCharged.USD.minor, 2800);
  assert.equal(r1.totals.refundCharged.JPY.minor, 2000);
});

test('锁定材料的迟到退款触发调整，重跑不复发，税台问讯可直接答复', async () => {
  const tx1 = await run('material', ['TX1']);
  assert.equal(tx1.currentEligibleNet.minor, 40000); // 60000 - 20000
  assert.equal(tx1.usable, false); // 已有调整等待确认
  assert.ok(tx1.pendingAdjustment, '应有一笔 adjust 等税台确认');
  const adjustKey = tx1.pendingAdjustment.key;

  // 再次 run：同样的证据组合不得复发调整
  const rerun = await run('run', ['--phase', 'confirmed']);
  const skipped = rerun.decisions.find((d) => d.materialRef === 'TX1');
  assert.equal(skipped.action, 'skip');
  const tx1Again = await run('material', ['TX1']);
  assert.equal(tx1Again.pendingAdjustment.key, adjustKey);

  // inspect 后门户回执变为 accepted，材料恢复可用且留痕
  await run('inspect', ['--phase', 'confirmed']);
  const accepted = await run('material', ['TX1']);
  assert.equal(accepted.pendingAdjustment, null);
  assert.ok(accepted.acceptedAdjustment);
  assert.equal(accepted.usable, true);
});

test('已兑付材料的差额转人工，且每笔依据可追溯到原始来源', async () => {
  // RF3 在 confirmed 阶段才到，对应 TX2 已 redeemed
  const r2 = await run('receipt', ['M1', 'R2']);
  const rf3 = r2.refundEvidence.find((x) => x.refundId === 'RF3');
  assert.equal(rf3.walletState, 'confirmed');
  assert.equal(rf3.sources.length, 3); // 收银端 + 分账子单 + 钱包网络，三方编号各自保留
  assert.ok(rf3.sources.some((s) => s.source === '收银端' && s.ref === 'RF3'));
  assert.ok(rf3.sources.some((s) => s.source === '钱包网络B' && s.ref === 'E7'));

  const tx2 = await run('material', ['TX2']);
  assert.equal(tx2.usable, false);
  const manual = snapshot().manualCases.find((c) => c.materialRef === 'TX2');
  assert.ok(manual, '已兑付差额必须有人工案件');
  assert.equal(manual.difference.minor, 5000);
});

test('跨日重跑从原小票视角核对，事件日志可完整重建快照', async () => {
  const before = JSON.parse(readFileSync(join(dataDir, 'snapshot.json'), 'utf8'));
  const rebuilt = await run('rebuild');
  assert.deepEqual(rebuilt.materials.map((m) => [m.ref, m.eligibleNet.minor]),
    before.model.materials.map((m) => [m.ref, m.eligibleNet.minor]));
  // 重复 ingest：业务记录（收银行/分摊/退款/钱包/税台）按内容指纹全部去重，
  // 批次观察只有在页状态变化时才新增；再跑一次完全相同的 confirmed 应为 0 新事件。
  const dup = await run('ingest', ['--phase', 'confirmed']);
  assert.equal(dup.events, 0);
  assert.ok(dup.duplicates > 0);
  const dup2 = await run('ingest', ['--phase', 'confirmed']);
  assert.equal(dup2.events, 0);
});
