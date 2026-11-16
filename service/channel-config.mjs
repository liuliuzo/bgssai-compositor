import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_PRODUCT_LABEL,
  DEFAULT_SMS_ENDPOINT,
  DEFAULT_SMS_REGION,
  effectiveIntlSecretId,
  effectiveIntlSecretKey,
  isDomesticSmsReady,
  isIntlSmsReady,
  isUsableValue,
  isValidSmsEndpointRegion,
  resolveSmsEndpoint,
  resolveSmsRegion,
} from "./sms.mjs";
import { isSmtpReady } from "./mailer.mjs";

export const SECRET_MASK = "******";
export const CN_OAUTH_PROVIDERS = ["wechat", "douyin", "baidu", "alipay"];
export const ALLOWED_OAUTH_PROVIDERS = [
  "wechat",
  "douyin",
  "baidu",
  "alipay",
  "bgssai",
];
export const DISALLOWED_OAUTH_PROVIDERS = new Set([
  "google",
  "github",
  "gitlab",
  "weibo",
  "facebook",
  "twitter",
  "apple",
  "microsoft",
  "linkedin",
  "instagram",
]);

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function isMaskedOrBlank(value) {
  if (value === undefined || value === null) return true;
  const trimmed = String(value).trim();
  if (!trimmed) return true;
  return trimmed === SECRET_MASK || /^[*•]{4,}/.test(trimmed);
}

export function maskSecretIfPresent(value) {
  if (value === undefined || value === null) return "";
  const trimmed = String(value).trim();
  return trimmed ? SECRET_MASK : "";
}

export function preserveSecret(incoming, existing) {
  if (isMaskedOrBlank(incoming)) {
    return String(existing ?? "").trim();
  }
  return String(incoming).trim();
}

function boolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function intOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function normalizeOauthProviderName(raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  if (name === "chat") return "bgssai";
  return name;
}

function readEnvSms(useEnv) {
  if (!useEnv) return {};
  const secretId = String(
    process.env.TENCENT_SMS_SECRET_ID ?? process.env.SMS_SECRET_ID ?? "",
  ).trim();
  const secretKey = String(
    process.env.TENCENT_SMS_SECRET_KEY ?? process.env.SMS_SECRET_KEY ?? "",
  ).trim();
  const sdkAppId = String(process.env.TENCENT_SMS_SDK_APP_ID ?? "").trim();
  const signName = String(process.env.TENCENT_SMS_SIGN_NAME ?? "").trim();
  const templateId = String(process.env.TENCENT_SMS_TEMPLATE_ID ?? "").trim();
  const endpoint = String(
    process.env.TENCENT_SMS_ENDPOINT ?? DEFAULT_SMS_ENDPOINT,
  ).trim();
  const region = String(process.env.TENCENT_SMS_REGION ?? "").trim();
  const productLabel = String(
    process.env.TENCENT_SMS_PRODUCT_LABEL ?? DEFAULT_PRODUCT_LABEL,
  ).trim();
  const templateParamCount = intOr(
    process.env.TENCENT_SMS_TEMPLATE_PARAM_COUNT,
    2,
  );

  const intlSdkAppId = String(
    process.env.TENCENT_INTL_SMS_SDK_APP_ID ?? "",
  ).trim();
  const intlTemplateId = String(
    process.env.TENCENT_INTL_SMS_TEMPLATE_ID ?? "",
  ).trim();
  const intlSecretId = String(
    process.env.TENCENT_INTL_SMS_SECRET_ID ?? "",
  ).trim();
  const intlSecretKey = String(
    process.env.TENCENT_INTL_SMS_SECRET_KEY ?? "",
  ).trim();
  const intlSignName = String(
    process.env.TENCENT_INTL_SMS_SIGN_NAME ?? "",
  ).trim();
  const intlSenderId = String(
    process.env.TENCENT_INTL_SMS_SENDER_ID ?? "",
  ).trim();
  const intlEndpoint = String(
    process.env.TENCENT_INTL_SMS_ENDPOINT ?? DEFAULT_SMS_ENDPOINT,
  ).trim();
  const intlRegion = String(process.env.TENCENT_INTL_SMS_REGION ?? "").trim();
  const intlProductLabel = String(
    process.env.TENCENT_INTL_SMS_PRODUCT_LABEL ?? "",
  ).trim();
  const intlTemplateParamCount = intOr(
    process.env.TENCENT_INTL_SMS_TEMPLATE_PARAM_COUNT,
    2,
  );
  const domesticHasCreds = Boolean(
    secretId && secretKey && sdkAppId && signName && templateId,
  );
  const intlHasCreds = Boolean(
    (intlSecretId || secretId) &&
      (intlSecretKey || secretKey) &&
      intlSdkAppId &&
      intlTemplateId,
  );

  return {
    provider: "tencent_cloud",
    enabled: boolFlag(process.env.TENCENT_SMS_ENABLED, domesticHasCreds),
    secret_id: secretId,
    secret_key: secretKey,
    sdk_app_id: sdkAppId,
    sign_name: signName,
    template_id: templateId,
    endpoint: endpoint || DEFAULT_SMS_ENDPOINT,
    region: region || resolveSmsRegion("", endpoint || DEFAULT_SMS_ENDPOINT),
    product_label: productLabel || DEFAULT_PRODUCT_LABEL,
    template_param_count: templateParamCount,
    code_expire_seconds: intOr(process.env.TENCENT_SMS_EXPIRE_SECONDS, 300),
    intl_enabled: boolFlag(
      process.env.TENCENT_INTL_SMS_ENABLED,
      intlHasCreds && Boolean(process.env.TENCENT_INTL_SMS_TEMPLATE_ID),
    ),
    intl_secret_id: intlSecretId,
    intl_secret_key: intlSecretKey,
    intl_sdk_app_id: intlSdkAppId,
    intl_sign_name: intlSignName,
    intl_sender_id: intlSenderId,
    intl_template_id: intlTemplateId,
    intl_endpoint: intlEndpoint || DEFAULT_SMS_ENDPOINT,
    intl_region:
      intlRegion || resolveSmsRegion("", intlEndpoint || DEFAULT_SMS_ENDPOINT),
    intl_product_label: intlProductLabel,
    intl_template_param_count: intlTemplateParamCount,
  };
}

function readEnvSmtp(useEnv) {
  if (!useEnv) return {};
  const host = String(process.env.SMTP_HOST ?? "").trim();
  const port = intOr(process.env.SMTP_PORT, 465);
  const username = String(
    process.env.SMTP_USER ?? process.env.SMTP_USERNAME ?? "",
  ).trim();
  const password = String(
    process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD ?? "",
  ).trim();
  const fromAddress = String(
    process.env.SMTP_FROM ?? process.env.MAIL_FROM ?? username,
  ).trim();
  const secure = boolFlag(process.env.SMTP_SECURE, port === 465);
  return {
    provider: "smtp",
    enabled: boolFlag(
      process.env.SMTP_ENABLED,
      Boolean(host && username && password),
    ),
    host,
    port,
    username,
    password,
    from_address: fromAddress || username,
    secure,
  };
}

function readEnvOauth(useEnv) {
  if (!useEnv) return {};
  const map = {
    wechat: {
      client_id: String(
        process.env.WECHAT_APP_ID ?? process.env.WECHAT_CLIENT_ID ?? "",
      ).trim(),
      client_secret: String(
        process.env.WECHAT_APP_SECRET ?? process.env.WECHAT_CLIENT_SECRET ?? "",
      ).trim(),
      scope: String(process.env.WECHAT_SCOPE ?? "snsapi_login").trim(),
    },
    douyin: {
      client_id: String(
        process.env.DOUYIN_CLIENT_KEY ?? process.env.DOUYIN_APP_ID ?? "",
      ).trim(),
      client_secret: String(
        process.env.DOUYIN_CLIENT_SECRET ?? process.env.DOUYIN_APP_SECRET ?? "",
      ).trim(),
      scope: String(process.env.DOUYIN_SCOPE ?? "user_info").trim(),
    },
    baidu: {
      client_id: String(
        process.env.BAIDU_CLIENT_ID ?? process.env.BAIDU_APP_ID ?? "",
      ).trim(),
      client_secret: String(
        process.env.BAIDU_CLIENT_SECRET ?? process.env.BAIDU_APP_SECRET ?? "",
      ).trim(),
      scope: String(process.env.BAIDU_SCOPE ?? "basic").trim(),
    },
    alipay: {
      client_id: String(
        process.env.ALIPAY_APP_ID ?? process.env.ALIPAY_CLIENT_ID ?? "",
      ).trim(),
      client_secret: String(
        process.env.ALIPAY_PRIVATE_KEY ??
          process.env.ALIPAY_APP_SECRET ??
          "",
      ).trim(),
      scope: String(process.env.ALIPAY_SCOPE ?? "auth_user").trim(),
    },
    bgssai: {
      client_id: String(
        process.env.CHAT_CLIENT_ID ?? process.env.BGSSAI_CLIENT_ID ?? "",
      ).trim(),
      client_secret: String(
        process.env.CHAT_CLIENT_SECRET ?? process.env.BGSSAI_CLIENT_SECRET ?? "",
      ).trim(),
      scope: String(process.env.BGSSAI_SCOPE ?? "openid profile").trim(),
    },
  };
  for (const [provider, cfg] of Object.entries(map)) {
    cfg.enabled = Boolean(cfg.client_id && cfg.client_secret);
    cfg.provider = provider;
  }
  return map;
}

function normalizeSmsSection(raw = {}, base = {}) {
  const endpoint = resolveSmsEndpoint(
    raw.endpoint ?? base.endpoint ?? DEFAULT_SMS_ENDPOINT,
  );
  const region = resolveSmsRegion(raw.region ?? base.region, endpoint);
  const intlEndpoint = resolveSmsEndpoint(
    raw.intl_endpoint ??
      raw.intlEndpoint ??
      base.intl_endpoint ??
      DEFAULT_SMS_ENDPOINT,
  );
  const intlRegion = resolveSmsRegion(
    raw.intl_region ?? raw.intlRegion ?? base.intl_region,
    intlEndpoint,
  );
  const secretId = String(
    raw.secret_id ?? raw.secretId ?? base.secret_id ?? "",
  ).trim();
  const secretKey = String(
    raw.secret_key ?? raw.secretKey ?? base.secret_key ?? "",
  ).trim();
  const sdkAppId = String(
    raw.sdk_app_id ?? raw.sdkAppId ?? base.sdk_app_id ?? "",
  ).trim();
  const signName = String(
    raw.sign_name ?? raw.signName ?? base.sign_name ?? "",
  ).trim();
  const templateId = String(
    raw.template_id ?? raw.templateId ?? base.template_id ?? "",
  ).trim();

  const intlSdkAppId = String(
    raw.intl_sdk_app_id ?? raw.intlSdkAppId ?? base.intl_sdk_app_id ?? "",
  ).trim();
  const intlTemplateId = String(
    raw.intl_template_id ?? raw.intlTemplateId ?? base.intl_template_id ?? "",
  ).trim();
  const intlSecretId = String(
    raw.intl_secret_id ?? raw.intlSecretId ?? base.intl_secret_id ?? "",
  ).trim();
  const intlSecretKey = String(
    raw.intl_secret_key ?? raw.intlSecretKey ?? base.intl_secret_key ?? "",
  ).trim();

  const inferredDomesticEnabled = Boolean(
    secretId && sdkAppId && signName && templateId && secretKey,
  );
  const inferredIntlEnabled = Boolean(
    intlSdkAppId &&
      intlTemplateId &&
      (intlSecretId || secretId) &&
      (intlSecretKey || secretKey),
  );

  return {
    provider: "tencent_cloud",
    enabled: boolFlag(
      raw.enabled,
      base.enabled !== undefined ? base.enabled : inferredDomesticEnabled,
    ),
    secret_id: secretId,
    secret_key: secretKey,
    sdk_app_id: sdkAppId,
    sign_name: signName,
    template_id: templateId,
    endpoint,
    region,
    product_label:
      String(
        raw.product_label ??
          raw.productLabel ??
          base.product_label ??
          DEFAULT_PRODUCT_LABEL,
      ).trim() || DEFAULT_PRODUCT_LABEL,
    template_param_count: intOr(
      raw.template_param_count ??
        raw.templateParamCount ??
        base.template_param_count,
      2,
    ),
    code_expire_seconds: intOr(
      raw.code_expire_seconds ??
        raw.codeExpireSeconds ??
        base.code_expire_seconds,
      300,
    ),
    intl_enabled: boolFlag(
      raw.intl_enabled ?? raw.intlEnabled,
      base.intl_enabled !== undefined ? base.intl_enabled : inferredIntlEnabled,
    ),
    intl_secret_id: intlSecretId,
    intl_secret_key: intlSecretKey,
    intl_sdk_app_id: intlSdkAppId,
    intl_sign_name: String(
      raw.intl_sign_name ?? raw.intlSignName ?? base.intl_sign_name ?? "",
    ).trim(),
    intl_sender_id: String(
      raw.intl_sender_id ?? raw.intlSenderId ?? base.intl_sender_id ?? "",
    ).trim(),
    intl_template_id: intlTemplateId,
    intl_endpoint: intlEndpoint,
    intl_region: intlRegion,
    intl_product_label: String(
      raw.intl_product_label ??
        raw.intlProductLabel ??
        base.intl_product_label ??
        "",
    ).trim(),
    intl_template_param_count: intOr(
      raw.intl_template_param_count ??
        raw.intlTemplateParamCount ??
        base.intl_template_param_count,
      2,
    ),
  };
}

function normalizeSmtpSection(raw = {}, base = {}) {
  const host = String(raw.host ?? base.host ?? "").trim();
  const port = intOr(raw.port ?? base.port, 465);
  const username = String(
    raw.username ?? raw.user ?? base.username ?? "",
  ).trim();
  const password = String(
    raw.password ?? raw.pass ?? base.password ?? "",
  ).trim();
  const fromAddress =
    String(
      raw.from_address ??
        raw.fromAddress ??
        raw.from ??
        base.from_address ??
        username,
    ).trim() || username;
  const secure = boolFlag(
    raw.secure,
    base.secure !== undefined ? base.secure : port === 465,
  );
  const inferred = Boolean(host && username && password);
  return {
    provider: "smtp",
    enabled: boolFlag(
      raw.enabled,
      base.enabled !== undefined ? base.enabled : inferred,
    ),
    host,
    port,
    username,
    password,
    from_address: fromAddress,
    secure,
  };
}

function normalizeOauthEntry(provider, raw = {}, base = {}) {
  const clientId = String(
    raw.client_id ??
      raw.clientId ??
      raw.app_id ??
      raw.appId ??
      raw.client_key ??
      raw.clientKey ??
      base.client_id ??
      "",
  ).trim();
  const clientSecret = String(
    raw.client_secret ??
      raw.clientSecret ??
      raw.app_secret ??
      raw.appSecret ??
      raw.private_key ??
      raw.privateKey ??
      base.client_secret ??
      "",
  ).trim();
  const authorizeUrl = String(
    raw.authorize_url ?? raw.authorizeUrl ?? base.authorize_url ?? "",
  ).trim();
  const tokenUrl = String(
    raw.token_url ?? raw.tokenUrl ?? base.token_url ?? "",
  ).trim();
  const userinfoUrl = String(
    raw.userinfo_url ?? raw.userinfoUrl ?? base.userinfo_url ?? "",
  ).trim();
  const redirectUri = String(
    raw.redirect_uri ?? raw.redirectUri ?? base.redirect_uri ?? "",
  ).trim();
  const scope = String(raw.scope ?? base.scope ?? "").trim();
  const inferred = Boolean(
    isUsableValue(clientId) &&
      (provider === "bgssai" ? true : isUsableValue(clientSecret)),
  );
  return {
    provider,
    enabled: boolFlag(
      raw.enabled,
      base.enabled !== undefined ? base.enabled : inferred,
    ),
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    authorize_url: authorizeUrl,
    token_url: tokenUrl,
    userinfo_url: userinfoUrl,
    redirect_uri: redirectUri,
  };
}

export function createChannelConfigStore(dataDirectory, initialConfig = {}) {
  const configFile = path.join(dataDirectory, "channel-config.json");
  const useEnv = initialConfig.useEnv !== false;

  const envSms = readEnvSms(useEnv);
  const envSmtp = readEnvSmtp(useEnv);
  const envOauth = readEnvOauth(useEnv);

  const initSms = normalizeSmsSection(initialConfig.sms ?? {}, envSms);
  const initSmtp = normalizeSmtpSection(initialConfig.smtp ?? {}, envSmtp);
  const initOauth = {};
  for (const p of ALLOWED_OAUTH_PROVIDERS) {
    const rawEntry =
      initialConfig.oauthProviders?.[p] ??
      (p === "bgssai" ? initialConfig.oauthProviders?.chat : undefined) ??
      {};
    initOauth[p] = normalizeOauthEntry(p, rawEntry, envOauth[p] ?? {});
  }

  let persisted = null;
  if (existsSync(configFile)) {
    try {
      persisted = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      persisted = null;
    }
  }

  function loadSnapshot() {
    if (!persisted && existsSync(configFile)) {
      try {
        persisted = JSON.parse(readFileSync(configFile, "utf8"));
      } catch {
        persisted = null;
      }
    }
    const sms = persisted?.sms
      ? normalizeSmsSection(persisted.sms, initSms)
      : initSms;
    const smtp = persisted?.smtp
      ? normalizeSmtpSection(persisted.smtp, initSmtp)
      : initSmtp;
    const oauth = {};
    for (const p of ALLOWED_OAUTH_PROVIDERS) {
      oauth[p] = persisted?.oauth?.[p]
        ? normalizeOauthEntry(p, persisted.oauth[p], initOauth[p])
        : initOauth[p];
    }
    return { sms, smtp, oauth };
  }

  async function persistSnapshot(next) {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    persisted = next;
    await writeFile(configFile, JSON.stringify(next, null, 2), {
      mode: 0o600,
      flush: true,
    });
  }

  function getSms() {
    return loadSnapshot().sms;
  }

  function getSmtp() {
    return loadSnapshot().smtp;
  }

  function getOauth(provider) {
    const clean = String(provider ?? "").trim().toLowerCase();
    if (DISALLOWED_OAUTH_PROVIDERS.has(clean)) return null;
    const normalized = normalizeOauthProviderName(clean);
    if (!ALLOWED_OAUTH_PROVIDERS.includes(normalized)) return null;
    return loadSnapshot().oauth[normalized] ?? null;
  }

  function getPublicSms() {
    const sms = getSms();
    const hasSecretId = isUsableValue(sms.secret_id);
    const hasSecretKey = isUsableValue(sms.secret_key);
    const hasIntlSecretId = isUsableValue(sms.intl_secret_id);
    const hasIntlSecretKey = isUsableValue(sms.intl_secret_key);
    return {
      provider: sms.provider,
      enabled: Boolean(sms.enabled),
      configured: isDomesticSmsReady(sms),
      secret_id: maskSecretIfPresent(sms.secret_id),
      secret_key: maskSecretIfPresent(sms.secret_key),
      secret_configured: hasSecretId && hasSecretKey,
      secret_id_configured: hasSecretId,
      secret_key_configured: hasSecretKey,
      sdk_app_id: sms.sdk_app_id,
      sign_name: sms.sign_name,
      template_id: sms.template_id,
      endpoint: sms.endpoint,
      region: sms.region,
      product_label: sms.product_label,
      template_param_count: sms.template_param_count,
      code_expire_seconds: sms.code_expire_seconds,
      intl_enabled: Boolean(sms.intl_enabled),
      intl_configured: isIntlSmsReady(sms),
      intl_secret_id: maskSecretIfPresent(sms.intl_secret_id),
      intl_secret_key: maskSecretIfPresent(sms.intl_secret_key),
      intl_secret_configured: hasIntlSecretId && hasIntlSecretKey,
      intl_effective_secret_configured:
        isUsableValue(effectiveIntlSecretId(sms)) &&
        isUsableValue(effectiveIntlSecretKey(sms)),
      intl_sdk_app_id: sms.intl_sdk_app_id,
      intl_sign_name: sms.intl_sign_name,
      intl_sender_id: sms.intl_sender_id,
      intl_template_id: sms.intl_template_id,
      intl_endpoint: sms.intl_endpoint,
      intl_region: sms.intl_region,
      intl_product_label: sms.intl_product_label,
      intl_template_param_count: sms.intl_template_param_count,
    };
  }

  function getPublicSmtp() {
    const smtp = getSmtp();
    return {
      provider: smtp.provider,
      enabled: Boolean(smtp.enabled),
      configured: isSmtpReady(smtp),
      host: smtp.host,
      port: smtp.port,
      username: smtp.username,
      password: maskSecretIfPresent(smtp.password),
      password_configured: isUsableValue(smtp.password),
      from_address: smtp.from_address,
      secure: Boolean(smtp.secure),
    };
  }

  function getPublicOauth() {
    const snap = loadSnapshot().oauth;
    const out = {};
    for (const p of ALLOWED_OAUTH_PROVIDERS) {
      const entry = snap[p];
      out[p] = {
        provider: p,
        enabled: Boolean(entry.enabled),
        configured: isOauthEntryConfigured(entry),
        client_id: entry.client_id,
        client_secret: maskSecretIfPresent(entry.client_secret),
        secret_configured: isUsableValue(entry.client_secret),
        scope: entry.scope,
        authorize_url: entry.authorize_url,
        token_url: entry.token_url,
        userinfo_url: entry.userinfo_url,
        redirect_uri: entry.redirect_uri,
      };
    }
    return out;
  }

  function isOauthEntryConfigured(entry) {
    if (!entry || !entry.enabled) return false;
    if (!isUsableValue(entry.client_id)) return false;
    if (!isUsableValue(entry.client_secret)) return false;
    for (const url of [
      entry.authorize_url,
      entry.token_url,
      entry.userinfo_url,
    ]) {
      if (url && !url.startsWith("https://")) return false;
    }
    return true;
  }

  async function saveSms(input = {}) {
    if (!input || typeof input !== "object") {
      throw fail(400, "短信配置请求体无效", "INVALID_PARAM");
    }
    const rawProvider = String(input.provider ?? "").trim().toLowerCase();
    if (rawProvider === "dev_log" || rawProvider === "dev-log") {
      throw fail(400, "不支持 dev_log 通道，请配置真实腾讯云短信", "INVALID_PROVIDER");
    }

    const snap = loadSnapshot();
    const cur = snap.sms;

    const secretId = preserveSecret(
      input.secret_id ?? input.secretId,
      cur.secret_id,
    );
    const secretKey = preserveSecret(
      input.secret_key ?? input.secretKey,
      cur.secret_key,
    );
    const intlSecretId = preserveSecret(
      input.intl_secret_id ?? input.intlSecretId,
      cur.intl_secret_id,
    );
    const intlSecretKey = preserveSecret(
      input.intl_secret_key ?? input.intlSecretKey,
      cur.intl_secret_key,
    );

    const endpoint = resolveSmsEndpoint(
      input.endpoint ?? cur.endpoint ?? DEFAULT_SMS_ENDPOINT,
    );
    const region = resolveSmsRegion(
      input.region !== undefined ? input.region : cur.region,
      endpoint,
    );
    if (!isValidSmsEndpointRegion(endpoint, region)) {
      throw fail(
        400,
        "国内短信使用 sms.tencentcloudapi.com 时禁止填写 ap-singapore，请用 ap-guangzhou",
        "SMS_INVALID_ENDPOINT_REGION",
      );
    }

    const intlEndpoint = resolveSmsEndpoint(
      input.intl_endpoint ??
        input.intlEndpoint ??
        cur.intl_endpoint ??
        DEFAULT_SMS_ENDPOINT,
    );
    const intlRegion = resolveSmsRegion(
      input.intl_region !== undefined
        ? input.intl_region
        : input.intlRegion !== undefined
          ? input.intlRegion
          : cur.intl_region,
      intlEndpoint,
    );
    if (!isValidSmsEndpointRegion(intlEndpoint, intlRegion)) {
      throw fail(
        400,
        "国际短信使用 sms.tencentcloudapi.com 时禁止填写 ap-singapore，请用 ap-guangzhou 或改用 sms.intl.tencentcloudapi.com",
        "SMS_INVALID_ENDPOINT_REGION",
      );
    }

    const paramCountRaw =
      input.template_param_count ??
      input.templateParamCount ??
      cur.template_param_count;
    const paramCount = intOr(paramCountRaw, 2);
    if (![2, 3, 4].includes(paramCount)) {
      throw fail(400, "template_param_count 仅支持 2、3、4", "INVALID_PARAM");
    }

    const intlParamCountRaw =
      input.intl_template_param_count ??
      input.intlTemplateParamCount ??
      cur.intl_template_param_count;
    const intlParamCount = intOr(intlParamCountRaw, 2);
    if (![2, 3, 4].includes(intlParamCount)) {
      throw fail(
        400,
        "intl_template_param_count 仅支持 2、3、4",
        "INVALID_PARAM",
      );
    }

    const expireRaw =
      input.code_expire_seconds ??
      input.codeExpireSeconds ??
      cur.code_expire_seconds;
    const expireSeconds = intOr(expireRaw, 300);
    if (expireSeconds < 60 || expireSeconds > 1800) {
      throw fail(400, "code_expire_seconds 须在 60–1800 之间", "INVALID_PARAM");
    }

    const nextSms = {
      provider: "tencent_cloud",
      enabled: boolFlag(input.enabled, cur.enabled),
      secret_id: secretId,
      secret_key: secretKey,
      sdk_app_id: String(
        input.sdk_app_id ?? input.sdkAppId ?? cur.sdk_app_id ?? "",
      ).trim(),
      sign_name: String(
        input.sign_name ?? input.signName ?? cur.sign_name ?? "",
      ).trim(),
      template_id: String(
        input.template_id ?? input.templateId ?? cur.template_id ?? "",
      ).trim(),
      endpoint,
      region,
      product_label:
        String(
          input.product_label ??
            input.productLabel ??
            cur.product_label ??
            DEFAULT_PRODUCT_LABEL,
        ).trim() || DEFAULT_PRODUCT_LABEL,
      template_param_count: paramCount,
      code_expire_seconds: expireSeconds,
      intl_enabled: boolFlag(
        input.intl_enabled ?? input.intlEnabled,
        cur.intl_enabled,
      ),
      intl_secret_id: intlSecretId,
      intl_secret_key: intlSecretKey,
      intl_sdk_app_id: String(
        input.intl_sdk_app_id ?? input.intlSdkAppId ?? cur.intl_sdk_app_id ?? "",
      ).trim(),
      intl_sign_name: String(
        input.intl_sign_name ?? input.intlSignName ?? cur.intl_sign_name ?? "",
      ).trim(),
      intl_sender_id: String(
        input.intl_sender_id ?? input.intlSenderId ?? cur.intl_sender_id ?? "",
      ).trim(),
      intl_template_id: String(
        input.intl_template_id ??
          input.intlTemplateId ??
          cur.intl_template_id ??
          "",
      ).trim(),
      intl_endpoint: intlEndpoint,
      intl_region: intlRegion,
      intl_product_label: String(
        input.intl_product_label ??
          input.intlProductLabel ??
          cur.intl_product_label ??
          "",
      ).trim(),
      intl_template_param_count: intlParamCount,
    };

    if (nextSms.enabled && !isDomesticSmsReady(nextSms)) {
      throw fail(
        400,
        "启用国内短信前请先填齐 SecretId、SecretKey、SdkAppId、短信签名与模板 ID",
        "SMS_CONFIG_INCOMPLETE",
      );
    }
    if (nextSms.intl_enabled && !isIntlSmsReady(nextSms)) {
      throw fail(
        400,
        "启用国际短信前请先填齐有效密钥、国际 SdkAppId 与国际模板 ID",
        "SMS_INTL_CONFIG_INCOMPLETE",
      );
    }

    await persistSnapshot({ ...snap, sms: nextSms });
    return getPublicSms();
  }

  async function saveSmtp(input = {}) {
    if (!input || typeof input !== "object") {
      throw fail(400, "邮件配置请求体无效", "INVALID_PARAM");
    }
    const rawProvider = String(input.provider ?? "").trim().toLowerCase();
    if (rawProvider === "dev_log" || rawProvider === "dev-log") {
      throw fail(400, "不支持 dev_log 通道，请配置真实 SMTP 服务", "INVALID_PROVIDER");
    }
    const snap = loadSnapshot();
    const cur = snap.smtp;
    const password = preserveSecret(
      input.password ?? input.pass,
      cur.password,
    );
    const port = intOr(input.port ?? cur.port, 465);
    const username = String(
      input.username ?? input.user ?? cur.username ?? "",
    ).trim();
    const host = String(input.host ?? cur.host ?? "").trim();
    const nextSmtp = {
      provider: "smtp",
      enabled: boolFlag(input.enabled, cur.enabled),
      host,
      port,
      username,
      password,
      from_address:
        String(
          input.from_address ??
            input.fromAddress ??
            input.from ??
            cur.from_address ??
            username,
        ).trim() || username,
      secure: boolFlag(
        input.secure,
        input.port !== undefined ? port === 465 : cur.secure,
      ),
    };
    if (nextSmtp.enabled && !isSmtpReady(nextSmtp)) {
      throw fail(
        400,
        "启用 SMTP 邮件服务前请先填齐 host、username 与 password",
        "SMTP_CONFIG_INCOMPLETE",
      );
    }
    await persistSnapshot({ ...snap, smtp: nextSmtp });
    return getPublicSmtp();
  }

  async function saveOauth(providerRaw, input = {}) {
    const rawName = String(providerRaw ?? input.provider ?? input.channel ?? "")
      .trim()
      .toLowerCase();
    if (!rawName) {
      throw fail(400, "OAuth 渠道不能为空", "INVALID_PARAM");
    }
    if (DISALLOWED_OAUTH_PROVIDERS.has(rawName)) {
      throw fail(400, "仅支持中国大陆 OAuth 渠道（wechat/douyin/baidu/alipay/bgssai）", "UNSUPPORTED_OAUTH_PROVIDER");
    }
    const provider = normalizeOauthProviderName(rawName);
    if (!ALLOWED_OAUTH_PROVIDERS.includes(provider)) {
      throw fail(400, "不支持的 OAuth 渠道", "UNSUPPORTED_OAUTH_PROVIDER");
    }
    const snap = loadSnapshot();
    const cur = snap.oauth[provider];
    const clientSecret = preserveSecret(
      input.client_secret ??
        input.clientSecret ??
        input.app_secret ??
        input.appSecret ??
        input.private_key ??
        input.privateKey,
      cur.client_secret,
    );
    const nextEntry = normalizeOauthEntry(
      provider,
      { ...input, client_secret: clientSecret },
      cur,
    );
    for (const url of [
      nextEntry.authorize_url,
      nextEntry.token_url,
      nextEntry.userinfo_url,
    ]) {
      if (url && !url.startsWith("https://")) {
        throw fail(400, "OAuth 端点地址必须使用 HTTPS", "INVALID_OAUTH_URL");
      }
    }
    if (
      nextEntry.enabled &&
      (!isUsableValue(nextEntry.client_id) || !isUsableValue(nextEntry.client_secret))
    ) {
      throw fail(
        400,
        "启用 OAuth 渠道前请先填齐 client_id 与 client_secret",
        "OAUTH_CONFIG_INCOMPLETE",
      );
    }
    const nextOauth = { ...snap.oauth, [provider]: nextEntry };
    await persistSnapshot({ ...snap, oauth: nextOauth });
    return getPublicOauth()[provider];
  }

  return {
    getSms,
    getSmtp,
    getOauth,
    getPublicSms,
    getPublicSmtp,
    getPublicOauth,
    saveSms,
    saveSmtp,
    saveOauth,
    isOauthConfigured: (provider) => isOauthEntryConfigured(getOauth(provider)),
    isDomesticSmsReady: () => isDomesticSmsReady(getSms()),
    isIntlSmsReady: () => isIntlSmsReady(getSms()),
    isSmtpReady: () => isSmtpReady(getSmtp()),
  };
}
