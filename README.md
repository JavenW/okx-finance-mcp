# OKX Finance MCP

Private, read-only OKX finance server for Cloudflare Workers.

## Secrets / variables expected in Cloudflare

- `OKX_API_KEY`
- `OKX_SECRET_KEY`
- `OKX_PASSPHRASE`
- `MCP_TOKEN`
- `OKX_PAY_ADDRESS`

Do not commit any secret values.

## Install / deploy

```bash
npm install
npm run deploy
```

If the Worker already exists in Cloudflare, Wrangler will deploy to that Worker name (`okx-finance`) after you authenticate.

## Endpoints

Public:
- `GET /health`

Private (Bearer `MCP_TOKEN`):
- `/mcp`
- `/portfolio`
- `/balances`
- `/pay/balance`
- `/ledger/trading`
- `/ledger/funding`
- `/deposits`
- `/withdrawals`
- `/trades`
- `/positions`
- `/account-summary`

## MCP tools

- `get_account_summary`
- `get_portfolio`
- `get_balances`
- `get_ledger`
- `get_deposits`
- `get_withdrawals`
- `get_trades`
- `get_positions`
- `get_pay_balance`

All tools are read-only.
