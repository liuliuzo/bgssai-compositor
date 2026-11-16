import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSmtpReady, maskEmail, sendSmtpEmail } from "./mailer.mjs";
import {
  isDomesticSmsReady,
  isIntlSmsReady,
  maskPhone,
  routePhone,
  sendTencentSms,
} from "./sms.mjs";

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** OTP lifecycle for email/phone login. Codes never returned in API responses. */
export function createOtpService(dataDirectory, config = {}, transport = fetch) {
  const challengesDir = path.join(dataDirectory, "otp-challenges");
  const outboxDir = path.join(dataDirectory, "otp-outbox");
  const auditDir = path.join(dataDirectory, "otp-audit");
  const ratesDir = path.join(dataDirectory, "otp-rate");
  const rates = new Map();
  const maxSendPerTarget = Number(config.otpMaxSendPerHour ?? 5);
  const cooldownMs = Number(config.otpCooldownMs ?? 60_000);
  const maxVerifyAttempts = Number(config.otpMaxVerifyAttempts ?? 5);
  const channelConfig = config.channelConfig ?? null;
  const nowFn = typeof config.now === "function" ? config.now : () => Date.now();

  /** file | auto | live | none */
  const delivery = String(
    config.otpDelivery ?? process.env.COMPOSITOR_OTP_DELIVERY ?? "none",
  )
    .trim()
    .toLowerCase();

  function getTtlMs(channel) {
    if (config.otpTtlMs !== undefined && config.otpTtlMs !== null) {
      return Number(config.otpTtlMs);
    }
    if (channel === "phone" && channelConfig) {
      const sec = Number(channelConfig.getSms()?.code_expire_seconds ?? 300);
      if (Number.isFinite(sec) && sec >= 60) return sec * 1000;
    }
    return 300_000;
  }

  function isEmailAvailable() {
    if (delivery === "file") return true;
    return Boolean(channelConfig && isSmtpReady(channelConfig.getSmtp()));
  }

  function isDomesticPhoneAvailable() {
    if (delivery === "file") return true;
    return Boolean(channelConfig && isDomesticSmsReady(channelConfig.getSms()));
  }

  function isIntlPhoneAvailable() {
    if (delivery === "file") return true;
    return Boolean(channelConfig && isIntlSmsReady(channelConfig.getSms()));
  }

  function isPhoneAvailable(rawTarget) {
    if (delivery === "file") return true;
    if (!channelConfig) return false;
    if (rawTarget === undefined || rawTarget === null || rawTarget === "") {
      return isDomesticPhoneAvailable() || isIntlPhoneAvailable();
    }
    const routed = routePhone(rawTarget);
    if (!routed) return false;
    const sms = channelConfig.getSms();
    return routed.route === "MAINLAND"
      ? isDomesticSmsReady(sms)
      : isIntlSmsReady(sms);
  }

  function isAnyChannelAvailable() {
    return (
      isEmailAvailable() || isDomesticPhoneAvailable() || isIntlPhoneAvailable()
    );
  }

  function isChannelReady(channel, rawTarget) {
    if (channel === "email") return isEmailAvailable();
    if (channel === "phone") return isPhoneAvailable(rawTarget);
    return false;
  }

  async function ensure() {
    await mkdir(challengesDir, { recursive: true, mode: 0o700 });
    await mkdir(outboxDir, { recursive: true, mode: 0o700 });
    await mkdir(auditDir, { recursive: true, mode: 0o700 });
    await mkdir(ratesDir, { recursive: true, mode: 0o700 });
  }

  async function audit(event) {
    await ensure();
    const id = `otp_${randomBytes(8).toString("hex")}`;
    await writeFile(
      path.join(auditDir, `${id}.json`),
      JSON.stringify({ ...event, id, at: nowFn() }),
      { mode: 0o600, flush: true },
    );
  }

  function normalizeTarget(channel, raw) {
    if (channel === "email") {
      const value = String(raw ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 160) {
        throw fail(400, "邮箱地址无效", "INVALID_EMAIL");
      }
      return { storage: value, deliveryTarget: value, route: "EMAIL" };
    }
    if (channel === "phone") {
      const routed = routePhone(raw);
      if (!routed) {
        throw fail(400, "手机号无效", "INVALID_PHONE");
      }
      return {
        storage: routed.storage,
        deliveryTarget: routed.e164,
        route: routed.route,
      };
    }
    throw fail(400, "验证码渠道无效", "INVALID_CHANNEL");
  }

  function rateKey(channel, target) {
    return `${channel}:${target}`;
  }

  async function loadRecentTimestamps(key) {
    const now = nowFn();
    let bucket = rates.get(key);
    if (!bucket) {
      try {
        const persisted = JSON.parse(
          await readFile(path.join(ratesDir, `${hash(key)}.json`), "utf8"),
        );
        if (Array.isArray(persisted)) bucket = persisted;
      } catch {
        bucket = [];
      }
    }
    const recent = (bucket ?? []).filter(
      (t) => Number.isFinite(t) && now - t < 3_600_000,
    );
    rates.set(key, recent);
    return recent;
  }

  async function saveTimestamps(key, recent) {
    rates.set(key, recent);
    await ensure();
    await writeFile(
      path.join(ratesDir, `${hash(key)}.json`),
      JSON.stringify(recent),
      { mode: 0o600, flush: true },
    );
  }

  async function checkRate(channel, target) {
    const now = nowFn();
    const key = rateKey(channel, target);
    const recent = await loadRecentTimestamps(key);
    const lastSentAt = recent.length > 0 ? recent[recent.length - 1] : 0;
    if (cooldownMs > 0 && lastSentAt > 0 && now - lastSentAt < cooldownMs) {
      const waitSec = Math.max(1, Math.ceil((cooldownMs - (now - lastSentAt)) / 1000));
      throw fail(
        429,
        `验证码请求过于频繁，请 ${waitSec} 秒后重试`,
        "OTP_RESEND_TOO_SOON",
      );
    }
    if (recent.length >= maxSendPerTarget) {
      throw fail(429, "验证码请求过于频繁，请稍后重试", "OTP_RATE_LIMITED");
    }
    return { key, recent, now };
  }

  async function deliver(channel, targetInfo, code, challengeId, purpose, ttlMs) {
    if (delivery === "file") {
      await ensure();
      // Outbox is server-side only for tests/dev; never expose via API.
      await writeFile(
        path.join(outboxDir, `${challengeId}.json`),
        JSON.stringify({
          channel,
          target: targetInfo.storage,
          delivery_target: targetInfo.deliveryTarget,
          route: targetInfo.route,
          purpose,
          code,
          created_at: nowFn(),
        }),
        { mode: 0o600, flush: true },
      );
      return { delivered: true, adapter: "file" };
    }
    if (channel === "email") {
      if (!channelConfig) {
        throw fail(
          503,
          "邮箱验证码真实邮件通道尚未配置，暂未启用",
          "EMAIL_UNCONFIGURED",
        );
      }
      return sendSmtpEmail({
        to: targetInfo.deliveryTarget,
        code,
        expireMinutes: Math.max(1, Math.ceil(ttlMs / 60_000)),
        smtpConfig: channelConfig.getSmtp(),
        createTransport: config.createMailTransport,
      });
    }
    if (channel === "phone") {
      if (!channelConfig) {
        throw fail(
          503,
          "手机验证码真实短信通道尚未配置，暂未启用",
          "SMS_UNCONFIGURED",
        );
      }
      return sendTencentSms({
        phone: targetInfo.deliveryTarget,
        code,
        expireMinutes: Math.max(1, Math.ceil(ttlMs / 60_000)),
        smsConfig: channelConfig.getSms(),
        transport,
        seq: config.nextSmsSeq?.(),
      });
    }
    throw fail(503, "验证码投递适配器未就绪", "OTP_DELIVERY_UNAVAILABLE");
  }

  async function send({ channel, target: rawTarget, purpose = "login" }) {
    const cleanChannel = String(channel ?? "").trim().toLowerCase();
    const targetInfo = normalizeTarget(cleanChannel, rawTarget);
    if (!isChannelReady(cleanChannel, targetInfo.deliveryTarget)) {
      throw fail(
        503,
        cleanChannel === "phone"
          ? targetInfo.route === "INTERNATIONAL"
            ? "国际/港澳台短信通道尚未配置或未开启，暂未启用"
            : "手机验证码真实短信通道尚未配置，暂未启用"
          : "邮箱验证码真实邮件通道尚未配置，暂未启用",
        cleanChannel === "phone"
          ? targetInfo.route === "INTERNATIONAL"
            ? "SMS_INTL_UNCONFIGURED"
            : "SMS_DOMESTIC_UNCONFIGURED"
          : "EMAIL_UNCONFIGURED",
      );
    }

    const cleanPurpose = String(purpose || "login").slice(0, 40);
    const rateState = await checkRate(cleanChannel, targetInfo.storage);
    const ttlMs = getTtlMs(cleanChannel);
    const code = String(randomInt(100000, 1000000));
    const challengeId = randomBytes(16).toString("hex");
    const challengePath = path.join(challengesDir, `${challengeId}.json`);
    const createdAt = nowFn();
    const record = {
      challenge_id: challengeId,
      channel: cleanChannel,
      target: targetInfo.storage,
      route: targetInfo.route,
      purpose: cleanPurpose,
      code_hash: hash(code),
      attempts: 0,
      expires_at: createdAt + ttlMs,
      consumed_at: null,
      created_at: createdAt,
    };
    await ensure();
    await writeFile(challengePath, JSON.stringify(record), {
      mode: 0o600,
      flush: true,
    });
    try {
      await deliver(
        cleanChannel,
        targetInfo,
        code,
        challengeId,
        cleanPurpose,
        ttlMs,
      );
    } catch (error) {
      await unlink(challengePath).catch(() => {});
      throw error;
    }

    await saveTimestamps(rateState.key, [...rateState.recent, nowFn()]);
    await audit({
      type: "send",
      channel: cleanChannel,
      route: targetInfo.route,
      target_masked:
        cleanChannel === "email"
          ? maskEmail(targetInfo.storage)
          : maskPhone(targetInfo.deliveryTarget),
      purpose: cleanPurpose,
      challenge_id: challengeId,
    });
    return {
      ok: true,
      challenge_id: challengeId,
      channel: cleanChannel,
      ...(cleanChannel === "phone" ? { route: targetInfo.route } : {}),
      target_masked:
        cleanChannel === "email"
          ? maskEmail(targetInfo.storage)
          : maskPhone(targetInfo.deliveryTarget),
      expires_in: Math.floor(ttlMs / 1000),
      cooldown_seconds: Math.max(0, Math.floor(cooldownMs / 1000)),
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
    const cleanChannel = String(channel ?? "").trim().toLowerCase();
    if (!["email", "phone"].includes(cleanChannel)) {
      if (!isAnyChannelAvailable()) {
        throw fail(
          503,
          "手机/邮箱验证码真实发送与核验服务尚未配置，暂未启用",
          "OTP_UNCONFIGURED",
        );
      }
      throw fail(400, "验证码渠道无效", "INVALID_CHANNEL");
    }
    if (delivery !== "file" && !isAnyChannelAvailable()) {
      throw fail(
        503,
        "手机/邮箱验证码真实发送与核验服务尚未配置，暂未启用",
        "OTP_UNCONFIGURED",
      );
    }
    const targetInfo = normalizeTarget(cleanChannel, rawTarget);
    if (!isChannelReady(cleanChannel, targetInfo.deliveryTarget)) {
      throw fail(
        503,
        cleanChannel === "phone"
          ? targetInfo.route === "INTERNATIONAL"
            ? "国际/港澳台短信通道尚未配置或未开启，暂未启用"
            : "手机验证码真实短信通道尚未配置，暂未启用"
          : "邮箱验证码真实邮件通道尚未配置，暂未启用",
        cleanChannel === "phone" ? "SMS_UNCONFIGURED" : "EMAIL_UNCONFIGURED",
      );
    }

    const cleanPurpose = String(purpose || "login").slice(0, 40);
    if (!challenge_id || typeof challenge_id !== "string" || challenge_id.length > 64) {
      throw fail(400, "验证码挑战无效", "INVALID_CHALLENGE");
    }
    const entered = String(code ?? "").trim();
    if (!/^\d{6}$/.test(entered)) throw fail(401, "验证码无效", "INVALID_OTP");
    const challengePath = path.join(challengesDir, `${challenge_id}.json`);
    let record;
    try {
      record = JSON.parse(await readFile(challengePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw fail(401, "验证码无效或已过期", "INVALID_OTP");
      throw fail(503, "验证码存储暂不可用");
    }
    if (
      record.channel !== cleanChannel ||
      record.target !== targetInfo.storage ||
      record.purpose !== cleanPurpose
    ) {
      await audit({
        type: "verify_mismatch",
        challenge_id,
        channel: cleanChannel,
      });
      throw fail(401, "验证码与接收人或用途不匹配", "OTP_MISMATCH");
    }
    if (record.consumed_at) {
      await audit({ type: "verify_reuse", challenge_id });
      throw fail(401, "验证码已使用", "OTP_ALREADY_USED");
    }
    if (record.expires_at <= nowFn()) {
      await audit({ type: "verify_expired", challenge_id });
      throw fail(401, "验证码已过期", "OTP_EXPIRED");
    }
    const candidate = Buffer.from(hash(entered), "hex");
    const expected = Buffer.from(record.code_hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      record.attempts = Number(record.attempts ?? 0) + 1;
      if (record.attempts >= maxVerifyAttempts) {
        record.consumed_at = nowFn();
      }
      await writeFile(challengePath, JSON.stringify(record), {
        mode: 0o600,
        flush: true,
      });
      await audit({ type: "verify_bad_code", challenge_id });
      throw fail(401, "验证码无效", "INVALID_OTP");
    }
    record.consumed_at = nowFn();
    await writeFile(challengePath, JSON.stringify(record), {
      mode: 0o600,
      flush: true,
    });
    await audit({
      type: "verify_ok",
      challenge_id,
      channel: cleanChannel,
      purpose: cleanPurpose,
    });
    try {
      await unlink(path.join(outboxDir, `${challenge_id}.json`));
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      channel: cleanChannel,
      target: targetInfo.storage,
      delivery_target: targetInfo.deliveryTarget,
      route: targetInfo.route,
      purpose: cleanPurpose,
      challenge_id,
    };
  }

  return {
    send,
    verify,
    delivery,
    isAnyChannelAvailable,
    isEmailAvailable,
    isDomesticPhoneAvailable,
    isIntlPhoneAvailable,
    isChannelReady,
  };
}
