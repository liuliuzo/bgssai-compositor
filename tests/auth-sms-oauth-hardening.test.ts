import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeyPairSync, createVerify } from "node:crypto";
// @ts-ignore Type-free service module.
import { createService } from "../service/server.mjs";
import {
  cleanPhone,
  routePhone,
  normalizePhoneForStorage,
  buildTemplateParamSet,
  nextSmsSeq,
  isValidSmsEndpointRegion,
  tc3Authorization,
  sendTencentSms,
  DEFAULT_SMS_ENDPOINT,
  INTL_SMS_ENDPOINT,
  DEFAULT_SMS_REGION,
  // @ts-ignore Type-free service module.
} from "../service/sms.mjs";
import {
  DEFAULT_DIAL_CODE,
  composeE164Phone,
  validatePhoneParts,
  toDialItems,
} from "../src/phoneDial";

async function directoryFixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "compositor-auth-hardening-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function startService(
  directory: string,
  extraConfig: Record<string, unknown> = {},
  transport?: (url: string, options?: any) => Promise<Response>,
) {
  const server = createService(
    {
      chatIssuer: "https://chat.bgssai.cn",
      publicOrigin: "https://compositor.bgssai.cn",
      clientId: "compositor-client",
      clientSecret: "compositor-client-secret",
      dataDirectory: directory,
      hubOrigin: "https://hub.example",
      hubKey: "test-hub-key",
      hubModel: "qwen-plus",
      supportBridgeSecret: "",
      adminConfigSecret: "test-admin-config-secret",
      useEnv: false,
      ...extraConfig,
    },
    transport,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    request(
      route: string,
      method = "GET",
      data?: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${base}${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("phone routing separates Mainland +86 and International E.164 without stripping country codes", () => {
  assert.equal(cleanPhone("+86 138-0013-8000"), "+8613800138000");

  const cn1 = routePhone("13800138000");
  assert.deepEqual(cn1, {
    route: "MAINLAND",
    storage: "13800138000",
    e164: "+8613800138000",
  });

  const cn2 = routePhone("008613912345678");
  assert.deepEqual(cn2, {
    route: "MAINLAND",
    storage: "13912345678",
    e164: "+8613912345678",
  });

  assert.equal(routePhone("+8612300138000"), null);

  const sg = routePhone("+6591234567");
  assert.deepEqual(sg, {
    route: "INTERNATIONAL",
    storage: "+6591234567",
    e164: "+6591234567",
  });
  assert.equal(normalizePhoneForStorage("+6591234567"), "+6591234567");

  const us = routePhone("0014155550100");
  assert.deepEqual(us, {
    route: "INTERNATIONAL",
    storage: "+14155550100",
    e164: "+14155550100",
  });

  assert.equal(routePhone("+123"), null);
});

test("Tencent SMS TC3-HMAC-SHA256 signing, 2/3/4 template params, and strict Domestic/Intl non-fallback", async () => {
  assert.deepEqual(
    buildTemplateParamSet({
      code: "123456",
      expireMinutes: 5,
      productLabel: "BGSSAI",
      paramCount: 2,
    }),
    ["123456", "5"],
  );
  assert.deepEqual(
    buildTemplateParamSet({
      code: "123456",
      expireMinutes: 5,
      productLabel: "BGSSAI",
      paramCount: 3,
    }),
    ["BGSSAI", "123456", "5"],
  );
  const params4 = buildTemplateParamSet({
    code: "123456",
    expireMinutes: 5,
    productLabel: "BGSSAI",
    paramCount: 4,
  });
  assert.equal(params4.length, 4);
  assert.equal(params4[0], "BGSSAI");
  assert.match(params4[1], /^\d{4}$/);
  assert.equal(Number(params4[1]) >= 1000 && Number(params4[1]) <= 9999, true);
  assert.equal(params4[2], "123456");
  assert.equal(params4[3], "5");

  const seqSample = nextSmsSeq();
  assert.match(seqSample, /^\d{4}$/);

  assert.equal(
    isValidSmsEndpointRegion(DEFAULT_SMS_ENDPOINT, DEFAULT_SMS_REGION),
    true,
  );
  assert.equal(
    isValidSmsEndpointRegion(DEFAULT_SMS_ENDPOINT, "ap-singapore"),
    false,
  );
  assert.equal(
    isValidSmsEndpointRegion(INTL_SMS_ENDPOINT, "ap-singapore"),
    true,
  );

  const auth = tc3Authorization({
    secretId: "AKIDtest123",
    secretKey: "SecretTestKey",
    body: '{"PhoneNumberSet":["+8613800138000"]}',
    timestamp: 1700000000,
    host: "sms.tencentcloudapi.com",
  });
  assert.match(
    auth.authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDtest123\/2023-11-14\/sms\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/,
  );

  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> =
    [];
  const mockTransport = async (url: string, init?: any) => {
    calls.push({
      url,
      headers: init?.headers ?? {},
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return Response.json({
      Response: {
        SendStatusSet: [{ Code: "Ok", SerialNo: "ser-1", Message: "send success" }],
        RequestId: "req-ok-1",
      },
    });
  };

  // Domestic-only config must send domestic and fail closed for international
  const domesticOnlyConfig = {
    enabled: true,
    secret_id: "dom-secret-id",
    secret_key: "dom-secret-key",
    sdk_app_id: "1400000001",
    sign_name: "BGSSAI",
    template_id: "1000001",
    product_label: "BGSSAI",
    template_param_count: 3,
    endpoint: DEFAULT_SMS_ENDPOINT,
    region: DEFAULT_SMS_REGION,
    intl_enabled: false,
  };
  const domResult = await sendTencentSms({
    phone: "+8613800138000",
    code: "654321",
    expireMinutes: 5,
    smsConfig: domesticOnlyConfig,
    transport: mockTransport,
  });
  assert.equal(domResult.route, "MAINLAND");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://sms.tencentcloudapi.com");
  assert.equal(calls[0].headers["X-TC-Action"], "SendSms");
  assert.equal(calls[0].headers["X-TC-Version"], "2021-01-11");
  assert.equal(calls[0].headers["X-TC-Region"], "ap-guangzhou");
  assert.equal(calls[0].body.SignName, "BGSSAI");
  assert.deepEqual(calls[0].body.TemplateParamSet, ["BGSSAI", "654321", "5"]);

  await assert.rejects(
    () =>
      sendTencentSms({
        phone: "+6591234567",
        code: "654321",
        expireMinutes: 5,
        smsConfig: domesticOnlyConfig,
        transport: mockTransport,
      }),
    (err: any) => err.status === 503 && err.code === "SMS_INTL_UNCONFIGURED",
  );
  assert.equal(calls.length, 1);

  // International-only config with optional intl_sign_name omitted must send intl and fail closed for domestic
  const intlOnlyConfig = {
    enabled: false,
    intl_enabled: true,
    intl_secret_id: "intl-secret-id",
    intl_secret_key: "intl-secret-key",
    intl_sdk_app_id: "1400000002",
    intl_sign_name: "",
    intl_template_id: "2000002",
    intl_product_label: "BGSSAI",
    intl_template_param_count: 4,
    intl_endpoint: INTL_SMS_ENDPOINT,
    intl_region: "ap-singapore",
  };
  const intlResult = await sendTencentSms({
    phone: "+6591234567",
    code: "789012",
    expireMinutes: 5,
    smsConfig: intlOnlyConfig,
    transport: mockTransport,
  });
  assert.equal(intlResult.route, "INTERNATIONAL");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://sms.intl.tencentcloudapi.com");
  assert.equal(calls[1].headers["X-TC-Region"], "ap-singapore");
  assert.equal("SignName" in calls[1].body, false);
  assert.equal(calls[1].body.TemplateParamSet.length, 4);
  assert.equal(calls[1].body.TemplateParamSet[0], "BGSSAI");
  assert.match(calls[1].body.TemplateParamSet[1], /^\d{4}$/);
  assert.equal(calls[1].body.TemplateParamSet[2], "789012");
  assert.equal(calls[1].body.TemplateParamSet[3], "5");

  await assert.rejects(
    () =>
      sendTencentSms({
        phone: "+8613800138000",
        code: "789012",
        expireMinutes: 5,
        smsConfig: intlOnlyConfig,
        transport: mockTransport,
      }),
    (err: any) => err.status === 503 && err.code === "SMS_DOMESTIC_UNCONFIGURED",
  );
  assert.equal(calls.length, 2);
});

test("OTP endpoints enforce 60s cooldown, rollback failed delivery, never echo OTP, and route Domestic vs Intl", async () =>
  directoryFixture(async (directory) => {
    const sentMessages: Array<{ target: string; code: string; url: string }> =
      [];
    let failNextSms = false;
    let nowMs = 1_700_000_000_000;

    const svc = await startService(
      directory,
      {
        now: () => nowMs,
        sms: {
          enabled: true,
          secret_id: "dom-id",
          secret_key: "dom-secret",
          sdk_app_id: "1400000001",
          sign_name: "BGSSAI",
          template_id: "1000001",
          product_label: "BGSSAI",
          template_param_count: 4,
          endpoint: DEFAULT_SMS_ENDPOINT,
          region: DEFAULT_SMS_REGION,
          intl_enabled: true,
          intl_secret_id: "intl-id",
          intl_secret_key: "intl-secret",
          intl_sdk_app_id: "1400000002",
          intl_sign_name: "",
          intl_template_id: "2000002",
          intl_template_param_count: 2,
          intl_endpoint: INTL_SMS_ENDPOINT,
          intl_region: "ap-singapore",
        },
      },
      async (url: string, init?: any) => {
        if (failNextSms) {
          return Response.json(
            {
              Response: {
                Error: { Code: "InternalError", Message: "provider down" },
              },
            },
            { status: 500 },
          );
        }
        const payload = JSON.parse(String(init?.body ?? "{}"));
        const otpCode =
          payload.TemplateParamSet.length === 4
            ? payload.TemplateParamSet[2]
            : payload.TemplateParamSet[0];
        sentMessages.push({
          url,
          target: payload.PhoneNumberSet[0],
          code: otpCode,
        });
        return Response.json({
          Response: {
            SendStatusSet: [{ Code: "Ok", SerialNo: "ser-otp-1" }],
            RequestId: "req-otp",
          },
        });
      },
    );

    try {
      // Channels endpoint dynamically enables verification_code & reports phone capabilities
      const chRes = await svc.request("/api/auth/channels");
      assert.equal(chRes.status, 200);
      const chData = await chRes.json();
      assert.equal(chData.channels.includes("verification_code"), true);
      assert.deepEqual(chData.otp_capabilities, {
        email: false,
        phone_domestic: true,
        phone_international: true,
      });

      // Failed send must return 502 and NOT lock cooldown
      failNextSms = true;
      const failSend = await svc.request("/api/auth/code/send", "POST", {
        channel: "phone",
        dial_code: "+86",
        national_number: "13800138000",
        purpose: "login",
      });
      assert.equal(failSend.status, 502);
      failNextSms = false;

      // Subsequent domestic send succeeds immediately without cooldown lock
      const sendDom = await svc.request("/api/auth/code/send", "POST", {
        channel: "phone",
        dial_code: "+86",
        national_number: "13800138000",
        purpose: "login",
      });
      assert.equal(sendDom.status, 200);
      const sendDomBody = await sendDom.json();
      assert.equal(sendDomBody.route, "MAINLAND");
      assert.equal(sendDomBody.cooldown_seconds, 60);
      assert.equal("code" in sendDomBody, false);
      assert.equal("verification_code" in sendDomBody, false);
      assert.equal("seq" in sendDomBody, false);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].target, "+8613800138000");
      assert.match(sentMessages[0].code, /^\d{6}$/);

      // Resend within 60s must return 429
      nowMs += 30_000;
      const tooSoon = await svc.request("/api/auth/code/send", "POST", {
        channel: "phone",
        dial_code: "+86",
        national_number: "13800138000",
        purpose: "login",
      });
      assert.equal(tooSoon.status, 429);

      // Login via code works once and establishes independent session
      const loginOk = await svc.request("/api/auth/code/login", "POST", {
        channel: "phone",
        dial_code: "+86",
        national_number: "13800138000",
        challenge_id: sendDomBody.challenge_id,
        code: sentMessages[0].code,
        purpose: "login",
      });
      assert.equal(loginOk.status, 200);
      const loginJson = await loginOk.json();
      assert.ok(loginJson.session?.token);
      assert.equal(loginJson.session.auth_channel, "verification_code");

      // Replay must be rejected
      const replay = await svc.request("/api/auth/code/login", "POST", {
        channel: "phone",
        dial_code: "+86",
        national_number: "13800138000",
        challenge_id: sendDomBody.challenge_id,
        code: sentMessages[0].code,
        purpose: "login",
      });
      assert.equal(replay.status, 401);

      // International send routes to sms.intl.tencentcloudapi.com and preserves +65
      const sendIntl = await svc.request("/api/auth/code/send", "POST", {
        channel: "phone",
        dial_code: "+65",
        national_number: "91234567",
        purpose: "login",
      });
      assert.equal(sendIntl.status, 200);
      const sendIntlBody = await sendIntl.json();
      assert.equal(sendIntlBody.route, "INTERNATIONAL");
      assert.equal(sentMessages[1].url, "https://sms.intl.tencentcloudapi.com");
      assert.equal(sentMessages[1].target, "+6591234567");

      // After 60s cooldown, resend to domestic number succeeds
      nowMs += 35_000;
      const afterCooldown = await svc.request("/api/auth/code/send", "POST", {
        channel: "phone",
        target: "+8613800138000",
        purpose: "login",
      });
      assert.equal(afterCooldown.status, 200);
    } finally {
      await svc.close();
    }
  }));

test("SMTP email OTP delivers via nodemailer transport without credential leak on error", async () =>
  directoryFixture(async (directory) => {
    const deliveredMail: any[] = [];
    let failMail = false;

    const svc = await startService(directory, {
      smtp: {
        enabled: true,
        host: "smtp.bgssai.example",
        port: 465,
        secure: true,
        user: "noreply@bgssai.example",
        password: "super-secret-smtp-password-123",
        from: "BGSSAI <noreply@bgssai.example>",
      },
      createMailTransport: (options: any) => ({
        async sendMail(message: any) {
          if (failMail) {
            throw new Error(
              `Auth failed with ${options.auth.pass} at ${options.host}`,
            );
          }
          deliveredMail.push({ options, message });
          return { messageId: "<smtp-msg-1@bgssai.example>" };
        },
      }),
    });

    try {
      const chRes = await svc.request("/api/auth/channels");
      const chJson = await chRes.json();
      assert.equal(chJson.otp_capabilities.email, true);

      const sendOk = await svc.request("/api/auth/code/send", "POST", {
        channel: "email",
        target: "designer@bgssai.example",
        purpose: "login",
      });
      assert.equal(sendOk.status, 200);
      const sendJson = await sendOk.json();
      assert.equal(sendJson.channel, "email");
      assert.equal("code" in sendJson, false);
      assert.equal(deliveredMail.length, 1);
      assert.equal(deliveredMail[0].message.to, "designer@bgssai.example");
      const otpMatch = String(deliveredMail[0].message.text).match(/(\d{6})/);
      assert.ok(otpMatch);

      const loginOk = await svc.request("/api/auth/code/login", "POST", {
        channel: "email",
        target: "designer@bgssai.example",
        challenge_id: sendJson.challenge_id,
        code: otpMatch[1],
        purpose: "login",
      });
      assert.equal(loginOk.status, 200);

      // Transport failure returns 502 and scrubs secret
      failMail = true;
      const failedMailRes = await svc.request("/api/auth/code/send", "POST", {
        channel: "email",
        target: "other@bgssai.example",
        purpose: "login",
      });
      assert.equal(failedMailRes.status, 502);
      const errText = await failedMailRes.text();
      assert.equal(errText.includes("super-secret-smtp-password-123"), false);
    } finally {
      await svc.close();
    }
  }));

test("Real Mainland CN OAuth (wechat/douyin/baidu/alipay RSA2) works and blocks overseas/weibo", async () =>
  directoryFixture(async (directory) => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const svc = await startService(
      directory,
      {
        oauthProviders: {
          wechat: {
            enabled: true,
            app_id: "wx-app-1",
            app_secret: "wx-secret-1",
          },
          douyin: {
            enabled: true,
            client_key: "dy-key-1",
            client_secret: "dy-secret-1",
          },
          baidu: {
            enabled: true,
            client_id: "bd-id-1",
            client_secret: "bd-secret-1",
          },
          alipay: {
            enabled: true,
            app_id: "2021000000000001",
            private_key: privateKey,
          },
        },
      },
      async (url: string, init?: any) => {
        if (url.startsWith("https://api.weixin.qq.com/sns/oauth2/access_token")) {
          return Response.json({ access_token: "wx-tok", openid: "wx-open-1" });
        }
        if (url.startsWith("https://api.weixin.qq.com/sns/userinfo")) {
          return Response.json({
            openid: "wx-open-1",
            unionid: "wx-union-1",
            nickname: "微信用户",
          });
        }
        if (url.startsWith("https://open.douyin.com/oauth/access_token/")) {
          return Response.json({
            data: { error_code: 0, access_token: "dy-tok", open_id: "dy-open-1" },
          });
        }
        if (url.startsWith("https://open.douyin.com/oauth/userinfo/")) {
          return Response.json({
            data: { error_code: 0, open_id: "dy-open-1", nickname: "抖音用户" },
          });
        }
        if (url.startsWith("https://openapi.baidu.com/oauth/2.0/token")) {
          return Response.json({ access_token: "bd-tok" });
        }
        if (
          url.startsWith("https://openapi.baidu.com/rest/2.0/passport/users/getInfo")
        ) {
          return Response.json({ userid: "bd-uid-1", username: "百度用户" });
        }
        if (url.startsWith("https://openapi.alipay.com/gateway.do")) {
          const params = new URLSearchParams(String(init?.body ?? ""));
          assert.equal(params.get("sign_type"), "RSA2");
          const sign = params.get("sign") ?? "";
          const entries = [...params.entries()]
            .filter(([k, v]) => k !== "sign" && v !== "")
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join("&");
          const verifier = createVerify("RSA-SHA256");
          verifier.update(entries, "utf8");
          assert.equal(verifier.verify(publicKey, sign, "base64"), true);

          if (params.get("method") === "alipay.system.oauth.token") {
            return Response.json({
              alipay_system_oauth_token_response: {
                access_token: "ali-tok",
                open_id: "ali-open-1",
              },
            });
          }
          if (params.get("method") === "alipay.user.info.share") {
            return Response.json({
              alipay_user_info_share_response: {
                code: "10000",
                open_id: "ali-open-1",
                nick_name: "支付宝用户",
              },
            });
          }
        }
        throw new Error(`Unexpected OAuth upstream URL: ${url}`);
      },
    );

    try {
      const chRes = await svc.request("/api/auth/channels");
      const chJson = await chRes.json();
      for (const provider of ["wechat", "douyin", "baidu", "alipay"]) {
        assert.equal(chJson.channels.includes(provider), true);
      }

      // Overseas / weibo rejected 400
      for (const blocked of ["google", "github", "gitlab", "weibo"]) {
        const res = await svc.request(
          `/api/auth/oauth/${blocked}/authorize`,
          "POST",
          {},
        );
        assert.equal(res.status, 400);
      }

      const expectedHosts: Record<string, string> = {
        wechat: "open.weixin.qq.com",
        douyin: "open.douyin.com",
        baidu: "openapi.baidu.com",
        alipay: "openauth.alipay.com",
      };

      for (const provider of ["wechat", "douyin", "baidu", "alipay"]) {
        const authRes = await svc.request(
          `/api/auth/oauth/${provider}/authorize`,
          "POST",
          {},
        );
        assert.equal(authRes.status, 200);
        const authJson = await authRes.json();
        const url = new URL(authJson.authorize_url);
        assert.equal(url.hostname, expectedHosts[provider]);

        const cbQuery =
          provider === "alipay"
            ? `state=${encodeURIComponent(authJson.state)}&auth_code=ali-code-1`
            : `state=${encodeURIComponent(authJson.state)}&code=${provider}-code-1`;
        const cbRes = await svc.request(
          `/api/auth/oauth/${provider}/callback?${cbQuery}`,
          "GET",
          undefined,
          { Accept: "text/html" },
        );
        assert.equal(cbRes.status, 200);
        assert.match(await cbRes.text(), /授权完成/);

        const pollRes = await svc.request("/api/auth/poll", "POST", {
          requestId: authJson.requestId,
        });
        assert.equal(pollRes.status, 200);
        const pollJson = await pollRes.json();
        assert.ok(pollJson.session?.token);
        assert.equal(pollJson.session.auth_channel, provider);
      }
    } finally {
      await svc.close();
    }
  }));

test("Admin config endpoints mask secrets as ****** and preserve on blank/masked PUT", async () =>
  directoryFixture(async (directory) => {
    const svc = await startService(directory);
    const adminHeaders = { "X-Bgssai-Admin-Secret": "test-admin-config-secret" };

    try {
      // Unauthenticated request denied 401
      const unauth = await svc.request("/api/admin/config/sms");
      assert.equal(unauth.status, 401);

      // ap-singapore with sms.tencentcloudapi.com rejected 400
      const badRegion = await svc.request(
        "/api/admin/config/sms",
        "PUT",
        {
          enabled: true,
          endpoint: "sms.tencentcloudapi.com",
          region: "ap-singapore",
          secret_id: "sid",
          secret_key: "skey",
          sdk_app_id: "1400000001",
          sign_name: "BGSSAI",
          template_id: "1001",
        },
        adminHeaders,
      );
      assert.equal(badRegion.status, 400);

      // Save real secrets for SMS, SMTP, OAuth
      const saveSms = await svc.request(
        "/api/admin/config/sms",
        "PUT",
        {
          enabled: true,
          secret_id: "dom-sid-1",
          secret_key: "dom-secret-value",
          sdk_app_id: "1400000001",
          sign_name: "BGSSAI",
          template_id: "1001",
          template_param_count: 3,
          intl_enabled: true,
          intl_secret_id: "intl-sid-1",
          intl_secret_key: "intl-secret-value",
          intl_sdk_app_id: "1400000002",
          intl_template_id: "2002",
          intl_template_param_count: 4,
          intl_endpoint: "sms.intl.tencentcloudapi.com",
          intl_region: "ap-singapore",
        },
        adminHeaders,
      );
      assert.equal(saveSms.status, 200);
      const maskedSms = await saveSms.json();
      assert.equal(maskedSms.secret_key, "******");
      assert.equal(maskedSms.intl_secret_key, "******");

      // Preserve secrets on blank / ****** update
      const updateBlank = await svc.request(
        "/api/admin/config/sms",
        "PUT",
        {
          enabled: true,
          secret_key: "",
          intl_secret_key: "******",
          sign_name: "BGSSAI-V2",
        },
        adminHeaders,
      );
      assert.equal(updateBlank.status, 200);
      const afterPreserve = await updateBlank.json();
      assert.equal(afterPreserve.secret_key, "******");
      assert.equal(afterPreserve.intl_secret_key, "******");
      assert.equal(afterPreserve.sign_name, "BGSSAI-V2");

      // Verify persisted raw file still retains original secret values
      const rawFile = JSON.parse(
        await fs.readFile(path.join(directory, "channel-config.json"), "utf8"),
      );
      assert.equal(rawFile.sms.secret_key, "dom-secret-value");
      assert.equal(rawFile.sms.intl_secret_key, "intl-secret-value");

      // Save SMTP & OAuth and check masking + aggregate GET /api/admin/config/channels
      const saveSmtp = await svc.request(
        "/api/admin/config/smtp",
        "PUT",
        {
          enabled: true,
          host: "smtp.bgssai.example",
          port: 465,
          secure: true,
          user: "bot@bgssai.example",
          password: "smtp-secret-password",
        },
        adminHeaders,
      );
      assert.equal(saveSmtp.status, 200);
      assert.equal((await saveSmtp.json()).password, "******");

      const channelsSummary = await svc.request(
        "/api/admin/config/channels",
        "GET",
        undefined,
        adminHeaders,
      );
      assert.equal(channelsSummary.status, 200);
      const channelsJson = await channelsSummary.json();
      assert.equal(channelsJson.sms.secret_key, "******");
      assert.equal(channelsJson.smtp.password, "******");

      const badOauth = await svc.request(
        "/api/admin/config/oauth",
        "PUT",
        { provider: "google", enabled: true, client_id: "x", client_secret: "y" },
        adminHeaders,
      );
      assert.equal(badOauth.status, 400);
    } finally {
      await svc.close();
    }
  }));

test("Frontend phoneDial helpers default +86 and preserve international E.164", () => {
  assert.equal(DEFAULT_DIAL_CODE, "+86");
  assert.equal(composeE164Phone("+86", "13800138000"), "+8613800138000");
  assert.equal(composeE164Phone("+65", "91234567"), "+6591234567");
  assert.equal(validatePhoneParts("+86", "13800138000").ok, true);
  assert.equal(validatePhoneParts("+86", "12345678901").ok, false);
  assert.equal(validatePhoneParts("+1", "4155550100").ok, true);
  assert.ok(toDialItems("新加坡").some((d) => d.dial === "+65"));
  assert.ok(toDialItems("86").some((d) => d.iso === "CN"));
});
