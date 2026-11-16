import { createHash, createHmac, randomInt } from "node:crypto";

export const DEFAULT_SMS_ENDPOINT = "sms.tencentcloudapi.com";
export const INTL_SMS_ENDPOINT = "sms.intl.tencentcloudapi.com";
export const DEFAULT_SMS_REGION = "ap-guangzhou";
export const BLOCKED_DOMESTIC_ENDPOINT_REGION = "ap-singapore";
export const SMS_API_ACTION = "SendSms";
export const SMS_API_VERSION = "2021-01-11";
export const DEFAULT_PRODUCT_LABEL = "BGSSAI Compositor";

const MAINLAND_CORE_RE = /^1[3-9]\d{9}$/;
const MAINLAND_86_RE = /^\+86(1[3-9]\d{9})$/;
const INTL_E164_RE = /^\+[1-9]\d{4,14}$/;

const PLACEHOLDER_VALUES = new Set([
  "change-me",
  "changeme",
  "placeholder",
  "your-secret-here",
  "xxx",
  "******",
  "****",
]);

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function isUsableValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[*•]{4,}$/.test(trimmed)) return false;
  return !PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
}

export function cleanPhone(raw) {
  return String(raw ?? "").trim().replace(/[\s-]+/g, "");
}

/**
 * Route phone number strictly between MAINLAND (+86 / 11-digit CN mobile)
 * and INTERNATIONAL (non-+86 E.164 `+[1-9]\d{4,14}`).
 * Never strips international dial prefixes or coerces +1/+852 into +86.
 */
export function routePhone(raw) {
  let cleaned = cleanPhone(raw);
  if (!cleaned) return null;
  if (cleaned.startsWith("00") && cleaned.length > 4) {
    cleaned = `+${cleaned.slice(2)}`;
  }
  if (MAINLAND_CORE_RE.test(cleaned)) {
    return {
      route: "MAINLAND",
      storage: cleaned,
      e164: `+86${cleaned}`,
    };
  }
  const match86 = MAINLAND_86_RE.exec(cleaned);
  if (match86) {
    return {
      route: "MAINLAND",
      storage: match86[1],
      e164: `+86${match86[1]}`,
    };
  }
  if (cleaned.startsWith("+86")) {
    return null;
  }
  if (INTL_E164_RE.test(cleaned)) {
    return {
      route: "INTERNATIONAL",
      storage: cleaned,
      e164: cleaned,
    };
  }
  return null;
}

export function normalizePhoneForStorage(raw) {
  return routePhone(raw)?.storage ?? null;
}

export function toTencentE164(raw) {
  return routePhone(raw)?.e164 ?? null;
}

export function maskPhone(raw) {
  const cleaned = cleanPhone(raw);
  if (cleaned.length >= 8) {
    return `${cleaned.slice(0, 3)}****${cleaned.slice(-4)}`;
  }
  if (cleaned.length >= 5) {
    return `${cleaned.slice(0, 2)}****${cleaned.slice(-2)}`;
  }
  return "****";
}

export function resolveSmsEndpoint(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return DEFAULT_SMS_ENDPOINT;
  if (trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      throw fail(400, "短信服务端点不能包含凭据", "SMS_INVALID_ENDPOINT");
    }
    return parsed.host;
  }
  if (trimmed.startsWith("http://")) {
    throw fail(400, "短信服务端点必须使用 HTTPS", "SMS_INVALID_ENDPOINT");
  }
  if (/[\s/@]/.test(trimmed)) {
    throw fail(400, "短信服务端点格式无效", "SMS_INVALID_ENDPOINT");
  }
  return trimmed;
}

export function resolveSmsEndpointUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return `https://${DEFAULT_SMS_ENDPOINT}`;
  if (trimmed.startsWith("https://")) {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      throw fail(400, "短信服务端点不能包含凭据", "SMS_INVALID_ENDPOINT");
    }
    return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname);
  }
  const host = resolveSmsEndpoint(trimmed);
  return `https://${host}`;
}

export function resolveSmsRegion(raw, endpoint = DEFAULT_SMS_ENDPOINT) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed) return trimmed;
  const host = resolveSmsEndpoint(endpoint).toLowerCase();
  if (host === INTL_SMS_ENDPOINT) return "ap-singapore";
  return DEFAULT_SMS_REGION;
}

export function isValidSmsEndpointRegion(endpoint, region) {
  let host;
  try {
    host = resolveSmsEndpoint(endpoint).toLowerCase();
  } catch {
    return false;
  }
  const resolvedRegion = resolveSmsRegion(region, host).toLowerCase();
  return !(
    host === DEFAULT_SMS_ENDPOINT &&
    resolvedRegion === BLOCKED_DOMESTIC_ENDPOINT_REGION
  );
}

export function nextSmsSeq() {
  return String(randomInt(1000, 10000));
}

export function buildTemplateParamSet({
  productLabel,
  seq,
  code,
  expireMinutes = 5,
  paramCount = 2,
  fallbackLabel = DEFAULT_PRODUCT_LABEL,
}) {
  const rawCount = Number(paramCount);
  let count = 2;
  if (rawCount === 2 || rawCount === 3 || rawCount === 4) {
    count = rawCount;
  } else if (paramCount !== undefined && paramCount !== null) {
    console.warn(`[sms] unsupported template_param_count=${paramCount}, fallback to 2`);
  }
  const label =
    String(productLabel ?? "").trim() ||
    String(fallbackLabel ?? "").trim() ||
    DEFAULT_PRODUCT_LABEL;
  const safeSeq = String(seq ?? "").trim() || nextSmsSeq();
  const safeCode = String(code ?? "").replace(/[\r\n]/g, "").trim();
  const minutes = String(Math.max(1, Math.ceil(Number(expireMinutes) || 5)));
  if (count === 4) return [label, safeSeq, safeCode, minutes];
  if (count === 3) return [label, safeCode, minutes];
  return [safeCode, minutes];
}

export function effectiveIntlSecretId(smsConfig) {
  if (!smsConfig) return "";
  return (
    String(smsConfig.intl_secret_id ?? "").trim() ||
    String(smsConfig.secret_id ?? "").trim()
  );
}

export function effectiveIntlSecretKey(smsConfig) {
  if (!smsConfig) return "";
  return (
    String(smsConfig.intl_secret_key ?? "").trim() ||
    String(smsConfig.secret_key ?? "").trim()
  );
}

export function isDomesticSmsReady(smsConfig) {
  if (!smsConfig || !smsConfig.enabled) return false;
  const endpoint = resolveSmsEndpoint(smsConfig.endpoint);
  const region = resolveSmsRegion(smsConfig.region, endpoint);
  return Boolean(
    isUsableValue(smsConfig.secret_id) &&
      isUsableValue(smsConfig.secret_key) &&
      String(smsConfig.sdk_app_id ?? "").trim() &&
      String(smsConfig.sign_name ?? "").trim() &&
      String(smsConfig.template_id ?? "").trim() &&
      isValidSmsEndpointRegion(endpoint, region),
  );
}

export function isIntlSmsReady(smsConfig) {
  if (!smsConfig || !smsConfig.intl_enabled) return false;
  const endpoint = resolveSmsEndpoint(smsConfig.intl_endpoint);
  const region = resolveSmsRegion(smsConfig.intl_region, endpoint);
  return Boolean(
    isUsableValue(effectiveIntlSecretId(smsConfig)) &&
      isUsableValue(effectiveIntlSecretKey(smsConfig)) &&
      String(smsConfig.intl_sdk_app_id ?? "").trim() &&
      String(smsConfig.intl_template_id ?? "").trim() &&
      isValidSmsEndpointRegion(endpoint, region),
  );
}

function sha256Hex(payload) {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmacSha256(key, msg) {
  return createHmac("sha256", key).update(msg, "utf8").digest();
}

export function tc3Authorization({
  secretId,
  secretKey,
  service = "sms",
  host = DEFAULT_SMS_ENDPOINT,
  action = SMS_API_ACTION,
  version = SMS_API_VERSION,
  region = DEFAULT_SMS_REGION,
  body,
  timestamp,
}) {
  const ts = Number(timestamp ?? Math.floor(Date.now() / 1000));
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const hashedRequestPayload = sha256Hex(body);
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(ts),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = createHmac("sha256", secretSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    timestamp: ts,
    date,
    credentialScope,
    signature,
    region,
    version,
    action,
  };
}

/**
 * Send OTP via Tencent Cloud SMS (`SendSms` `2021-01-11`, TC3-HMAC-SHA256).
 * Strictly separates Domestic (`+86`) and International (non-`+86` E.164)
 * with zero cross-channel fallback.
 */
export async function sendTencentSms({
  phone,
  code,
  expireMinutes = 5,
  smsConfig,
  transport = fetch,
  seq,
  timestamp,
}) {
  const target = routePhone(phone);
  if (!target) {
    throw fail(400, "手机号无效", "INVALID_PHONE");
  }

  let endpointRaw;
  let regionRaw;
  let secretId;
  let secretKey;
  let requestBody;

  if (target.route === "MAINLAND") {
    if (!isDomesticSmsReady(smsConfig)) {
      throw fail(503, "国内短信通道尚未配置，暂未启用", "SMS_DOMESTIC_UNCONFIGURED");
    }
    endpointRaw = smsConfig.endpoint;
    regionRaw = smsConfig.region;
    secretId = String(smsConfig.secret_id).trim();
    secretKey = String(smsConfig.secret_key).trim();
    const paramSet = buildTemplateParamSet({
      productLabel: smsConfig.product_label,
      seq: seq ?? nextSmsSeq(),
      code,
      expireMinutes,
      paramCount: smsConfig.template_param_count ?? 2,
    });
    requestBody = {
      PhoneNumberSet: [target.e164],
      SmsSdkAppId: String(smsConfig.sdk_app_id).trim(),
      SignName: String(smsConfig.sign_name).trim(),
      TemplateId: String(smsConfig.template_id).trim(),
      TemplateParamSet: paramSet,
    };
  } else {
    if (!isIntlSmsReady(smsConfig)) {
      throw fail(
        503,
        "国际/港澳台短信通道尚未配置或未开启，暂未启用",
        "SMS_INTL_UNCONFIGURED",
      );
    }
    endpointRaw = smsConfig.intl_endpoint;
    regionRaw = smsConfig.intl_region;
    secretId = effectiveIntlSecretId(smsConfig);
    secretKey = effectiveIntlSecretKey(smsConfig);
    const paramSet = buildTemplateParamSet({
      productLabel:
        String(smsConfig.intl_product_label ?? "").trim() ||
        String(smsConfig.product_label ?? "").trim(),
      seq: seq ?? nextSmsSeq(),
      code,
      expireMinutes,
      paramCount: smsConfig.intl_template_param_count ?? 2,
    });
    requestBody = {
      PhoneNumberSet: [target.e164],
      SmsSdkAppId: String(smsConfig.intl_sdk_app_id).trim(),
      TemplateId: String(smsConfig.intl_template_id).trim(),
      TemplateParamSet: paramSet,
    };
    const intlSign = String(smsConfig.intl_sign_name ?? "").trim();
    if (intlSign) {
      requestBody.SignName = intlSign;
    }
    const intlSenderId = String(smsConfig.intl_sender_id ?? "").trim();
    if (intlSenderId) {
      requestBody.SenderId = intlSenderId;
    }
  }

  const host = resolveSmsEndpoint(endpointRaw);
  const endpointUrl = resolveSmsEndpointUrl(endpointRaw);
  const region = resolveSmsRegion(regionRaw, host);
  if (!isValidSmsEndpointRegion(host, region)) {
    throw fail(
      400,
      "使用 sms.tencentcloudapi.com 时不支持 ap-singapore 地域，请改用 ap-guangzhou",
      "SMS_INVALID_ENDPOINT_REGION",
    );
  }

  const serializedBody = JSON.stringify(requestBody);
  const ts = Number(timestamp ?? Math.floor(Date.now() / 1000));
  const { authorization } = tc3Authorization({
    secretId,
    secretKey,
    service: "sms",
    host,
    action: SMS_API_ACTION,
    version: SMS_API_VERSION,
    region,
    body: serializedBody,
    timestamp: ts,
  });

  let resp;
  let payload;
  try {
    resp = await transport(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Host: host,
        "X-TC-Action": SMS_API_ACTION,
        "X-TC-Timestamp": String(ts),
        "X-TC-Version": SMS_API_VERSION,
        "X-TC-Region": region,
        Authorization: authorization,
      },
      body: serializedBody,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw fail(502, "短信发送失败，请稍后重试", "SMS_SEND_FAILED");
    }
    payload = await resp.json();
  } catch (error) {
    if (error?.status) throw error;
    console.warn("[otp-sms] transport failed", {
      route: target.route,
      phone: maskPhone(target.e164),
    });
    throw fail(502, "短信发送失败，请稍后重试", "SMS_SEND_FAILED");
  }

  const response = payload?.Response ?? {};
  if (response.Error) {
    console.warn("[otp-sms] api error", {
      route: target.route,
      phone: maskPhone(target.e164),
      code: response.Error.Code,
    });
    throw fail(502, "短信发送失败，请稍后重试", "SMS_SEND_FAILED");
  }

  const status0 = response.SendStatusSet?.[0];
  if (!status0 || String(status0.Code).toLowerCase() !== "ok") {
    console.warn("[otp-sms] provider rejected", {
      route: target.route,
      phone: maskPhone(target.e164),
      code: status0?.Code ?? "empty",
    });
    throw fail(502, "短信发送失败，请稍后重试", "SMS_SEND_FAILED");
  }

  return {
    delivered: true,
    adapter: "tencent-sms",
    route: target.route,
    request_id: response.RequestId ?? null,
  };
}
