import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
// @ts-ignore Node 24 executes the service's type-free ES module.
import { createService } from "../service/server.mjs";
const sample = await fs.readFile(
  new URL("../fixtures/shared.bgcomp", import.meta.url),
  "utf8",
);
test("Chat PKCE creates a distinct session; conflicts, revocation, account isolation and Hub routing are enforced", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "compositor-test-"),
  );
  let revocationOffline = false;
  let verifier = "",
    challenge = "",
    subject = "user-1";
  const calls: string[] = [];
  const transport = async (url: string, options: any = {}) => {
    calls.push(url);
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://chat.example",
        authorization_endpoint: "https://chat.example/oauth/authorize",
        token_endpoint: "https://chat.example/token",
        userinfo_endpoint: "https://chat.example/userinfo",
        revocation_endpoint: "https://chat.example/revoke",
        code_challenge_methods_supported: ["S256"],
      });
    if (url.endsWith("/token")) {
      verifier = options.body.get("code_verifier");
      assert.equal(
        createHash("sha256").update(verifier).digest("base64url"),
        challenge,
      );
      return Response.json({
        access_token: "chat-access-only-on-server",
        token_type: "Bearer",
        expires_in: 7200,
      });
    }
    if (url.endsWith("/userinfo"))
      return Response.json({ sub: subject, name: subject });
    if (url.endsWith("/revoke"))
      return revocationOffline
        ? new Response("", { status: 503 })
        : Response.json({});
    if (url.endsWith("/v1/models")) return Response.json({ data: [{ id: "test-model", billing_multiplier: 0.5, billing_unit: "token", price_version: 9, currency: "USD", input_fen_per_million: 10 }] });
    if (url.includes("/v1/usage/")) return Response.json({ request_id: url.split("/").at(-1), billing_status: "settled", billed_tokens: 5, raw_tokens: 10, debit_fen: 2, currency: "USD" });
    assert.equal(url, "https://hub.example/v1/chat/completions");
    const owner = createHash("sha256").update("https://chat.example\0user-1").digest("hex");
    const persisted = JSON.parse(await fs.readFile(path.join(directory, "usage", owner, `${options.headers["X-Request-Id"]}.json`), "utf8"));
    assert.equal(persisted.request_id, options.headers["X-Request-Id"]);
    assert.equal(options.headers.Authorization, "Bearer server-hub-key");
    return Response.json({ choices: [{ message: { content: "建议文字" } }] });
  };
  const server = createService(
    {
      chatIssuer: "https://chat.example",
      publicOrigin: "https://compositor.example",
      clientId: "compositor",
      dataDirectory: directory,
      hubOrigin: "https://hub.example",
      hubKey: "server-hub-key",
      hubModel: "test-model",
    },
    transport,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (
    route: string,
    method = "GET",
    body?: unknown,
    token?: string,
    etag?: string,
  ) =>
    fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(etag ? { "If-Match": etag } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async () => {
    const begin = await (await request("/api/auth/begin", "POST")).json();
    const url = new URL(begin.authorizeUrl);
    challenge = url.searchParams.get("code_challenge")!;
    assert.equal(
      (await request("/oauth/callback?state=wrong&code=code")).status,
      400,
    );
    const callback = `/oauth/callback?state=${url.searchParams.get("state")}&code=code`;
    assert.equal((await request(callback)).status, 200);
    assert.equal((await request(callback)).status, 400);
    const result = await (
      await request("/api/auth/poll", "POST", { requestId: begin.requestId })
    ).json();
    assert.notEqual(result.session.token, "chat-access-only-on-server");
    return result.session.token;
  };
  try {
    const token = await login();
    assert.equal(
      (await request("/api/project", "GET", undefined, token)).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/grants",
          "PUT",
          { sync: true, ai: true, bot: true },
          token,
        )
      ).status,
      200,
    );
    const empty = await (
      await request("/api/project", "GET", undefined, token)
    ).json();
    assert.equal(empty.etag, "empty");
    const saved = await (
      await request(
        "/api/project",
        "PUT",
        { content: sample },
        token,
        empty.etag,
      )
    ).json();
    assert.equal(
      (
        await request(
          "/api/project",
          "PUT",
          { content: sample + " " },
          token,
          "empty",
        )
      ).status,
      412,
    );
    const bot = await (
      await request("/api/bot/token", "POST", undefined, token)
    ).json();
    const changed = await (
      await request(
        "/api/bot/operate",
        "POST",
        { action: "rename", name: "Bot 修改" },
        bot.token,
        saved.etag,
      )
    ).json();
    assert.ok(changed.etag);
    assert.equal(
      JSON.parse(
        (
          await (
            await request("/api/bot/project", "GET", undefined, bot.token)
          ).json()
        ).content,
      ).name,
      "Bot 修改",
    );
    assert.equal(
      (await request("/api/project", "GET", undefined, bot.token)).status,
      401,
    );
    assert.equal(
      (
        await (
          await request("/api/ai/text", "POST", { prompt: "设计建议" }, token)
        ).json()
      ).text,
      "建议文字",
    );
    const receipt = (await (await request("/api/ai/usage", "GET", undefined, token)).json()).data[0];
    assert.equal(receipt.billed_tokens, 5);
    assert.equal(receipt.currency, "USD");
    assert.equal(receipt.reconciled, true);
    assert.equal((await request("/api/ai/text", "POST", { prompt: "设计建议", request_id: receipt.request_id }, token)).status, 409);
    assert.equal(calls.filter((url) => url.endsWith("/v1/chat/completions")).length, 1);
    const model = (await (await request("/api/ai/models", "GET", undefined, token)).json()).data[0];
    assert.equal(model.billing_multiplier, 0.5);
    assert.equal(model.price_version, 9);
    assert.equal(model.input_fen_per_million, 10);
    subject = "../../different-account";
    const second = await login();
    await request(
      "/api/grants",
      "PUT",
      { sync: true, ai: false, bot: false },
      second,
    );
    assert.equal(
      (await (await request("/api/project", "GET", undefined, second)).json())
        .content,
      null,
    );
    assert.deepEqual((await (await request("/api/ai/usage", "GET", undefined, second)).json()).data, []);
    await request(
      "/api/grants",
      "PUT",
      { sync: false, ai: false, bot: false },
      token,
    );
    assert.equal(
      (await request("/api/bot/project", "GET", undefined, bot.token)).status,
      401,
    );
    assert.equal(
      (await request("/api/ai/text", "POST", { prompt: "test" }, token)).status,
      403,
    );
    await request(
      "/api/grants",
      "PUT",
      { sync: true, ai: false, bot: false },
      token,
    );
    assert.equal(
      (await (await request("/api/project", "GET", undefined, token)).json())
        .content,
      null,
    );
    assert.equal(
      (await request("/api/session", "DELETE", undefined, token)).status,
      200,
    );
    assert.equal(
      (await request("/api/project", "GET", undefined, token)).status,
      401,
    );
    const cancelled = await (await request("/api/auth/begin", "POST")).json();
    await request("/api/auth/cancel", "POST", {
      requestId: cancelled.requestId,
    });
    assert.equal(
      (
        await request("/api/auth/poll", "POST", {
          requestId: cancelled.requestId,
        })
      ).status,
      410,
    );
    assert.ok(calls.includes("https://chat.example/revoke"));
    assert.ok(calls.includes("https://hub.example/v1/chat/completions"));
    revocationOffline = true;
    const logout = await (
      await request("/api/session", "DELETE", undefined, second)
    ).json();
    assert.equal(logout.chatRevoked, false);
    assert.equal(
      (await request("/api/project", "GET", undefined, second)).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("compositor-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Password auth, AI model selection & hub allowlist, Support bridge HMAC idempotency, and expanded MCP tools", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "compositor-ops-test-"),
  );
  let lastAiHeaders: Record<string, string> = {};
  const transport = async (url: string, options: any = {}) => {
    if (url.endsWith("/v1/chat/completions")) lastAiHeaders = options.headers ?? {};
    if (url.includes("fail-tokenhub")) {
      return new Response("TokenHub https://internal.hub/v1 key secret-hub-key failed", { status: 502 });
    }
    return Response.json({
      choices: [{ message: { content: "TokenHub 推荐图层标题" } }],
    });
  };
  const server = createService(
    {
      chatIssuer: "https://chat.example",
      publicOrigin: "https://compositor.example",
      clientId: "compositor",
      dataDirectory: directory,
      hubOrigin: "https://hub.example",
      hubKey: "secret-hub-key",
      hubModel: "qwen-plus",
      supportBridgeSecret: "bridge-hmac-secret-123",
    },
    transport,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (
    route: string,
    method = "GET",
    body?: unknown,
    token?: string,
    extraHeaders: Record<string, string> = {},
  ) =>
    fetch(`${base}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    const reg = await (
      await req("/api/auth/register", "POST", {
        username: "designer_a",
        password: "Password#12345",
      })
    ).json();
    assert.equal(reg.ok, true);
    assert.ok(reg.token);

    const loginRes = await (
      await req("/api/auth/login", "POST", {
        username: "designer_a",
        password: "Password#12345",
      })
    ).json();
    assert.equal(loginRes.ok, true);
    const userAToken = loginRes.token;

    const secondRegistration = await (
      await req("/api/auth/register", "POST", {
        username: "designer_b",
        password: "Password#98765",
      })
    ).json();
    assert.equal(secondRegistration.ok, true);
    const userBToken = secondRegistration.token;

    await req("/api/grants", "PUT", { sync: true, ai: true, bot: true }, userAToken);
    const catalog = await (await req("/api/ai/models", "GET", undefined, userAToken)).json();
    assert.equal(catalog.product_code, "compositor");
    assert.ok(catalog.models.some((m: any) => m.model_id === "deepseek-v3"));

    const aiOk = await (
      await req(
        "/api/ai/text",
        "POST",
        { prompt: "生成海报标题", model: "deepseek-v3" },
        userAToken,
      )
    ).json();
    assert.equal(aiOk.model_id, "deepseek-v3");
    assert.equal(lastAiHeaders["X-Bgssai-Product"], "bgssai-compositor");
    assert.equal(lastAiHeaders["X-Bgssai-Model"], "deepseek-v3");
    assert.ok(!aiOk.text.toLowerCase().includes("tokenhub"));

    const badOrigin = await req(
      "/api/ai/text",
      "POST",
      { prompt: "test", model: "deepseek-v3", hub_origin: "https://evil.example" },
      userAToken,
    );
    assert.equal(badOrigin.status, 403);
    const badOriginBody = await badOrigin.json();
    assert.ok(!badOriginBody.error.toLowerCase().includes("tokenhub"));

    const sCreated = await (
      await req(
        "/api/support/sessions",
        "POST",
        { subject: "图层导出咨询", message: "请问如何导出透明 PNG？" },
        userAToken,
      )
    ).json();
    assert.equal(sCreated.product_code, "compositor");
    const tCreated = await (
      await req(
        "/api/support/tickets",
        "POST",
        {
          session_id: sCreated.session_id,
          subject: "色彩配置工单",
          content: "导出色彩偏差排查",
        },
        userAToken,
      )
    ).json();
    assert.equal(tCreated.product_code, "compositor");

    assert.equal(
      (
        await req(
          `/api/support/tickets?ticket_id=${tCreated.ticket_id}`,
          "GET",
          undefined,
          userBToken,
        )
      ).status,
      403,
    );

    const webhookPayload = JSON.stringify({
      event_id: "evt_comp_1001",
      product_code: "compositor",
      session_id: sCreated.session_id,
      ticket_id: tCreated.ticket_id,
      status: "resolved",
      reply: "请使用 PNG 导出选项以保留透明通道",
    });
    const { createHmac: hmacFn } = await import("node:crypto");
    const sig = hmacFn("sha256", "bridge-hmac-secret-123")
      .update(webhookPayload)
      .digest("hex");

    const badWebhook = await fetch(`${base}/api/support-bridge/inbox`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Support-Signature": "sha256=" + "0".repeat(64),
      },
      body: webhookPayload,
    });
    assert.equal(badWebhook.status, 401);

    const okWebhook1 = await (
      await fetch(`${base}/api/support-bridge/inbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Support-Signature": `sha256=${sig}`,
        },
        body: webhookPayload,
      })
    ).json();
    assert.equal(okWebhook1.ok, true);
    assert.equal(okWebhook1.deduplicated, false);

    const okWebhook2 = await (
      await fetch(`${base}/api/support-bridge/inbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Support-Signature": `sha256=${sig}`,
        },
        body: webhookPayload,
      })
    ).json();
    assert.equal(okWebhook2.ok, true);
    assert.equal(okWebhook2.deduplicated, true);

    const patRes = await (
      await req("/api/pat", "POST", { name: "mcp-worker" }, userAToken)
    ).json();
    const pat = patRes.token;

    const toolsRes = await (await req("/api/mcp/tools", "GET", undefined, pat)).json();
    assert.ok(toolsRes.tools.some((t: any) => t.name === "preview_destructive_edit"));

    const createdProj = await (
      await req(
        "/api/mcp/call",
        "POST",
        { tool: "create_project", name: "海报工程", width: 1200, height: 800 },
        pat,
      )
    ).json();
    assert.equal(createdProj.ok, true);

    assert.equal((await req("/api/mcp/call", "POST", {
      tool: "apply_destructive_edit", confirmation_token: "forged-confirmation", operation: "crop_canvas", width: 10, height: 10,
    }, pat)).status, 400);
    assert.equal((await req("/api/mcp/call", "POST", {
      tool: "rename", name: "must not overwrite without version",
    }, pat)).status, 412);

    const previewRes = await (
      await req(
        "/api/mcp/call",
        "POST",
        {
          tool: "preview_destructive_edit",
          operation: "crop_canvas",
          width: 800,
          height: 600,
        },
        pat,
      )
    ).json();
    assert.equal(previewRes.ok, true);
    assert.ok(previewRes.confirmation_token);

    const appliedRes = await (
      await req(
        "/api/mcp/call",
        "POST",
        {
          tool: "apply_destructive_edit",
          preview_id: previewRes.preview_id,
          confirmation_token: previewRes.confirmation_token,
          confirmed: true,
        },
        pat,
      )
    ).json();
    assert.equal(appliedRes.ok, true);
    assert.equal(appliedRes.project.width, 800);
    assert.equal((await req("/api/mcp/call", "POST", {
      tool: "apply_destructive_edit", preview_id: previewRes.preview_id,
      confirmation_token: previewRes.confirmation_token, confirmed: true,
    }, pat)).status, 400);

    const undoneRes = await (
      await req("/api/mcp/call", "POST", { tool: "undo_last_edit" }, pat)
    ).json();
    assert.equal(undoneRes.ok, true);
    assert.equal(undoneRes.project.width, 1200);

    const stalePreview = await (await req("/api/mcp/call", "POST", {
      tool: "preview_destructive_edit", operation: "crop_canvas", width: 500, height: 500,
    }, pat)).json();
    const renamed = await req("/api/mcp/call", "POST", {
      tool: "rename", name: "newer project",
    }, pat, { "If-Match": undoneRes.etag });
    assert.equal(renamed.status, 200);
    assert.equal((await req("/api/mcp/call", "POST", {
      tool: "apply_destructive_edit", preview_id: stalePreview.preview_id,
      confirmation_token: stalePreview.confirmation_token,
    }, pat)).status, 412);
    const finalProject = await (await req("/api/project", "GET", undefined, userAToken)).json();
    assert.equal(JSON.parse(finalProject.content).name, "newer project");
    assert.equal(JSON.parse(finalProject.content).width, 1200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
