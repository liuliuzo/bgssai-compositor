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
