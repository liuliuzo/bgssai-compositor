import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

const DEFAULT_PACKAGES = [
  {
    package_id: "comp_starter_100m",
    name: "入门套餐",
    kind: "subscription",
    tokens: 100_000_000,
    duration_days: 30,
    price_fen: 990,
    currency: "CNY",
    region: "cn",
  },
  {
    package_id: "comp_pro_500m",
    name: "专业套餐",
    kind: "subscription",
    tokens: 500_000_000,
    duration_days: 30,
    price_fen: 3990,
    currency: "CNY",
    region: "cn",
  },
  {
    package_id: "comp_topup_50m",
    name: "加量包 50M",
    kind: "topup",
    tokens: 50_000_000,
    duration_days: 0,
    price_fen: 490,
    currency: "CNY",
    region: "cn",
  },
];

export function createBillingStore(dataDirectory, config = {}) {
  const root = path.join(dataDirectory, "billing");
  const packages = Array.isArray(config.packages) ? config.packages : DEFAULT_PACKAGES;
  const paymentSecret =
    config.paymentCallbackSecret ?? process.env.COMPOSITOR_PAYMENT_CALLBACK_SECRET ?? "";

  async function ensure() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, "orders"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, "ledgers"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(root, "callbacks"), { recursive: true, mode: 0o700 });
  }

  function ledgerPath(accountId) {
    return path.join(root, "ledgers", `${hash(accountId)}.json`);
  }

  function orderPath(outTradeNo) {
    return path.join(root, "orders", `${hash(outTradeNo)}.json`);
  }

  async function readLedger(accountId) {
    await ensure();
    try {
      return JSON.parse(await readFile(ledgerPath(accountId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          account_id: accountId,
          package_id: null,
          package_name: "未开通",
          remaining_tokens: 0,
          expires_at: null,
          updated_at: Date.now(),
          entries: [],
        };
      }
      throw fail(503, "额度账本暂不可用");
    }
  }

  async function writeLedger(ledger) {
    await ensure();
    await writeFile(ledgerPath(ledger.account_id), JSON.stringify(ledger), {
      mode: 0o600,
      flush: true,
    });
  }

  function listPackages() {
    return packages.map((item) => ({ ...item }));
  }

  async function getBalance(accountId) {
    const ledger = await readLedger(accountId);
    return {
      account_id: accountId,
      package_id: ledger.package_id,
      package_name: ledger.package_name,
      remaining_tokens: ledger.remaining_tokens,
      expires_at: ledger.expires_at,
      updated_at: ledger.updated_at,
      unit: "token",
    };
  }

  async function listEntries(accountId) {
    const ledger = await readLedger(accountId);
    return ledger.entries.slice().reverse();
  }

  async function createOrder(accountId, packageId, channel = "mock") {
    const pkg = packages.find((item) => item.package_id === packageId);
    if (!pkg) throw fail(404, "套餐不存在");
    const outTradeNo = `comp_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const order = {
      out_trade_no: outTradeNo,
      account_id: accountId,
      package_id: pkg.package_id,
      package_name: pkg.name,
      kind: pkg.kind,
      tokens: pkg.tokens,
      duration_days: pkg.duration_days,
      amount_fen: pkg.price_fen,
      currency: pkg.currency,
      channel,
      status: "pending",
      created_at: Date.now(),
      paid_at: null,
      credited_at: null,
    };
    await ensure();
    try {
      await writeFile(orderPath(outTradeNo), JSON.stringify(order), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    } catch (error) {
      if (error.code === "EEXIST") throw fail(409, "订单号冲突");
      throw fail(503, "订单存储暂不可用");
    }
    return order;
  }

  async function creditOrder(order, { source }) {
    const ledger = await readLedger(order.account_id);
    const now = Date.now();
    let expiresAt = ledger.expires_at;
    if (order.kind === "subscription" && order.duration_days > 0) {
      const base = expiresAt && expiresAt > now ? expiresAt : now;
      expiresAt = base + order.duration_days * 86_400_000;
      ledger.package_id = order.package_id;
      ledger.package_name = order.package_name;
    } else if (!ledger.package_id) {
      ledger.package_id = order.package_id;
      ledger.package_name = order.package_name;
    }
    ledger.remaining_tokens = Number(ledger.remaining_tokens || 0) + Number(order.tokens);
    ledger.expires_at = expiresAt;
    ledger.updated_at = now;
    ledger.entries.push({
      entry_id: `le_${randomBytes(8).toString("hex")}`,
      type: order.kind === "topup" ? "topup" : "purchase",
      tokens: order.tokens,
      balance_after: ledger.remaining_tokens,
      out_trade_no: order.out_trade_no,
      package_id: order.package_id,
      source,
      created_at: now,
    });
    await writeLedger(ledger);
    order.status = "credited";
    order.credited_at = now;
    await writeFile(orderPath(order.out_trade_no), JSON.stringify(order), {
      mode: 0o600,
      flush: true,
    });
    return { order, ledger };
  }

  async function handlePaymentCallback(payload) {
    const outTradeNo = String(payload.out_trade_no ?? payload.order_id ?? "").trim();
    if (!outTradeNo) throw fail(400, "缺少 out_trade_no");
    const status = String(payload.status ?? payload.trade_status ?? "").toLowerCase();
    if (!["success", "paid", "trade_success"].includes(status)) {
      return { ok: true, credited: false, reason: "not_paid" };
    }
    if (paymentSecret) {
      const provided = String(payload.signature ?? payload.sign ?? "");
      const expected = createHash("sha256")
        .update(`${outTradeNo}:${status}:${paymentSecret}`)
        .digest("hex");
      if (provided !== expected) throw fail(401, "支付回调签名无效");
    } else if (process.env.APP_ENV === "prod") {
      throw fail(503, "支付回调密钥未配置");
    }

    await ensure();
    const callbackKey = hash(outTradeNo);
    const callbackFile = path.join(root, "callbacks", `${callbackKey}.json`);
    try {
      await writeFile(
        callbackFile,
        JSON.stringify({ out_trade_no: outTradeNo, received_at: Date.now(), payload }),
        { flag: "wx", mode: 0o600, flush: true },
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        let order;
        try {
          order = JSON.parse(await readFile(orderPath(outTradeNo), "utf8"));
        } catch {
          order = null;
        }
        return {
          ok: true,
          credited: false,
          idempotent_replay: true,
          out_trade_no: outTradeNo,
          status: order?.status ?? "credited",
          remaining_tokens: order ? (await readLedger(order.account_id)).remaining_tokens : null,
        };
      }
      throw fail(503, "支付回调存储暂不可用");
    }

    let order;
    try {
      order = JSON.parse(await readFile(orderPath(outTradeNo), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw fail(404, "订单不存在");
      throw fail(503, "订单存储暂不可用");
    }
    if (order.status === "credited") {
      return {
        ok: true,
        credited: false,
        idempotent_replay: true,
        out_trade_no: outTradeNo,
        status: order.status,
        remaining_tokens: (await readLedger(order.account_id)).remaining_tokens,
      };
    }
    order.status = "paid";
    order.paid_at = Date.now();
    await writeFile(orderPath(outTradeNo), JSON.stringify(order), {
      mode: 0o600,
      flush: true,
    });
    const { ledger } = await creditOrder(order, { source: "payment_callback" });
    return {
      ok: true,
      credited: true,
      idempotent_replay: false,
      out_trade_no: outTradeNo,
      remaining_tokens: ledger.remaining_tokens,
      expires_at: ledger.expires_at,
    };
  }

  async function consumeTokens(accountId, tokens, meta = {}) {
    const amount = Number(tokens);
    if (!Number.isFinite(amount) || amount <= 0) throw fail(400, "扣减数量无效");
    const ledger = await readLedger(accountId);
    if (ledger.expires_at && ledger.expires_at < Date.now()) {
      throw fail(402, "套餐已到期，请续费后再试");
    }
    if (ledger.remaining_tokens < amount) throw fail(402, "额度不足");
    ledger.remaining_tokens -= amount;
    ledger.updated_at = Date.now();
    ledger.entries.push({
      entry_id: `le_${randomBytes(8).toString("hex")}`,
      type: "consume",
      tokens: -amount,
      balance_after: ledger.remaining_tokens,
      request_id: meta.request_id ?? null,
      model: meta.model ?? null,
      created_at: Date.now(),
    });
    await writeLedger(ledger);
    return ledger;
  }

  async function openItems(accountId) {
    await ensure();
    const files = await readdir(path.join(root, "orders")).catch(() => []);
    const pending = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const order = JSON.parse(await readFile(path.join(root, "orders", file), "utf8"));
        if (order.account_id === accountId && order.status === "pending") pending.push(order);
      } catch {
        /* skip */
      }
    }
    return pending;
  }

  return {
    listPackages,
    getBalance,
    listEntries,
    createOrder,
    handlePaymentCallback,
    consumeTokens,
    openItems,
    paymentSecretConfigured: Boolean(paymentSecret),
  };
}
