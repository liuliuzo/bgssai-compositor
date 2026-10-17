import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import storage from "../electron/storage.cjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const terminal = new Set(["settled", "unpaid", "unpriced", "reversed"]);
export const complete = (value) => terminal.has(value?.billing_status) &&
  Number.isSafeInteger(value?.billed_tokens) && value.billed_tokens >= 0;
const fields = ["raw_tokens", "billed_tokens", "billing_multiplier", "billing_unit",
  "price_version", "currency", "billing_status", "debit_fen", "quoted_debit_fen", "reservation_status"];
export const modelFields = ["billing_multiplier", "billing_unit", "price_version", "pricing_status",
  "currency", "input_fen_per_million", "output_fen_per_million", "cached_read_fen_per_million",
  "price_unit", "image_fen_per_unit", "audio_fen_per_second", "video_fen_per_second"];

// Publish only a fully flushed file. A hard link is atomic and cannot replace an
// existing name; neither partial records nor stale pending writes win this gate.
async function publish(target, value) {
  const temp = `${target}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
  try {
    await link(temp, target);
    // Directory fsync is unavailable on Windows; file sync is still required.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temp).catch(() => {}); }
}
async function read(target) {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export class HubReceipts {
  constructor(directory, config, transport) {
    this.directory = path.join(directory, "usage");
    this.config = config;
    this.transport = transport;
  }
  owner(issuer, sub) { return hash(`${issuer}\0${sub}`); }
  canRefresh(record) {
    if (!this.config.hubKey || hash(this.config.hubKey) !== record.key_fingerprint) return false;
    const candidates = [this.config.hubOrigin, this.config.hubCnOrigin, this.config.hubGlobalOrigin,
      ...Object.values(this.config.hubOrigins ?? {}), ...(this.config.allowedHubOrigins ?? [])];
    return candidates.some((value) => {
      if (typeof value !== "string" || !value.trim()) return false;
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" &&
          !url.search && !url.hash && url.origin === record.hub;
      } catch { return false; }
    });
  }
  target(record, suffix = "json") {
    if (!/^[a-f0-9]{64}$/.test(record.owner) ||
        !/^[a-f0-9-]{36}$/.test(record.request_id)) throw new Error("Invalid receipt path");
    return path.join(this.directory, record.owner, `${record.request_id}.${suffix}`);
  }
  async begin(owner, requestId, origin, model, prompt) {
    const record = { owner, request_id: requestId, hub: origin, model,
      key_fingerprint: hash(this.config.hubKey), prompt_fingerprint: hash(prompt), created_at: Date.now() };
    await mkdir(path.join(this.directory, owner), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.directory, "claims"), { recursive: true, mode: 0o700 });
    try {
      // The Hub key is shared across users: a request ID must be globally unique,
      // not merely unique within one user's directory. A stranded claim fails closed.
      await publish(path.join(this.directory, "claims", `${requestId}.json`), { owner });
      await publish(this.target(record), record);
    }
    catch (error) {
      if (error.code === "EEXIST") throw Object.assign(new Error("请求已记录，请查看用量；不会重复生成"), { status: 409 });
      throw error;
    }
    return record;
  }
  async view(record) {
    const state = await read(this.target(record, "settled.json")) ??
      await read(this.target(record, "pending.json"));
    const billing = Object.fromEntries(fields.map((key) => [key, state?.billing?.[key] ?? null]));
    billing.billing_status ??= "pending";
    return { hub: record.hub, request_id: record.request_id, model: record.model,
      created_at: record.created_at, ...billing, reconciled: complete(billing) };
  }
  async refresh(record) {
    if (await read(this.target(record, "settled.json"))) return this.view(record);
    if (!this.canRefresh(record)) return this.view(record);
    let billing = null;
    try {
      const response = await this.transport(`${record.hub}/v1/usage/${record.request_id}`, {
        headers: { Authorization: `Bearer ${this.config.hubKey}` }, redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Receipt not available");
      const value = await response.json();
      if (value.request_id !== record.request_id) throw new Error("Receipt mismatch");
      billing = Object.fromEntries(fields.map((key) => [key, value[key] ?? null]));
      const state = { billing, next_poll: Date.now() + 60000 };
      if (complete(billing)) {
        try { await publish(this.target(record, "settled.json"), state); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } else await storage.atomicWrite(this.target(record, "pending.json"), JSON.stringify(state));
    } catch {
      // An error must not erase an already observed actual quota/cash value.
      const prior = await read(this.target(record, "pending.json"));
      await storage.atomicWrite(this.target(record, "pending.json"), JSON.stringify({
        billing: prior?.billing ?? billing, next_poll: Date.now() + 300000,
      }));
    }
    return this.view(record);
  }
  async records(owner) {
    let names;
    try { names = await readdir(path.join(this.directory, owner)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const name of names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try {
        const record = await read(path.join(this.directory, owner, name));
        if (record?.owner === owner && this.target(record) === path.join(this.directory, owner, name)) result.push(record);
      } catch { /* Corrupt record is never a reason to replay generation. */ }
    }
    return result;
  }
  async list(owner) {
    const records = (await this.records(owner)).sort((a, b) => b.created_at - a.created_at).slice(0, 100);
    return Promise.all(records.map((record) => this.view(record)));
  }
  async recover() {
    if (this.recovering) return this.recovering;
    this.recovering = this.recoverBatch().finally(() => { this.recovering = null; });
    return this.recovering;
  }
  async recoverBatch() {
    let owners;
    try { owners = await readdir(this.directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    let count = 0;
    for (const owner of owners.filter((value) => /^[a-f0-9]{64}$/.test(value))) {
      for (const record of await this.records(owner)) {
        if (await read(this.target(record, "settled.json"))) continue;
        const pending = await read(this.target(record, "pending.json"));
        if (pending?.next_poll > Date.now()) continue;
        if (!this.canRefresh(record)) continue;
        await this.refresh(record);
        if (++count >= 50) return;
      }
    }
  }
}
