import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
// @ts-ignore Type-free service module.
import { createService } from "../service/server.mjs";

const sample = await fs.readFile(new URL("../fixtures/shared.bgcomp", import.meta.url), "utf8");
const providers = ["wechat", "alipay", "douyin", "baidu"];
const noGrants = { sync: false, ai: false, bot: false };

async function start(directory: string, transport: (url: string, options?: any) => Promise<Response>) {
  const server = createService({
    chatIssuer: "https://chat.example",
    publicOrigin: "https://compositor.example",
    clientId: "compositor",
    dataDirectory: directory,
    hubOrigin: "https://hub.example",
    hubKey: "auth-test-hub-key",
    hubModel: "test-model",
    supportBridgeSecret: "",
  }, transport);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    request(route: string, method = "GET", data?: unknown, token?: string, etag?: string) {
      return fetch(`${base}${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(etag ? { "If-Match": etag } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve())),
  };
}

async function directoryFixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-auth-safety-"));
  try { await run(directory); }
  finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("compositor-auth-safety-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function assertNoCredentials(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["code", "verification_code", "challenge_id", "token", "access_token", "session", "authorize_url", "authorizeUrl"].includes(key), `Unavailable adapter returned ${key}`);
    assertNoCredentials(child);
  }
}

test("unimplemented SMS/email and every CN OAuth entry fail closed without codes or sessions", async () => directoryFixture(async (directory) => {
  let outbound = 0;
  const service = await start(directory, async () => {
    outbound++;
    return Response.json({});
  });
  try {
    const response = await service.request("/api/auth/channels");
    assert.equal(response.status, 200);
    const channels = await response.json();
    assert.deepEqual([...channels.channels].sort(), ["chat", "local"]);
    assert.deepEqual(channels.unavailable.map((entry: { channel: string; reason: string }) => {
      assert.equal(typeof entry.reason, "string");
      return entry.channel;
    }).sort(), [...providers, "verification_code"].sort());

    const forged = {
      target: "victim@example.com",
      email: "victim@example.com",
      phone: "+8613800000000",
      challenge_id: "forged-challenge",
      code: "123456",
      verification_code: "123456",
      state: "forged-state",
      openid: "victim-openid",
      sub: "victim-subject",
      user_id: "victim-subject",
    };
    const cases: Array<{ route: string; method: string; data?: unknown }> = [
      { route: "/api/support-bridge/inbox", method: "POST", data: { event_id: "unsigned-event" } },
      { route: "/api/support/webhook", method: "POST", data: { event_id: "unsigned-event" } },
    ];
    for (const action of ["send", "login", "verify"]) {
      cases.push({ route: `/api/auth/code/${action}`, method: "POST", data: forged });
    }
    for (const provider of providers) {
      const data = { ...forged, provider };
      for (const action of ["authorize", "callback"]) {
        const route = `/api/auth/oauth/${provider}/${action}`;
        cases.push({ route, method: "POST", data });
        cases.push({ route: `${route}?${new URLSearchParams(data)}`, method: "GET" });
      }
      cases.push({ route: "/api/auth/oauth/begin", method: "POST", data });
      cases.push({ route: "/api/auth/oauth/callback", method: "POST", data });
    }
    for (const entry of cases) {
      const result = await service.request(entry.route, entry.method, entry.data);
      assert.equal(result.status, 503, `${entry.method} ${entry.route}`);
      assert.equal(result.headers.get("set-cookie"), null);
      const value = await result.json();
      assert.equal(typeof value.error, "string");
      assertNoCredentials(value);
    }
    assert.equal(outbound, 0, "Unavailable adapters must not contact fabricated providers");
    assert.equal((await service.request("/api/project")).status, 401);
    assert.equal((await service.request("/api/project", "GET", undefined, "forged-session-token")).status, 401);
  } finally { await service.close(); }
}));

test("password identities survive restart, require grants and retain project/receipt isolation", async () => directoryFixture(async (directory) => {
  const password = "Original#Password-98765";
  const replacement = "Replacement#Password-87654";
  const transport = async (url: string) => {
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json({ choices: [{ message: { content: "Private design suggestion" } }] });
    }
    if (url.includes("/v1/usage/")) {
      return Response.json({ request_id: url.split("/").at(-1), billing_status: "settled", billed_tokens: 7, raw_tokens: 10, debit_fen: 2, currency: "USD" });
    }
    return Response.json({ data: [] });
  };
  let service = await start(directory, transport);
  try {
    const registered = await service.request("/api/auth/register", "POST", { username: "PersistentDesigner", password });
    assert.equal(registered.status, 200);
    const alice = await registered.json();
    assert.ok(alice.token);
    assert.deepEqual(alice.session.grants, noGrants);
    assert.equal((await service.request("/api/auth/register", "POST", { username: "persistentdesigner", password: replacement })).status, 409);
    assert.equal((await service.request("/api/auth/login", "POST", { username: "PersistentDesigner", password: replacement })).status, 401);
    assert.equal((await service.request("/api/project", "GET", undefined, alice.token)).status, 403);
    assert.equal((await service.request("/api/ai/text", "POST", { prompt: "Must require consent" }, alice.token)).status, 403);
    assert.equal((await service.request("/api/bot/token", "POST", {}, alice.token)).status, 403);
    assert.equal((await service.request("/api/grants", "PUT", { sync: true, ai: true, bot: true }, alice.token)).status, 200);
    const empty = await (await service.request("/api/project", "GET", undefined, alice.token)).json();
    assert.equal((await service.request("/api/project", "PUT", { content: sample }, alice.token, empty.etag)).status, 200);
    assert.equal((await service.request("/api/ai/text", "POST", { prompt: "Private design suggestion" }, alice.token)).status, 200);
    const receipts = await (await service.request("/api/ai/usage", "GET", undefined, alice.token)).json();
    assert.equal(receipts.data.length, 1);
    assert.equal(receipts.data[0].billed_tokens, 7);

    const bobResponse = await service.request("/api/auth/register", "POST", { username: "OtherDesigner", password: replacement });
    assert.equal(bobResponse.status, 200);
    const bob = await bobResponse.json();
    assert.deepEqual(bob.session.grants, noGrants);
    assert.equal((await service.request("/api/grants", "PUT", { sync: true, ai: true, bot: false }, bob.token)).status, 200);
    assert.equal((await (await service.request("/api/project", "GET", undefined, bob.token)).json()).content, null);
    assert.deepEqual((await (await service.request("/api/ai/usage", "GET", undefined, bob.token)).json()).data, []);

    await service.close();
    service = await start(directory, transport);
    assert.equal((await service.request("/api/project", "GET", undefined, alice.token)).status, 401);
    assert.equal((await service.request("/api/auth/register", "POST", { username: "PERSISTENTDESIGNER", password: replacement })).status, 409);
    for (const route of ["/api/auth/login", "/api/auth/login/password"]) {
      assert.equal((await service.request(route, "POST", { username: "persistentdesigner", password: replacement })).status, 401);
      const loggedIn = await service.request(route, "POST", { username: "persistentdesigner", password });
      assert.equal(loggedIn.status, 200);
      const returning = await loggedIn.json();
      assert.equal(returning.user_id, alice.user_id);
      assert.deepEqual(returning.session.grants, noGrants);
      assert.equal((await service.request("/api/project", "GET", undefined, returning.token)).status, 403);
      assert.equal((await service.request("/api/grants", "PUT", { sync: true, ai: true, bot: false }, returning.token)).status, 200);
      assert.equal((await (await service.request("/api/project", "GET", undefined, returning.token)).json()).content, sample);
      const restored = await (await service.request("/api/ai/usage", "GET", undefined, returning.token)).json();
      assert.equal(restored.data.length, 1);
      assert.equal(restored.data[0].request_id, receipts.data[0].request_id);
    }

    async function assertPasswordsAbsent(directoryPath: string) {
      for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
        const target = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) await assertPasswordsAbsent(target);
        else if (entry.isFile()) {
          const content = await fs.readFile(target, "utf8");
          assert.ok(!content.includes(password) && !content.includes(replacement), "Plaintext password persisted");
        }
      }
    }
    await assertPasswordsAbsent(directory);
  } finally { await service.close(); }
}));
