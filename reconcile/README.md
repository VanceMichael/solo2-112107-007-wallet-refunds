# 门店多钱包退款对账流程

在 `source.mjs` 合成来源之上建立的门店侧可持续收件与对账系统。收银端、聚合支付端、
退税台各保留自己的编号，系统只以 **商户 + 分账子单 + 钱包网络记录的原交易引用**
（`network/merchant/original/child` 定位键）作为实际绑定依据，原小票号只用于人工检索，
不参与自动归并。

## 架构

```
来源服务(sales/allocations/refunds/settlement-index/wallet-*/tax/portal)
        │  按阶段拉取，区分 404 文件暂缺 / 503 服务不可用 / 200 已到
        ▼
 ingest.mjs ──校验──► 事件日志 events.log（只追加，按内容指纹去重）
        │                       │
        ▼                       ▼
  inbox/ 原始留档        projection.mjs 纯函数重放
                                │
                 ┌──────────────┼────────────────┐
                 ▼              ▼                ▼
           queries.mjs     tax-desk.mjs     reviews 待核对圈
          （小票/材料查询） （调整决策+门户）
```

- `lib/money.mjs`：金额一律 `{minor, ccy}` 固定币种最小单位；同币种才能相加，
  跨币种直接抛 `CurrencyMismatchError`。消费者扣款额（charged）与清算额（settled）
  币种可能不同，各自分桶记账，绝不换算或混加。
- `lib/ingest.mjs`：收件。结算索引换日/换批次产生新批次观察；清单声明而 404 的页记
  `missing`（文件暂缺），与钱包记录里的 `rejected`/`reversed`（已到的业务结果）严格区分。
- `lib/projection.mjs`：绑定、隔离、净额推导。
- `lib/tax-desk.mjs`：退税材料四态决策与门户幂等交互。
- `lib/store.mjs`：append-only JSONL 事件日志 + 原子快照，跨日重跑从原小票视角完整重建。

## 关键业务规则的落地方式

| 规则 | 实现 |
| --- | --- |
| 不用原小票号归并退款 | 绑定只认钱包定位键；小票号仅作查询入口 |
| 文件暂缺 ≠ 拒绝/冲正 | `missing` 页状态 vs 钱包事件 `state` 分开建模 |
| 分次退款按收银实际行匹配 | 退款事件与该行的分账子单互相印证，商户折扣（申请口径 `requested`）与钱包实退款（`settled`）分别留痕，净额只扣实退 |
| 不跨币种相加 | charged/settled 各带币种，按币种分桶，混加即报错 |
| 引用碰撞/候选不唯一 | 圈出待核对（`reviews`），只冻结争议行；无共享额度的同行记录照常过账 |
| 重发不复发调整 | 调整幂等键 = 材料号 + 已确认退款事件号集合 + 当前净额；证据不变即跳过 |
| 待申报/锁定/已确认/已兑付 | 待申报改本地待办；锁定与已确认（限原 eligible_lines 净额下调）走门户 adjust；已兑付转人工案件 |
| 钱包 pending/rejected/reversed | pending 不扣、rejected 不扣、reversed 凭 `supersedes` 撤销此前 confirmed |
| 退税材料不过早可递交 | 有待确认调整或已兑付时 `usable=false`，`material` 命令可直接答复税台问讯 |

## 命令

先启动来源：`npm run source`（默认 `127.0.0.1:4173`）。

```bash
# 收件 + 税台调整决策（默认 confirmed 阶段，可用 --phase / --all）
node reconcile/cli.mjs run --phase opening
node reconcile/cli.mjs run --phase interim
node reconcile/cli.mjs run --phase confirmed

# 门户回执核实（pending 或 503 待核实的 adjust 用 inspect 取最终结果）
node reconcile/cli.mjs inspect --phase confirmed

# 财务查询：某张小票的购买、退款、后续调整各自的原始依据
node reconcile/cli.mjs receipt M1 R1

# 税台拿旧材料编号来问：能否使用、是否有调整等确认
node reconcile/cli.mjs material TX1

node reconcile/cli.mjs reviews   # 待核对圈
node reconcile/cli.mjs overview  # 财务清算状态总览
node reconcile/cli.mjs rebuild   # 忽略快照，从事件日志完整重放
```

环境变量：`SOURCE_URL`（或 `SOURCE_PORT`）、`RECONCILE_DIR`（默认 `./reconcile-data`）。

## 财务状态含义

- `pending_clearance`：财务待清算，尚无退款进入清算；
- `awaiting_clearance`：有 pending/rejected 退款或批次页暂缺，等待清算；
- `refund_in_clearance`：退款已入清算（存在 confirmed 钱包事件）；
- `manual_review`：存在被冻结的待核对行，需人工处置后才能过账。

## 测试

```bash
npm test   # 来源协议测试 + 领域单元测试 + 三阶段端到端测试
```

端到端测试在同进程内驱动 CLI 库函数（保留真实 HTTP），避免受限环境下孙进程网络被沙箱阻断；
CLI 入口与库函数共用同一 `runCommand`，手动运行与测试路径行为一致。
