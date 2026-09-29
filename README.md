# okx-finance

OKX US 只读财务代理（Cloudflare Worker）。OKX 的 API Key/Secret/Passphrase
只保存在 Cloudflare Secrets 里，调用方凭 `MCP_TOKEN`（Bearer）访问。
**本 Worker 只有读接口，没有交易、转账、提现功能。**

## 部署（GitHub 连接方式）

1. 把本目录所有文件推到你的 GitHub repo（`main` 分支）。
2. Cloudflare Dashboard → Workers & Pages → Create → **Connect Git**，
   选择这个 repo。
3. 构建设置：**Build command 留空**（本项目无构建步骤，留空可避免
   npm 安装失败）。
4. 首次部署完成后，进该 Worker 的 **Settings → Variables and Secrets**，
   添加以下 Secret（逐个 Add secret）：

   | Secret | 必填 | 说明 |
   |---|---|---|
   | `OKX_API_KEY` | 是 | OKX API Key（权限只开 Read） |
   | `OKX_SECRET_KEY` | 是 | OKX Secret Key |
   | `OKX_PASSPHRASE` | 是 | OKX Passphrase |
   | `MCP_TOKEN` | 是 | 调用方 Bearer token，40 位以上随机字符 |
   | `OKX_PAY_ADDRESS` | 否 | X Layer 地址（查 USDG 用）；不填则 pay 为 null |

   ⚠️ `MCP_TOKEN` 必须和之后填给 Muse 安全连接器的那一串**完全一致**，
   两边对不上会报 401。

5. 部署后访问 `https://<worker名>.<账号>.workers.dev/health`
   （无需鉴权），看到 `{"ok":true,...}` 即成功。

> 备用方式：也可以直接在 Dashboard 建 Worker → Edit code 粘贴
> `src/worker.js` 的内容 → Save and deploy，再按第 4 步加 Secret。

## 接口一览（全部 GET，均需 `Authorization: Bearer <MCP_TOKEN>`）

| 路由 | 说明 |
|---|---|
| `/health` | 健康检查（免鉴权） |
| `/account-summary` | 账户总览：trading/funding/pay + OKX 官方 USD 估值 |
| `/portfolio` | 三账户持仓明细 |
| `/balances` | 三账户余额明细 |
| `/valuation?ccy=USD` | OKX 官方资产估值（funding+trading+earn+classic） |
| `/ledger/trading` | 交易账户账单。默认近 7 天；`history=true` 查 7 天～3 个月 |
| `/ledger/funding` | 资金账户账单。默认近 1 个月；`history=true` 查 2021 年至今全量 |
| `/deposits` | 充值记录 |
| `/withdrawals` | 提现记录 |
| `/trades` | 成交记录（近 3 个月）。`instType` 可选，不填则聚合 SPOT/MARGIN/SWAP/FUTURES/OPTION |
| `/positions` | 当前持仓 |
| `/pay/balance` | X Layer USDG 余额（需配 `OKX_PAY_ADDRESS`） |

通用分页参数：`after` / `before`（毫秒时间戳）、`limit`（最大 100）。
上游 OKX 报错时本 Worker 返回 **502**（便于区分是 Worker 自身问题还是上游问题）。

## 数据窗口提醒

OKX 的接口窗口是滚动的，过期数据无法再取：
交易账单 3 个月、资金账单（`bills`）1 个月、成交 3 个月。
建议首次部署后尽快做一次全量回填（`history=true`），之后每周增量同步。
