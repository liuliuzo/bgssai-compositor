import { createSign } from "node:crypto";

export const CN_OAUTH_DEFAULTS = {
  wechat: {
    authorizeUrl: "https://open.weixin.qq.com/connect/qrconnect",
    tokenUrl: "https://api.weixin.qq.com/sns/oauth2/access_token",
    userinfoUrl: "https://api.weixin.qq.com/sns/userinfo",
    scope: "snsapi_login",
  },
  douyin: {
    authorizeUrl: "https://open.douyin.com/platform/oauth/connect/",
    tokenUrl: "https://open.douyin.com/oauth/access_token/",
    userinfoUrl: "https://open.douyin.com/oauth/userinfo/",
    scope: "user_info",
  },
  baidu: {
    authorizeUrl: "https://openapi.baidu.com/oauth/2.0/authorize",
    tokenUrl: "https://openapi.baidu.com/oauth/2.0/token",
    userinfoUrl: "https://openapi.baidu.com/rest/2.0/passport/users/getInfo",
    scope: "basic",
  },
  alipay: {
    authorizeUrl: "https://openauth.alipay.com/oauth2/publicAppAuthorize.htm",
    tokenUrl: "https://openapi.alipay.com/gateway.do",
    userinfoUrl: "",
    scope: "auth_user",
  },
  bgssai: {
    authorizeUrl: "https://chat.bgssai.cn/oauth/authorize",
    tokenUrl: "https://chat.bgssai.cn/api/user/oauth/token",
    userinfoUrl: "https://chat.bgssai.cn/api/user/oauth/userinfo",
    scope: "openid profile",
  },
};

function fail(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function nonEmpty(value) {
  if (value === undefined || value === null) return "";
  const s = String(value).trim();
  return s && s.toLowerCase() !== "null" ? s : "";
}

export function formatShanghaiTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = byType.hour === "24" ? "00" : byType.hour;
  return `${byType.year}-${byType.month}-${byType.day} ${hour}:${byType.minute}:${byType.second}`;
}

function normalizePkcs8Pem(rawPem) {
  const trimmed = String(rawPem ?? "").trim();
  if (!trimmed) {
    throw fail(503, "支付宝应用私钥未配置", "ALIPAY_KEY_MISSING");
  }
  if (trimmed.includes("-----BEGIN ")) {
    return trimmed;
  }
  const cleanB64 = trimmed.replace(/\s+/g, "");
  const lines = cleanB64.match(/.{1,64}/g) ?? [cleanB64];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

export function signAlipayRsa2(params, privateKeyPem) {
  const sortedKeys = Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && String(params[k]) !== "")
    .sort();
  const content = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");
  try {
    const pem = normalizePkcs8Pem(privateKeyPem);
    const signer = createSign("RSA-SHA256");
    signer.update(content, "utf8");
    signer.end();
    return signer.sign(pem, "base64");
  } catch (error) {
    if (error?.status) throw error;
    throw fail(503, "支付宝应用私钥格式无效或签名失败", "ALIPAY_SIGN_FAILED");
  }
}

export function buildCnAuthorizeUrl({
  provider,
  cfg,
  redirectUri,
  state,
  codeChallenge,
}) {
  const defaults = CN_OAUTH_DEFAULTS[provider];
  if (!defaults) {
    throw fail(400, "不支持该第三方登录渠道", "UNSUPPORTED_OAUTH_PROVIDER");
  }
  const baseUrl = cfg.authorize_url || defaults.authorizeUrl;
  const url = new URL(baseUrl);
  const scope = cfg.scope || defaults.scope;

  if (provider === "wechat") {
    url.searchParams.set("appid", cfg.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.hash = "wechat_redirect";
    return url.href;
  }

  if (provider === "douyin") {
    url.searchParams.set("client_key", cfg.client_id);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.href;
  }

  if (provider === "baidu") {
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    if (!url.searchParams.has("display")) {
      url.searchParams.set("display", "qrcode");
    }
    return url.href;
  }

  if (provider === "alipay") {
    url.searchParams.set("app_id", cfg.client_id);
    url.searchParams.set("scope", scope);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.href;
  }

  // bgssai / chat
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  if (codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.href;
}

export async function exchangeCnOauthIdentity({
  provider,
  cfg,
  code,
  redirectUri,
  codeVerifier,
  transport = fetch,
}) {
  const defaults = CN_OAUTH_DEFAULTS[provider];
  if (!defaults) {
    throw fail(400, "不支持该第三方登录渠道", "UNSUPPORTED_OAUTH_PROVIDER");
  }

  if (provider === "wechat") {
    const tokenUrl = new URL(cfg.token_url || defaults.tokenUrl);
    tokenUrl.searchParams.set("appid", cfg.client_id);
    tokenUrl.searchParams.set("secret", cfg.client_secret);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");

    const tokenRes = await transport(tokenUrl.href, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw fail(401, "微信 OAuth 换票失败", "OAUTH_EXCHANGE_FAILED");
    const tokens = await tokenRes.json();
    if (tokens.errcode && Number(tokens.errcode) !== 0) {
      throw fail(401, "微信 OAuth 授权失败", "OAUTH_EXCHANGE_FAILED");
    }
    let extSub = nonEmpty(tokens.openid) || nonEmpty(tokens.unionid);
    let displayName = "";
    const accessToken = nonEmpty(tokens.access_token);
    if ((!extSub || cfg.userinfo_url) && accessToken) {
      const infoUrl = new URL(cfg.userinfo_url || defaults.userinfoUrl);
      infoUrl.searchParams.set("access_token", accessToken);
      if (extSub) infoUrl.searchParams.set("openid", extSub);
      infoUrl.searchParams.set("lang", "zh_CN");
      const infoRes = await transport(infoUrl.href, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (infoRes.ok) {
        const info = await infoRes.json();
        if (!info.errcode || Number(info.errcode) === 0) {
          extSub = extSub || nonEmpty(info.openid) || nonEmpty(info.unionid) || nonEmpty(info.sub);
          displayName = nonEmpty(info.nickname) || nonEmpty(info.name);
        }
      } else if (!extSub) {
        throw fail(401, "微信 OAuth 身份验证失败", "OAUTH_USERINFO_FAILED");
      }
    }
    if (!extSub) throw fail(502, "微信 OAuth 身份缺少唯一标识", "OAUTH_MISSING_UID");
    return {
      extSub,
      displayName: displayName || `wechat_${extSub.slice(0, 8)}`,
    };
  }

  if (provider === "douyin") {
    const tokenUrl = cfg.token_url || defaults.tokenUrl;
    const form = new URLSearchParams({
      client_key: cfg.client_id,
      client_secret: cfg.client_secret,
      code,
      grant_type: "authorization_code",
    });
    const tokenRes = await transport(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw fail(401, "抖音 OAuth 换票失败", "OAUTH_EXCHANGE_FAILED");
    const wrap = await tokenRes.json();
    const data = wrap?.data && typeof wrap.data === "object" ? wrap.data : wrap;
    if (data?.error_code && Number(data.error_code) !== 0) {
      throw fail(401, "抖音 OAuth 授权失败", "OAUTH_EXCHANGE_FAILED");
    }
    let extSub = nonEmpty(data?.open_id) || nonEmpty(data?.openid);
    let displayName = nonEmpty(data?.nickname);
    const accessToken = nonEmpty(data?.access_token);
    if ((!extSub || cfg.userinfo_url) && accessToken) {
      const infoUrl = cfg.userinfo_url || defaults.userinfoUrl;
      const infoRes = await transport(infoUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          access_token: accessToken,
          open_id: extSub || undefined,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (infoRes.ok) {
        const infoWrap = await infoRes.json();
        const info =
          infoWrap?.data && typeof infoWrap.data === "object" ? infoWrap.data : infoWrap;
        if (!info?.error_code || Number(info.error_code) === 0) {
          extSub =
            extSub ||
            nonEmpty(info?.open_id) ||
            nonEmpty(info?.openid) ||
            nonEmpty(info?.sub);
          displayName = displayName || nonEmpty(info?.nickname) || nonEmpty(info?.name);
        }
      } else if (!extSub) {
        throw fail(401, "抖音 OAuth 身份验证失败", "OAUTH_USERINFO_FAILED");
      }
    }
    if (!extSub) throw fail(502, "抖音 OAuth 身份缺少唯一标识", "OAUTH_MISSING_UID");
    return {
      extSub,
      displayName: displayName || `douyin_${extSub.slice(0, 8)}`,
    };
  }

  if (provider === "baidu") {
    const tokenUrl = new URL(cfg.token_url || defaults.tokenUrl);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("client_id", cfg.client_id);
    tokenUrl.searchParams.set("client_secret", cfg.client_secret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    const tokenRes = await transport(tokenUrl.href, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw fail(401, "百度 OAuth 换票失败", "OAUTH_EXCHANGE_FAILED");
    const tokens = await tokenRes.json();
    if (nonEmpty(tokens.error)) {
      throw fail(401, "百度 OAuth 授权失败", "OAUTH_EXCHANGE_FAILED");
    }
    const accessToken = nonEmpty(tokens.access_token) || nonEmpty(tokens.data?.access_token);
    if (!accessToken) throw fail(502, "百度 OAuth 换票响应无效", "OAUTH_EXCHANGE_FAILED");

    const infoUrl = new URL(cfg.userinfo_url || defaults.userinfoUrl);
    infoUrl.searchParams.set("access_token", accessToken);
    const infoRes = await transport(infoUrl.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!infoRes.ok) throw fail(401, "百度 OAuth 身份验证失败", "OAUTH_USERINFO_FAILED");
    const info = await infoRes.json();
    if (info.error_code && Number(info.error_code) !== 0) {
      throw fail(401, "百度 OAuth 身份验证失败", "OAUTH_USERINFO_FAILED");
    }
    const extSub =
      nonEmpty(info.userid) ||
      nonEmpty(info.openid) ||
      nonEmpty(info.open_id) ||
      nonEmpty(info.sub);
    if (!extSub) throw fail(502, "百度 OAuth 身份缺少唯一标识", "OAUTH_MISSING_UID");
    const displayName =
      nonEmpty(info.username) || nonEmpty(info.nickname) || nonEmpty(info.name);
    return {
      extSub,
      displayName: displayName || `baidu_${extSub.slice(0, 8)}`,
    };
  }

  if (provider === "alipay") {
    const gatewayUrl = cfg.token_url || defaults.tokenUrl;
    const params = {
      app_id: cfg.client_id,
      method: "alipay.system.oauth.token",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatShanghaiTimestamp(),
      version: "1.0",
      grant_type: "authorization_code",
      code,
    };
    params.sign = signAlipayRsa2(params, cfg.client_secret);

    const tokenRes = await transport(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw fail(401, "支付宝 OAuth 换票失败", "OAUTH_EXCHANGE_FAILED");
    const body = await tokenRes.json();
    if (body?.error_response) {
      throw fail(401, "支付宝 OAuth 授权失败", "OAUTH_EXCHANGE_FAILED");
    }
    const payload = body?.alipay_system_oauth_token_response;
    if (payload && typeof payload === "object") {
      if (nonEmpty(payload.code) && String(payload.code) !== "10000") {
        throw fail(401, "支付宝 OAuth 授权失败", "OAUTH_EXCHANGE_FAILED");
      }
      const extSub = nonEmpty(payload.user_id) || nonEmpty(payload.open_id);
      if (!extSub) throw fail(502, "支付宝 OAuth 身份缺少唯一标识", "OAUTH_MISSING_UID");
      return {
        extSub,
        displayName: `alipay_${extSub.slice(0, 8)}`,
      };
    }
    const accessToken = nonEmpty(body?.access_token);
    if (accessToken && cfg.userinfo_url) {
      const infoRes = await transport(cfg.userinfo_url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!infoRes.ok) throw fail(401, "支付宝 OAuth 身份验证失败", "OAUTH_USERINFO_FAILED");
      const info = await infoRes.json();
      const extSub =
        nonEmpty(info.user_id) || nonEmpty(info.open_id) || nonEmpty(info.sub);
      if (!extSub) throw fail(502, "支付宝 OAuth 身份缺少唯一标识", "OAUTH_MISSING_UID");
      return {
        extSub,
        displayName:
          nonEmpty(info.nick_name) || nonEmpty(info.name) || `alipay_${extSub.slice(0, 8)}`,
      };
    }
    throw fail(502, "支付宝 OAuth 换票响应无效", "OAUTH_EXCHANGE_FAILED");
  }

  // bgssai / chat
  const tokenUrl = cfg.token_url || defaults.tokenUrl;
  const tokenBody = {
    grant_type: "authorization_code",
    code,
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  };
  const tokenRes = await transport(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenBody),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw fail(401, "Chat 换票失败", "OAUTH_EXCHANGE_FAILED");
  const tokenWrap = await tokenRes.json();
  const tokenData =
    tokenWrap?.data && typeof tokenWrap.data === "object"
      ? tokenWrap.data
      : tokenWrap;
  const accessToken = nonEmpty(tokenData?.access_token);
  if (!accessToken) throw fail(502, "Chat 换票响应无效", "OAUTH_EXCHANGE_FAILED");
  const infoRes = await transport(cfg.userinfo_url || defaults.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!infoRes.ok) throw fail(401, "Chat 身份验证失败", "OAUTH_USERINFO_FAILED");
  const infoWrap = await infoRes.json();
  const info =
    infoWrap?.data && typeof infoWrap.data === "object" ? infoWrap.data : infoWrap;
  const extSub =
    nonEmpty(info?.sub) ||
    nonEmpty(info?.id) ||
    nonEmpty(info?.user_id) ||
    nonEmpty(info?.open_id) ||
    nonEmpty(info?.openid);
  if (!extSub) throw fail(502, "Chat 身份缺少 sub", "OAUTH_MISSING_UID");
  const displayName =
    nonEmpty(info?.nickname) ||
    nonEmpty(info?.name) ||
    nonEmpty(info?.preferred_username) ||
    extSub;
  return { extSub, displayName, accessToken };
}
