# 门店多钱包退款的交易凭据采集与结案

门店会计收集商户分账子单、钱包清算页与退税台记录。 这些上游资料可通过本地合成接口查阅。支付结算目录以交易日及批次 sequence 标识，门店合单后仍以各分账凭据定义钱包对应关系。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

货款、退款申请和退税材料均用原小票币种最小单位。结算记录的 charged 和 settled 各有自己的币种和符号，confirmed 退款的 CNY 结算额在相符的分账凭据内核算，pending 不扣，rejected 不扣，reversed 撤销此前引用的确认。小票与行需带 store，原钱包引用需带 network 和 merchant。税端状态 locked、accepted、redeemed 分别为已锁、已确认、已兑付。已确认只允许对该材料原 eligible_lines 做净额调整。portal 支持 adjust、inspect。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`sales`, `allocations`, `refunds`, `settlement-index`, `wallet-a`, `wallet-b`, `tax`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `result`。合成门户保留请求并提供回执查询。

`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。
