import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** OTP lifecycle for email/phone login. Codes never returned in API responses. */
export function createOtpService(dataDirectory, config = {}) {
  const challengesDir = path.join(dataDirectory, "otp-challenges");
  const outboxDir = path.join(dataDirectory, "otp-outbox");
  const auditDir = path.join(dataDirectory, "otp-audit");
  const rates = new Map();
  const ttlMs = Number(config.otpTtlMs ?? 300_000);
  const maxSendPerTarget = Number(config.otpMaxSendPerHour ?? 5);

  /** file | none — real SMS/email adapters require credentials; without them send is 503. */
  const delivery = String(config.otpDelivery ?? process.env.COMPOSITOR_OTP_DELIVERY ?? "none");

  async function ensure() {
    await mkdir(challengesDir, { recursive: true, mode: 0o700 });
    await mkdir(outboxDir, { recursive: true, mode: 0o700 });
    await mkdir(auditDir, { recursive: true, mode: 0o700 });
  }

  async function audit(event) {
    await ensure();
    const id = `otp_${randomBytes(8).toString("hex")}`;
    await writeFile(
      path.join(auditDir, `${id}.json`),
      JSON.stringify({ ...event, id, at: Date.now() }),
      { mode: 0o600, flush: true },
    );
  }

  function normalizeTarget(channel, raw) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (channel === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 160) {
        throw fail(400, "邮箱地址无效");
      }
      return value;
    }
    if (channel === "phone") {
      const phone = value.replace(/[\s-]/g, "");
      if (!/^\+?\d{8,20}$/.test(phone)) throw fail(400, "手机号无效");
      return phone;
    }
    throw fail(400, "验证码渠道无效");
  }

  function rateKey(target) {
    return `send:${target}`;
  }

  function checkRate(target) {
    const now = Date.now();
    const key = rateKey(target);
    const bucket = rates.get(key) ?? [];
    const recent = bucket.filter((t) => now - t < 3_600_000);
    if (recent.length >= maxSendPerTarget) {
      throw fail(429, "验证码请求过于频繁，请稍后重试");
    }
    recent.push(now);
    rates.set(key, recent);
  }

  async function deliver(channel, target, code, challengeId, purpose) {
    if (delivery === "file") {
      await ensure();
      // Outbox is server-side only for tests/dev; never expose via API.
      await writeFile(
        path.join(outboxDir, `${challengeId}.json`),
        JSON.stringify({ channel, target, purpose, code, created_at: Date.now() }),
        { mode: 0o600, flush: true },
      );
      return { delivered: true, adapter: "file" };
    }
    if (delivery === "none") {
      throw fail(
        503,
        channel === "phone"
          ? "手机验证码真实短信通道尚未配置，暂未启用"
          : "邮箱验证码真实邮件通道尚未配置，暂未启用",
      );
    }
    throw fail(503, "验证码投递适配器未就绪");
  }

  async function send({ channel, target: rawTarget, purpose = "login" }) {
    const target = normalizeTarget(channel, rawTarget);
    const cleanPurpose = String(purpose || "login").slice(0, 40);
    checkRate(target);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const challengeId = randomBytes(16).toString("hex");
    const record = {
      challenge_id: challengeId,
      channel,
      target,
      purpose: cleanPurpose,
      code_hash: hash(code),
      expires_at: Date.now() + ttlMs,
      consumed_at: null,
      created_at: Date.now(),
    };
    await ensure();
    await writeFile(path.join(challengesDir, `${challengeId}.json`), JSON.stringify(record), {
      mode: 0o600,
      flush: true,
    });
    await deliver(channel, target, code, challengeId, cleanPurpose);
    await audit({
      type: "send",
      channel,
      target,
      purpose: cleanPurpose,
      challenge_id: challengeId,
    });
    return {
      ok: true,
      challenge_id: challengeId,
      channel,
      target_masked:
        channel === "email"
          ? target.replace(/(.{2}).+(@.+)/, "$1***$2")
          : target.replace(/(\d{3})\d+(\d{4})$/, "$1****$2"),
      expires_in: Math.floor(ttlMs / 1000),
      purpose: cleanPurpose,
    };
  }

  async function verify({
    challenge_id,
    code,
    channel,
    target: rawTarget,
    purpose = "login",
  }) {
    const target = normalizeTarget(channel, rawTarget);
    const cleanPurpose = String(purpose || "login").slice(0, 40);
    if (!challenge_id || typeof challenge_id !== "string" || challenge_id.length > 64) {
      throw fail(400, "验证码挑战无效");
    }
    const entered = String(code ?? "").trim();
    if (!/^\d{6}$/.test(entered)) throw fail(401, "验证码无效");
    let record;
    try {
      record = JSON.parse(
        await readFile(path.join(challengesDir, `${challenge_id}.json`), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") throw fail(401, "验证码无效或已过期");
      throw fail(503, "验证码存储暂不可用");
    }
    if (
      record.channel !== channel ||
      record.target !== target ||
      record.purpose !== cleanPurpose
    ) {
      await audit({ type: "verify_mismatch", challenge_id, channel, target });
      throw fail(401, "验证码与接收人或用途不匹配");
    }
    if (record.consumed_at) {
      await audit({ type: "verify_reuse", challenge_id });
      throw fail(401, "验证码已使用");
    }
    if (record.expires_at <= Date.now()) {
      await audit({ type: "verify_expired", challenge_id });
      throw fail(401, "验证码已过期");
    }
    const candidate = Buffer.from(hash(entered), "hex");
    const expected = Buffer.from(record.code_hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      await audit({ type: "verify_bad_code", challenge_id });
      throw fail(401, "验证码无效");
    }
    record.consumed_at = Date.now();
    await writeFile(path.join(challengesDir, `${challenge_id}.json`), JSON.stringify(record), {
      mode: 0o600,
      flush: true,
    });
    await audit({ type: "verify_ok", challenge_id, channel, target, purpose: cleanPurpose });
    try {
      await unlink(path.join(outboxDir, `${challenge_id}.json`));
    } catch {
      /* ignore */
    }
    return { ok: true, channel, target, purpose: cleanPurpose, challenge_id };
  }

  return { send, verify, delivery };
}
