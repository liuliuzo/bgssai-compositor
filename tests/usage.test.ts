import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
// @ts-ignore Type-free service module.
import { HubReceipts, complete } from "../service/hub-receipts.mjs";
import { priceLabel, usageLabel } from "../src/usage.ts";

const config = { hubOrigin: "https://hub.example", hubKey: "original-key" };
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-usage-"));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("compositor-usage-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test("durable begin is exclusive; restart uses the original key and only GETs owner-isolated receipts", async () => fixture(async (directory) => {
  let gets = 0;
  const transport = async (url: string, options: any) => {
    gets++;
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, "Bearer original-key");
    return Response.json({ request_id: url.split("/").at(-1), raw_tokens: 10, billed_tokens: 15,
      billing_multiplier: 1.5, billing_unit: "token", billing_status: "settled", debit_fen: 3, currency: "USD" });
  };
  const store = new HubReceipts(directory, config, transport);
  const owner = store.owner("https://chat.example", "one");
  const id = randomUUID();
  const attempts = await Promise.allSettled([store.begin(owner, id, config.hubOrigin, "model", "private"),
    store.begin(owner, id, config.hubOrigin, "model", "private")]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.status, 409);
  assert.equal(gets, 0);
  await assert.rejects(store.begin(store.owner("https://chat.example", "attacker"), id, config.hubOrigin, "model", "other"), { status: 409 });
  const disk = await fs.readFile(path.join(directory, "usage", owner, `${id}.json`), "utf8");
  assert.ok(!disk.includes("original-key") && !disk.includes('"private"'));
  await new HubReceipts(directory, { ...config, hubKey: "changed-key" }, transport).recover();
  assert.equal(gets, 0);
  const restarted = new HubReceipts(directory, config, transport);
  await restarted.recover();
  const receipt = (await restarted.list(owner))[0];
  assert.equal(receipt.billed_tokens, 15); // Already multiplied; never 22.5.
  assert.equal(receipt.currency, "USD");
  assert.equal(receipt.debit_fen, 3);
  assert.equal(receipt.reconciled, true);
  assert.deepEqual(await restarted.list(store.owner("https://chat.example", "other")), []);
  await restarted.recover();
  assert.equal(gets, 1);
}));

test("both quota and cash are required; a stale pending GET cannot overwrite a final receipt", async () => fixture(async (directory) => {
  const id = randomUUID();
  let value: any = { request_id: id, billing_status: "settled", billed_tokens: null };
  const store = new HubReceipts(directory, config, async () => Response.json(value));
  const record = await store.begin(store.owner("issuer", "user"), id, config.hubOrigin, "model", "prompt");
  assert.equal((await store.refresh(record)).reconciled, false);
  value = { request_id: id, billing_status: "pending", billed_tokens: 7 };
  assert.equal((await store.refresh(record)).reconciled, false);
  let release!: () => void;
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new HubReceipts(directory, config, async () => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ request_id: id, billing_status: "pending", billed_tokens: null });
  });
  const pending = delayed.refresh(record);
  await called;
  value = { request_id: id, billing_status: "unpriced", billed_tokens: 7, debit_fen: null };
  assert.equal((await store.refresh(record)).reconciled, true);
  release();
  assert.equal((await pending).billing_status, "unpriced");
  assert.equal((await new HubReceipts(directory, config, () => {}).list(record.owner))[0].billed_tokens, 7);
  assert.equal(complete({ billing_status: "settled", billed_tokens: "7" }), false);
}));

test("404 or a mismatched receipt remains pending and endpoint rotation does not send credentials", async () => fixture(async (directory) => {
  let calls = 0;
  const store = new HubReceipts(directory, config, async () => { calls++; return new Response("", { status: 404 }); });
  const record = await store.begin(store.owner("issuer", "user"), randomUUID(), config.hubOrigin, "model", "prompt");
  assert.equal((await store.refresh(record)).billed_tokens, null);
  const wrong = new HubReceipts(directory, config, async () => Response.json({ request_id: randomUUID(), billing_status: "settled", billed_tokens: 999 }));
  assert.equal((await wrong.refresh(record)).reconciled, false);
  await new HubReceipts(directory, { ...config, hubOrigin: "https://other.example" }, async () => { calls++; }).refresh(record);
  assert.equal(calls, 1);
}));

test("UI keeps unknown pricing and pending cash distinct from actual zero or fractional multipliers", () => {
  assert.match(priceLabel({ id: "m", hub: "h", billing_multiplier: 0.5, billing_unit: "token", price_version: 7 }), /0.5×.*价格版本 7/);
  assert.match(priceLabel({ id: "m", hub: "h" }), /倍率待配置/);
  assert.match(usageLabel({ id: "m", hub: "h", model: "m", request_id: "id", billing_status: "pending", reconciled: false, billed_tokens: 0 }), /实扣 0 token.*现金 待确认.*待对账/);
});
