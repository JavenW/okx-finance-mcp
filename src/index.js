import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const OKX_BASE = "https://us.okx.com";
const XLAYER_RPC = "https://rpc.xlayer.tech";

const USDG_ADDRESS = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const USDG_DECIMALS = 6;

// -------------------- HTTP helpers --------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error, status = 500) {
  console.error(error);
  return json(
    {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    },
    status
  );
}

function isAuthorized(request, env) {
  if (!env.MCP_TOKEN) return false;
  return request.headers.get("Authorization") === `Bearer ${env.MCP_TOKEN}`;
}

function clampLimit(value, defaultValue = 100, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  return Math.min(Math.floor(n), max);
}

function buildQuery(params) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }

  const s = search.toString();
  return s ? `?${s}` : "";
}

function isoToMs(value) {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ISO date/time: ${value}`);
  }
  return String(ms);
}

function mcpText(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
      },
    ],
  };
}

// -------------------- OKX signing --------------------

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function sign(secret, message) {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );

  return toBase64(signature);
}

async function okxGet(env, path, params = {}) {
  const query = buildQuery(params);
  const requestPath = path + query;

  const timestamp = new Date().toISOString();

  const signature = await sign(
    env.OKX_SECRET_KEY,
    timestamp + "GET" + requestPath
  );

  const response = await fetch(OKX_BASE + requestPath, {
    method: "GET",
    headers: {
      "OK-ACCESS-KEY": env.OKX_API_KEY,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": env.OKX_PASSPHRASE,
      "Content-Type": "application/json",
    },
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`OKX returned non-JSON response (${response.status})`);
  }

  if (!response.ok || data.code !== "0") {
    throw new Error(
      `OKX ${data.code ?? response.status}: ${data.msg ?? response.statusText}`
    );
  }

  return data.data ?? [];
}

// -------------------- X Layer / Pay --------------------

async function xlayerRpc(method, params) {
  const response = await fetch(XLAYER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`X Layer HTTP error: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      `X Layer RPC ${data.error.code}: ${data.error.message}`
    );
  }

  return data.result;
}

function padAddress(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) {
    throw new Error("Invalid OKX_PAY_ADDRESS");
  }

  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function getErc20Balance(tokenAddress, walletAddress) {
  const callData = "0x70a08231" + padAddress(walletAddress);

  const result = await xlayerRpc("eth_call", [
    {
      to: tokenAddress,
      data: callData,
    },
    "latest",
  ]);

  return BigInt(result);
}

async function getPayBalance(env) {
  if (!env.OKX_PAY_ADDRESS) {
    throw new Error("OKX_PAY_ADDRESS is not configured");
  }

  const raw = await getErc20Balance(USDG_ADDRESS, env.OKX_PAY_ADDRESS);

  return {
    account: "pay",
    asset: "USDG",
    balance: Number(raw) / 10 ** USDG_DECIMALS,
    rawBalance: raw.toString(),
    decimals: USDG_DECIMALS,
    chain: "X Layer",
    address: env.OKX_PAY_ADDRESS,
  };
}

// -------------------- Balances / portfolio --------------------

async function getTradingBalance(env) {
  const data = await okxGet(env, "/api/v5/account/balance");
  return data[0] ?? null;
}

async function getFundingBalances(env) {
  return await okxGet(env, "/api/v5/asset/balances");
}

async function getAllBalances(env) {
  const [trading, funding, pay] = await Promise.all([
    getTradingBalance(env),
    getFundingBalances(env),
    getPayBalance(env),
  ]);

  return { trading, funding, pay };
}

async function getPortfolio(env) {
  const [trading, funding, pay] = await Promise.all([
    getTradingBalance(env),
    getFundingBalances(env),
    getPayBalance(env),
  ]);

  const tradingAssets =
    trading?.details?.map((item) => ({
      account: "trading",
      asset: item.ccy,
      balance: item.cashBal,
      available: item.availBal,
      frozen: item.frozenBal,
      usdValue: item.eqUsd,
    })) ?? [];

  const fundingAssets = funding.map((item) => ({
    account: "funding",
    asset: item.ccy,
    balance: item.bal,
    available: item.availBal,
    frozen: item.frozenBal,
  }));

  return {
    asOf: Date.now(),
    accounts: {
      trading: {
        totalEqUsd: trading?.totalEq ?? null,
        assets: tradingAssets,
      },
      funding: {
        assets: fundingAssets,
      },
      pay: {
        asset: pay.asset,
        balance: pay.balance,
        chain: pay.chain,
        address: pay.address,
      },
    },
  };
}

// -------------------- Ledger / transactions --------------------

async function getTradingLedgerData(env, args = {}) {
  const data = await okxGet(env, "/api/v5/account/bills-archive", {
    instType: args.instType,
    ccy: args.ccy,
    type: args.type,
    subType: args.subType,
    after: args.after,
    before: args.before,
    begin: args.startTime ? isoToMs(args.startTime) : args.begin,
    end: args.endTime ? isoToMs(args.endTime) : args.end,
    limit: clampLimit(args.limit),
  });

  return {
    source: "trading",
    count: data.length,
    records: data.map((item) => ({
      source: "trading",
      id: item.billId,
      timestamp: item.ts,
      asset: item.ccy,
      balanceChange: item.balChg,
      balance: item.bal,
      type: item.type,
      subType: item.subType,
      instrument: item.instId || null,
      orderId: item.ordId || null,
      tradeId: item.tradeId || null,
      fee: item.fee || null,
      pnl: item.pnl || null,
    })),
    cursor: data.length ? data[data.length - 1].billId ?? null : null,
    hasMore: data.length === clampLimit(args.limit),
  };
}

async function getFundingLedgerData(env, args = {}) {
  const data = await okxGet(env, "/api/v5/asset/bills-history", {
    ccy: args.ccy,
    type: args.type,
    after: args.after,
    before: args.before,
    pagingType: args.pagingType,
    limit: clampLimit(args.limit),
  });

  return {
    source: "funding",
    count: data.length,
    records: data.map((item) => ({
      source: "funding",
      id: item.billId,
      timestamp: item.ts,
      asset: item.ccy,
      balanceChange: item.balChg,
      balance: item.bal,
      type: item.type,
      notes: item.notes || null,
      clientId: item.clientId || null,
    })),
    cursor: data.length ? data[data.length - 1].billId ?? null : null,
    hasMore: data.length === clampLimit(args.limit),
  };
}

async function getDepositsData(env, args = {}) {
  const data = await okxGet(env, "/api/v5/asset/deposit-history", {
    ccy: args.ccy,
    depId: args.depId,
    txId: args.txId,
    type: args.type,
    state: args.state,
    after: args.after,
    before: args.before,
    limit: clampLimit(args.limit),
  });

  return {
    count: data.length,
    records: data.map((item) => ({
      source: "okx_deposit",
      id: item.depId,
      timestamp: item.ts,
      asset: item.ccy,
      amount: item.amt,
      txId: item.txId || null,
      chain: item.chain || null,
      state: item.state,
      type: item.type,
      from: item.from || null,
      to: item.to || null,
    })),
    cursor: data.length ? data[data.length - 1].depId ?? null : null,
    hasMore: data.length === clampLimit(args.limit),
  };
}

async function getWithdrawalsData(env, args = {}) {
  const data = await okxGet(env, "/api/v5/asset/withdrawal-history", {
    ccy: args.ccy,
    wdId: args.wdId,
    clientId: args.clientId,
    txId: args.txId,
    type: args.type,
    state: args.state,
    after: args.after,
    before: args.before,
    limit: clampLimit(args.limit),
  });

  return {
    count: data.length,
    records: data.map((item) => ({
      source: "okx_withdrawal",
      id: item.wdId,
      timestamp: item.ts,
      asset: item.ccy,
      amount: item.amt,
      fee: item.fee,
      txId: item.txId || null,
      chain: item.chain || null,
      state: item.state,
      type: item.type,
      from: item.from || null,
      to: item.to || null,
    })),
    cursor: data.length ? data[data.length - 1].wdId ?? null : null,
    hasMore: data.length === clampLimit(args.limit),
  };
}

async function getTradesData(env, args = {}) {
  const instType = args.instType || "SPOT";

  const data = await okxGet(env, "/api/v5/trade/fills-history", {
    instType,
    instId: args.instId,
    ordId: args.ordId,
    subType: args.subType,
    after: args.after,
    before: args.before,
    begin: args.startTime ? isoToMs(args.startTime) : args.begin,
    end: args.endTime ? isoToMs(args.endTime) : args.end,
    limit: clampLimit(args.limit),
  });

  return {
    instType,
    count: data.length,
    records: data.map((item) => ({
      source: "trade",
      id: item.tradeId,
      orderId: item.ordId,
      timestamp: item.ts,
      instrument: item.instId,
      side: item.side,
      price: item.fillPx,
      size: item.fillSz,
      fee: item.fee,
      feeCurrency: item.feeCcy,
      execType: item.execType || null,
    })),
    cursor: data.length ? data[data.length - 1].tradeId ?? null : null,
    hasMore: data.length === clampLimit(args.limit),
  };
}

async function getPositionsData(env, args = {}) {
  const data = await okxGet(env, "/api/v5/account/positions", {
    instType: args.instType,
    instId: args.instId,
    posId: args.posId,
  });

  return {
    count: data.length,
    records: data,
  };
}

async function getAccountSummary(env) {
  const [portfolio, positions] = await Promise.all([
    getPortfolio(env),
    okxGet(env, "/api/v5/account/positions").catch(() => []),
  ]);

  return {
    asOf: Date.now(),
    tradingTotalEqUsd: portfolio.accounts.trading.totalEqUsd,
    tradingAssetCount: portfolio.accounts.trading.assets.length,
    fundingAssetCount: portfolio.accounts.funding.assets.length,
    pay: {
      asset: portfolio.accounts.pay.asset,
      balance: portfolio.accounts.pay.balance,
      chain: portfolio.accounts.pay.chain,
    },
    openPositionCount: positions.length,
  };
}

// -------------------- MCP --------------------

function createOkxMcpServer(env) {
  const server = new McpServer({
    name: "OKX Finance",
    version: "3.0.0",
  });

  server.registerTool(
    "get_account_summary",
    {
      description:
        "Get a compact read-only summary of the user's OKX Trading, Funding, Pay USDG, and open positions.",
      inputSchema: {},
    },
    async () => mcpText(await getAccountSummary(env))
  );

  server.registerTool(
    "get_portfolio",
    {
      description:
        "Get the user's current OKX portfolio across Trading, Funding, and OKX Pay (USDG on X Layer). Read-only.",
      inputSchema: {},
    },
    async () => mcpText(await getPortfolio(env))
  );

  server.registerTool(
    "get_balances",
    {
      description:
        "Get detailed current balances from OKX Trading, Funding, and Pay. Read-only.",
      inputSchema: {},
    },
    async () => mcpText(await getAllBalances(env))
  );

  server.registerTool(
    "get_ledger",
    {
      description:
        "Get OKX balance-changing ledger records for Trading or Funding. Use Funding for deposits, fiat funding, and transfers; use Trading for trading-account bills. Read-only.",
      inputSchema: {
        account: z.enum(["trading", "funding"]),
        ccy: z.string().optional(),
        type: z.string().optional(),
        subType: z.string().optional(),
        instType: z.string().optional(),
        startTime: z.string().optional().describe("ISO-8601 start time; Trading only"),
        endTime: z.string().optional().describe("ISO-8601 end time; Trading only"),
        after: z.string().optional().describe("OKX pagination cursor"),
        before: z.string().optional().describe("OKX pagination cursor"),
        pagingType: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => {
      const result =
        args.account === "trading"
          ? await getTradingLedgerData(env, args)
          : await getFundingLedgerData(env, args);
      return mcpText(result);
    }
  );

  server.registerTool(
    "get_deposits",
    {
      description:
        "Get the user's OKX deposit history for reconciliation with external bank or crypto transfers. Read-only.",
      inputSchema: {
        ccy: z.string().optional(),
        depId: z.string().optional(),
        txId: z.string().optional(),
        type: z.string().optional(),
        state: z.string().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => mcpText(await getDepositsData(env, args))
  );

  server.registerTool(
    "get_withdrawals",
    {
      description:
        "Get the user's OKX withdrawal history for reconciliation with external accounts. Read-only.",
      inputSchema: {
        ccy: z.string().optional(),
        wdId: z.string().optional(),
        clientId: z.string().optional(),
        txId: z.string().optional(),
        type: z.string().optional(),
        state: z.string().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => mcpText(await getWithdrawalsData(env, args))
  );

  server.registerTool(
    "get_trades",
    {
      description:
        "Get the user's executed OKX fills/trades, including side, fill price, size, fees, trade ID, and order ID. Read-only.",
      inputSchema: {
        instType: z
          .enum(["SPOT", "MARGIN", "SWAP", "FUTURES", "OPTION"])
          .optional(),
        instId: z.string().optional(),
        ordId: z.string().optional(),
        subType: z.string().optional(),
        startTime: z.string().optional().describe("ISO-8601 start time"),
        endTime: z.string().optional().describe("ISO-8601 end time"),
        after: z.string().optional(),
        before: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => mcpText(await getTradesData(env, args))
  );

  server.registerTool(
    "get_positions",
    {
      description:
        "Get the user's current OKX positions. Read-only.",
      inputSchema: {
        instType: z.string().optional(),
        instId: z.string().optional(),
        posId: z.string().optional(),
      },
    },
    async (args) => mcpText(await getPositionsData(env, args))
  );

  server.registerTool(
    "get_pay_balance",
    {
      description:
        "Get the user's OKX Pay USDG balance directly from the confirmed X Layer wallet address. Read-only.",
      inputSchema: {},
    },
    async () => mcpText(await getPayBalance(env))
  );

  return server;
}

// -------------------- REST compatibility routes --------------------

async function handleRest(request, env, url) {
  switch (url.pathname) {
    case "/portfolio":
      return json({ ok: true, data: await getPortfolio(env) });

    case "/balances":
      return json({ ok: true, data: await getAllBalances(env) });

    case "/pay/balance":
      return json({ ok: true, data: await getPayBalance(env) });

    case "/ledger/trading":
      return json({
        ok: true,
        data: await getTradingLedgerData(env, Object.fromEntries(url.searchParams)),
      });

    case "/ledger/funding":
      return json({
        ok: true,
        data: await getFundingLedgerData(env, Object.fromEntries(url.searchParams)),
      });

    case "/deposits":
      return json({
        ok: true,
        data: await getDepositsData(env, Object.fromEntries(url.searchParams)),
      });

    case "/withdrawals":
      return json({
        ok: true,
        data: await getWithdrawalsData(env, Object.fromEntries(url.searchParams)),
      });

    case "/trades":
      return json({
        ok: true,
        data: await getTradesData(env, Object.fromEntries(url.searchParams)),
      });

    case "/positions":
      return json({
        ok: true,
        data: await getPositionsData(env, Object.fromEntries(url.searchParams)),
      });

    case "/account-summary":
      return json({ ok: true, data: await getAccountSummary(env) });

    default:
      return json({ ok: false, error: "Not Found" }, 404);
  }
}

// -------------------- Worker entry --------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "okx-finance",
        version: "3.0.0",
        mcp: "/mcp",
        timestamp: Date.now(),
      });
    }

    // All financial data, including MCP, is private.
    if (!isAuthorized(request, env)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/mcp") {
        const handler = createMcpHandler(() => createOkxMcpServer(env));
        return handler(request, env, ctx);
      }

      if (request.method !== "GET") {
        return json({ ok: false, error: "Method Not Allowed" }, 405);
      }

      return await handleRest(request, env, url);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
