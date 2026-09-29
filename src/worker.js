/**
 * OKX Finance Worker (Cloudflare Workers)
 * =======================================
 * Read-only proxy: signs OKX API v5 requests server-side so API secrets never
 * leave Cloudflare. A single shared Bearer token (MCP_TOKEN) authorizes callers.
 *
 * Base URL: https://us.okx.com  (OKX US)
 * Auth model:
 *   - Cloudflare Secrets: OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE,
 *     MCP_TOKEN, OKX_PAY_ADDRESS (optional)
 *   - Callers: Authorization: Bearer <MCP_TOKEN>
 *
 * Fixes applied vs the user's original v2.0.0 (verified against OKX API v5 docs):
 *  1. /ledger/trading used to only request /account/bills-archive, which SKIPS
 *     the last 7 days. Now it defaults to /account/bills (last 7 days); pass
 *     history=true to use /account/bills-archive (7 days .. 3 months).
 *  2. /ledger/funding: /asset/bills-history DOES exist — it returns ALL funding
 *     bills since 2021-02-01 (rate limit 1 req/s), ideal for one-time backfill.
 *     Default (no history flag) uses /asset/bills (past month only, 6 req/s),
 *     ideal for incremental sync.
 *  3. /trades: OKX requires instType on /trade/fills-history. When instType is
 *     omitted the worker fans out across SPOT/MARGIN/SWAP/FUTURES/OPTION
 *     sequentially and merges results by time.
 *  4. NEW /valuation route: /asset/asset-valuation?ccy=USD returns the REAL
 *     total USD valuation (funding + trading + earn + classic). /account-summary
 *     includes it when available (null if the OKX US entity does not support it).
 *  5. OKX_PAY_ADDRESS is optional: /portfolio and /balances work without it;
 *     only /pay/balance reports "not configured". Pay balances are read from
 *     the X Layer public RPC (eth_getBalance + balanceOf on known OKX Pay
 *     tokens USDG/USDT/USDC); a pay lookup failure degrades to pay:null
 *     (+payError) on aggregate routes instead of failing them.
 *  6. Upstream OKX / X Layer errors surface as HTTP 502 (not 500), so worker
 *     bugs are distinguishable from upstream failures.
 *
 * Data windows (OKX-side, rolling):
 *  - /account/bills:           last 7 days
 *  - /account/bills-archive:   7 days .. 3 months
 *  - /asset/bills:             past month
 *  - /asset/bills-history:     all time since 2021-02-01
 *  - /trade/fills-history:     last 3 months
 * Back up early: anything older than these windows is unrecoverable via API.
 *
 * NOTE: This worker is strictly READ-ONLY. It never implements trade,
 * transfer, or withdrawal operations.
 */

const OKX_BASE = "https://us.okx.com";

// Instrument types fanned out by /trades when instType is omitted.
const TRADE_INST_TYPES = ["SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION"];

const ROUTES = [
  "/health",
  "/account-summary",
  "/portfolio",
  "/balances",
  "/valuation",
  "/ledger/trading",
  "/ledger/funding",
  "/deposits",
  "/withdrawals",
  "/trades",
  "/positions",
  "/pay/balance",
];

/* ------------------------------------------------------------------ */
/* Auth + signed OKX requests                                          */
/* ------------------------------------------------------------------ */

function checkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return token && env.MCP_TOKEN && token === env.MCP_TOKEN;
}

async function okxRequest(env, path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  }
  const queryString = qs.toString();
  const requestPath = queryString ? `${path}?${queryString}` : path;

  const timestamp = new Date().toISOString();
  const prehash = timestamp + "GET" + requestPath;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.OKX_SECRET_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(prehash)
  );
  const sign = btoa(String.fromCharCode(...new Uint8Array(sig)));

  const res = await fetch(`${OKX_BASE}${requestPath}`, {
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": env.OKX_API_KEY,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": env.OKX_PASSPHRASE,
      "Content-Type": "application/json",
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== "0") {
    const err = new Error(
      `OKX API error ${body.code || res.status}: ${body.msg || res.statusText}`
    );
    err.upstream = true;
    err.status = res.status;
    err.okxCode = body.code;
    throw err;
  }
  return body.data || [];
}

function isUpstreamError(e) {
  return !!(e && e.upstream);
}

/* ------------------------------------------------------------------ */
/* OKX data helpers                                                    */
/* ------------------------------------------------------------------ */

async function getTradingBalance(env) {
  const data = await okxRequest(env, "/api/v5/account/balance");
  const acct = data[0] || {};
  return {
    totalEqUsd: acct.totalEq || null,
    isoEqUsd: acct.isoEq || null,
    adjEqUsd: acct.adjEq || null,
    details: (acct.details || []).map((d) => ({
      ccy: d.ccy,
      cashBal: d.cashBal,
      availBal: d.availBal,
      frozenBal: d.frozenBal,
      eqUsd: d.eqUsd,
    })),
  };
}

async function getFundingBalances(env) {
  const data = await okxRequest(env, "/api/v5/asset/balances");
  return data.map((b) => ({
    ccy: b.ccy,
    bal: b.bal,
    availBal: b.availBal,
    frozenBal: b.frozenBal,
  }));
}

async function getTradingLedger(
  env,
  { type, instType, after, before, limit = "100", history = false, ccy } = {}
) {
  // /account/bills: last 7 days. /account/bills-archive: 7 days .. 3 months.
  const path = history
    ? "/api/v5/account/bills-archive"
    : "/api/v5/account/bills";
  const params = { type, instType, ccy, after, before, limit };
  const data = await okxRequest(env, path, params);
  return data.map((b) => ({
    billId: b.billId,
    ts: b.ts,
    ccy: b.ccy,
    balanceChange: b.balChg,
    balance: b.bal,
    type: b.type,
    subType: b.subType,
    instId: b.instId || null,
    orderId: b.ordId || null,
    tradeId: b.tradeId || null,
    fee: b.fee || null,
    pnl: b.pnl || null,
  }));
}

async function getFundingLedger(
  env,
  { type, ccy, after, before, limit = "100", history = false } = {}
) {
  // /asset/bills:         past month only (6 req/s) — good for incremental sync.
  // /asset/bills-history: all time since 2021-02-01 (1 req/s) — good for backfill.
  const path = history ? "/api/v5/asset/bills-history" : "/api/v5/asset/bills";
  const params = { type, ccy, after, before, limit };
  const data = await okxRequest(env, path, params);
  return data.map((b) => ({
    billId: b.billId,
    ts: b.ts,
    ccy: b.ccy,
    balanceChange: b.balChg,
    balance: b.bal,
    type: b.type,
    clientId: b.clientId || null,
    notes: b.notes || null,
  }));
}

async function getDeposits(env, { ccy, after, before, limit = "100" } = {}) {
  const data = await okxRequest(env, "/api/v5/asset/deposit-history", {
    ccy,
    after,
    before,
    limit,
  });
  return data.map((d) => ({
    depId: d.depId,
    ts: d.ts,
    ccy: d.ccy,
    amt: d.amt,
    txId: d.txId || null,
    chain: d.chain || null,
    state: d.state,
    type: d.type,
    from: d.from || null,
    fromWdId: d.fromWdId || null,
    to: d.to || null,
  }));
}

async function getWithdrawals(env, { ccy, after, before, limit = "100" } = {}) {
  const data = await okxRequest(env, "/api/v5/asset/withdrawal-history", {
    ccy,
    after,
    before,
    limit,
  });
  return data.map((w) => ({
    wdId: w.wdId,
    ts: w.ts,
    ccy: w.ccy,
    amt: w.amt,
    fee: w.fee || null,
    txId: w.txId || null,
    chain: w.chain || null,
    state: w.state,
    type: w.type,
    from: w.from || null,
    to: w.to || null,
  }));
}

/** Real USD valuation across funding + trading + earn + classic. */
async function getValuation(env, ccy = "USD") {
  const data = await okxRequest(env, "/api/v5/asset/asset-valuation", { ccy });
  const v = data[0] || {};
  return {
    ccy,
    total: v.totalBal ?? null,
    details: v.details || null, // { classic, earn, funding, trading }
  };
}

/* ------------------------------------------------------------------ */
/* OKX Pay balance via X Layer public RPC                              */
/* ------------------------------------------------------------------ */

const XLAYER_RPC = "https://rpc.xlayer.tech";

// Known OKX Pay tokens on X Layer (chain id 196). Source: OKX's official
// okx/payments repo (networks & assets table), verified on-chain.
const PAY_TOKENS = [
  { symbol: "USDG", contract: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6 },
  { symbol: "USDT", contract: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 6 },
  { symbol: "USDC", contract: "0x74b7f16337b8972027f6196a17a631ac6de26d22", decimals: 6 },
];

async function xlayerRpc(method, params) {
  const res = await fetch(XLAYER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    const err = new Error(
      `X Layer RPC error: ${body.error.message || "code " + body.error.code}`
    );
    err.upstream = true;
    throw err;
  }
  return body.result;
}

function hexToBigInt(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return 0n;
  return BigInt(hex);
}

// Exact decimal formatting without float precision loss.
function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const head = s.slice(0, -decimals);
  const tail = s.slice(-decimals).replace(/0+$/, "");
  return tail ? `${head}.${tail}` : head;
}

async function getPayBalance(env) {
  // Pay address is optional: aggregate routes still work without it,
  // only the pay section will be null.
  if (!env.OKX_PAY_ADDRESS) return null;
  const addr = env.OKX_PAY_ADDRESS;
  const balOfData =
    "0x70a08231" +
    "000000000000000000000000" +
    addr.toLowerCase().replace(/^0x/, "");
  const [nativeHex, ...tokenHexes] = await Promise.all([
    xlayerRpc("eth_getBalance", [addr, "latest"]),
    ...PAY_TOKENS.map((t) =>
      xlayerRpc("eth_call", [{ to: t.contract, data: balOfData }, "latest"])
    ),
  ]);
  const nativeRaw = hexToBigInt(nativeHex);
  return {
    address: addr,
    chain: "X Layer",
    native: {
      symbol: "OKB",
      balance: formatUnits(nativeRaw, 18),
      raw: nativeRaw.toString(),
    },
    tokens: PAY_TOKENS.map((t, i) => {
      const raw = hexToBigInt(tokenHexes[i]);
      return {
        symbol: t.symbol,
        contract: t.contract,
        decimals: t.decimals,
        balance: formatUnits(raw, t.decimals),
        raw: raw.toString(),
      };
    }).filter((t) => t.raw !== "0"),
  };
}

// A pay lookup must never take down aggregate routes.
async function settlePay(env) {
  try {
    return { pay: await getPayBalance(env), payError: null };
  } catch (e) {
    return { pay: null, payError: e.message || String(e) };
  }
}

function mapFill(f) {
  return {
    tradeId: f.tradeId,
    orderId: f.ordId,
    ts: f.ts,
    instId: f.instId,
    instType: f.instType,
    side: f.side,
    price: f.fillPx,
    size: f.fillSz,
    pnl: f.fillPnl ?? null,
    fee: f.fee,
    feeCcy: f.feeCcy,
    execType: f.execType,
  };
}

async function getTrades(
  env,
  { instType, instId, after, before, begin, end, limit = "100" } = {}
) {
  // OKX requires instType on /trade/fills-history. When omitted we fan out
  // across all instrument types sequentially (rate-limit friendly) and merge.
  const types = instType ? [instType] : TRADE_INST_TYPES;
  let all = [];
  for (const t of types) {
    const data = await okxRequest(env, "/api/v5/trade/fills-history", {
      instType: t,
      instId,
      after,
      before,
      begin,
      end,
      limit,
    });
    all = all.concat(data.map(mapFill));
    if (!instType) await new Promise((r) => setTimeout(r, 250));
  }
  all.sort((a, b) => Number(b.ts) - Number(a.ts));
  const n = parseInt(limit, 10);
  return Number.isFinite(n) && n > 0 ? all.slice(0, n) : all;
}

async function getPositions(env) {
  return okxRequest(env, "/api/v5/account/positions");
}

async function getPortfolio(env) {
  const [trading, funding, { pay, payError }] = await Promise.all([
    getTradingBalance(env),
    getFundingBalances(env),
    settlePay(env),
  ]);
  return {
    ts: new Date().toISOString(),
    accounts: {
      trading: {
        totalEqUsd: trading.totalEqUsd,
        balances: trading.details,
      },
      funding: {
        // Funding balances have no per-currency USD quote; use /valuation
        // for the real USD total instead of inventing one.
        balances: funding,
      },
      pay,
    },
    ...(payError ? { payError } : {}),
  };
}

async function getAccountSummary(env) {
  const [trading, funding, portfolio, valuation] = await Promise.all([
    getTradingBalance(env),
    getFundingBalances(env),
    getPortfolio(env),
    // asset-valuation may not exist on every OKX entity; degrade gracefully.
    getValuation(env, "USD").catch(() => null),
  ]);
  return {
    ts: new Date().toISOString(),
    trading: {
      totalEqUsd: trading.totalEqUsd,
      isoEqUsd: trading.isoEqUsd,
      adjEqUsd: trading.adjEqUsd,
      currencyCount: trading.details.length,
    },
    funding: {
      currencyCount: funding.length,
      balances: funding,
    },
    pay: portfolio.accounts.pay,
    ...(portfolio.payError ? { payError: portfolio.payError } : {}),
    // Real USD total (funding + trading + earn + classic) straight from OKX.
    valuation,
  };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseQuery(url) {
  const q = Object.fromEntries(new URL(url).searchParams.entries());
  // Normalize history to a real boolean: only "true"/"1" mean true.
  // (Without this, history=false would stay the truthy string "false".)
  if (q.history !== undefined) {
    q.history = q.history === "true" || q.history === "1";
  }
  return q;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method !== "GET") {
    return json({ ok: false, error: "Only GET is supported" }, 405);
  }

  if (path === "/health") {
    return json({
      ok: true,
      service: "okx-finance",
      version: "2.0.4",
      routes: ROUTES,
      auth: "Authorization: Bearer <MCP_TOKEN>",
      readOnly: true,
    });
  }

  if (!checkAuth(request, env)) {
    return json(
      { ok: false, error: "Unauthorized: valid Bearer token required" },
      401
    );
  }

  const query = parseQuery(request.url);

  try {
    switch (path) {
      case "/account-summary":
        return json({ ok: true, data: await getAccountSummary(env) });

      case "/portfolio":
        return json({ ok: true, data: await getPortfolio(env) });

      case "/balances": {
        const [trading, funding, { pay, payError }] = await Promise.all([
          getTradingBalance(env),
          getFundingBalances(env),
          settlePay(env),
        ]);
        return json({
          ok: true,
          data: { trading, funding, pay, ...(payError ? { payError } : {}) },
        });
      }

      case "/valuation":
        return json({
          ok: true,
          data: await getValuation(env, query.ccy || "USD"),
        });

      case "/ledger/trading":
        return json({
          ok: true,
          data: await getTradingLedger(env, query),
          source: query.history
            ? "/api/v5/account/bills-archive"
            : "/api/v5/account/bills",
        });

      case "/ledger/funding":
        return json({
          ok: true,
          data: await getFundingLedger(env, query),
          source: query.history
            ? "/api/v5/asset/bills-history"
            : "/api/v5/asset/bills",
        });

      case "/deposits":
        return json({ ok: true, data: await getDeposits(env, query) });

      case "/withdrawals":
        return json({ ok: true, data: await getWithdrawals(env, query) });

      case "/trades":
        return json({ ok: true, data: await getTrades(env, query) });

      case "/positions":
        return json({ ok: true, data: await getPositions(env) });

      case "/pay/balance": {
        const pay = await getPayBalance(env);
        if (!pay) {
          return json(
            { ok: false, error: "OKX_PAY_ADDRESS is not configured" },
            501
          );
        }
        return json({ ok: true, data: pay });
      }

      default:
        return json(
          { ok: false, error: "Not found", routes: ROUTES },
          404
        );
    }
  } catch (e) {
    if (isUpstreamError(e)) {
      return json(
        { ok: false, error: e.message, upstream: true, okxCode: e.okxCode },
        502
      );
    }
    return json({ ok: false, error: e.message || "Worker error" }, 500);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
