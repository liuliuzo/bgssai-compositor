import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseProject, MAX_PROJECT_BYTES } from "../src/project.ts";
import storage from "../electron/storage.cjs";

const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
function httpsOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("服务地址必须是 HTTPS 根地址");
  return url.origin;
}
async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_PROJECT_BYTES * 2 + 16384)
      throw fail(413, "请求超出项目预算");
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "无效 JSON");
  }
}
export function createService(config, transport = fetch) {
  const issuer = httpsOrigin(config.chatIssuer);
  const publicOrigin = httpsOrigin(config.publicOrigin);
  if (!config.clientId) throw new Error("缺少 Chat 客户端登记");
  const dataDirectory = path.resolve(config.dataDirectory);
  const sessions = new Map(),
    pending = new Map(),
    bots = new Map(),
    locks = new Map(),
    rates = new Map();
  let discovery,
    activeRequests = 0;
  const endpoint = (value) => {
    const url = new URL(value);
    if (url.origin !== issuer || url.username || url.password)
      throw fail(502, "Chat 发现地址不匹配");
    return url.href;
  };
  async function metadata() {
    if (discovery) return discovery;
    const response = await transport(
      `${issuer}/.well-known/openid-configuration`,
      { redirect: "error", signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw fail(502, "Chat 发现失败");
    const value = await response.json();
    if (
      value.issuer !== issuer ||
      !value.code_challenge_methods_supported?.includes("S256")
    )
      throw fail(502, "Chat issuer 或 PKCE 能力不匹配");
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
      "revocation_endpoint",
    ])
      endpoint(value[key]);
    return (discovery = value);
  }
  async function revoke(token) {
    if (!token) return;
    const meta = await metadata();
    const form = new URLSearchParams({ token, client_id: config.clientId });
    if (config.clientSecret) form.set("client_secret", config.clientSecret);
    const response = await transport(endpoint(meta.revocation_endpoint), {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw fail(502, "Chat 撤销失败，请重试退出");
  }
  function authorized(req, bot = false) {
    const token = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    const entry = bot ? bots.get(token) : sessions.get(token);
    const session = bot ? sessions.get(entry?.parent) : entry;
    if (
      !session ||
      session.expiresAt <= Date.now() ||
      (bot &&
        (entry.expiresAt <= Date.now() ||
          !session.grants.bot ||
          !session.grants.sync))
    )
      throw fail(401, "会话或授权已失效");
    return { token, session };
  }
  const projectPath = (session) =>
    path.join(dataDirectory, `${hash(`${issuer}\0${session.sub}`)}.bgcomp`);
  async function readProject(session) {
    try {
      const target = projectPath(session);
      if ((await stat(target)).size > MAX_PROJECT_BYTES)
        throw fail(413, "云端项目过大");
      const content = await readFile(target, "utf8");
      parseProject(content);
      return { content, etag: hash(content) };
    } catch (e) {
      if (e.code === "ENOENT") return { content: null, etag: "empty" };
      throw e;
    }
  }
  async function locked(session, fn) {
    const key = projectPath(session);
    const previous = locks.get(key) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(fn);
    locks.set(key, promise);
    try {
      return await promise;
    } finally {
      if (locks.get(key) === promise) locks.delete(key);
    }
  }
  async function saveProject(req, session, content) {
    if (!session.grants.sync) throw fail(403, "同步授权已撤销");
    parseProject(content);
    return locked(session, async () => {
      if (!session.grants.sync) throw fail(403, "同步授权已撤销");
      if (req.url.startsWith("/api/bot/") && !session.grants.bot)
        throw fail(403, "Bot 授权已撤销");
      const latest = await readProject(session);
      if (req.headers["if-match"] !== latest.etag)
        throw fail(412, "项目版本冲突");
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await storage.atomicWrite(projectPath(session), content);
      return { etag: hash(content) };
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let acquired = false;
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const now = Date.now();
      for (const [key, entry] of pending)
        if (entry.expiresAt < now) {
          pending.delete(key);
          if (entry.session && !entry.delivered) {
            sessions.delete(entry.session.token);
            void revoke(entry.chatToken).catch(() => {});
          }
        }
      for (const [key, entry] of sessions)
        if (entry.expiresAt < now) {
          sessions.delete(key);
          void revoke(entry.chatToken).catch(() => {});
        }
      for (const [key, entry] of bots)
        if (entry.expiresAt < now || !sessions.has(entry.parent))
          bots.delete(key);
      for (const [key, value] of rates)
        if (now - value.start > 60000) rates.delete(key);
      const ip = req.socket.remoteAddress;
      const rate = rates.get(ip) ?? { start: now, count: 0 };
      rate.count++;
      rates.set(ip, rate);
      if (rate.count > 120) throw fail(429, "请求过于频繁");
      if (activeRequests >= 2) throw fail(503, "服务忙，请稍后重试");
      activeRequests++;
      acquired = true;
      const origin = req.headers.origin;
      if (origin) {
        if (!config.allowedOrigins?.includes(origin))
          throw fail(403, "来源未登记");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,DELETE,OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type,If-Match",
        );
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      }
      const url = new URL(req.url, publicOrigin);
      const route = `${req.method} ${url.pathname}`;
      if (route === "POST /api/auth/begin") {
        if (pending.size >= 100 || sessions.size >= 1000)
          throw fail(429, "授权会话达到上限");
        const meta = await metadata();
        const requestId = random(),
          state = random(),
          verifier = random();
        const authorize = new URL(endpoint(meta.authorization_endpoint));
        const params = {
          client_id: config.clientId,
          response_type: "code",
          redirect_uri: `${publicOrigin}/oauth/callback`,
          scope: "openid profile",
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        };
        for (const [key, value] of Object.entries(params))
          authorize.searchParams.set(key, value);
        pending.set(requestId, { state, verifier, expiresAt: now + 600000 });
        send(200, { requestId, authorizeUrl: authorize.href });
        return;
      }
      if (route === "GET /oauth/callback") {
        const entry = [...pending.values()].find(
          (value) => value.state === url.searchParams.get("state"),
        );
        if (!entry || entry.exchanging || entry.session || entry.cancelled)
          throw fail(400, "授权状态无效或已消费");
        entry.exchanging = true;
        if (url.searchParams.has("error")) {
          entry.cancelled = true;
          throw fail(400, "用户拒绝授权");
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 4096) throw fail(400, "缺少授权码");
        const meta = await metadata();
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${publicOrigin}/oauth/callback`,
          client_id: config.clientId,
          code_verifier: entry.verifier,
        });
        if (config.clientSecret) form.set("client_secret", config.clientSecret);
        const tokenResponse = await transport(endpoint(meta.token_endpoint), {
          method: "POST",
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!tokenResponse.ok) throw fail(401, "Chat 换票失败");
        const tokens = await tokenResponse.json();
        if (
          typeof tokens.access_token !== "string" ||
          tokens.token_type?.toLowerCase() !== "bearer" ||
          !Number.isFinite(tokens.expires_in) ||
          tokens.expires_in <= 0
        )
          throw fail(502, "Chat 换票响应无效");
        entry.chatToken = tokens.access_token;
        const infoResponse = await transport(endpoint(meta.userinfo_endpoint), {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        if (!infoResponse.ok) throw fail(401, "Chat 身份验证失败");
        const info = await infoResponse.json();
        if (typeof info.sub !== "string" || !info.sub || info.sub.length > 200)
          throw fail(502, "Chat 身份缺少 sub");
        if (entry.cancelled || entry.expiresAt <= Date.now()) {
          await revoke(tokens.access_token);
          throw fail(400, "授权已取消或过期");
        }
        const token = random();
        const session = {
          sub: info.sub,
          name: String(info.nickname ?? info.name ?? info.sub).slice(0, 200),
          grants: { sync: false, ai: false, bot: false },
          expiresAt: Date.now() + Math.min(tokens.expires_in * 1000, 7200000),
          chatToken: tokens.access_token,
        };
        sessions.set(token, session);
        entry.session = { token, name: session.name, grants: session.grants };
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Compositor 授权完成</title><p>授权完成。请返回 Compositor 开启所需功能。</p></html>',
        );
        return;
      }
      if (
        route === "POST /api/auth/poll" ||
        route === "POST /api/auth/cancel"
      ) {
        const { requestId } = await body(req);
        const entry = pending.get(requestId);
        if (route.endsWith("/cancel") && (!entry || entry.cancelled)) {
          send(200, { ok: true });
          return;
        }
        if (!entry || entry.cancelled) throw fail(410, "授权已取消或过期");
        if (route.endsWith("/cancel")) {
          entry.cancelled = true;
          if (entry.session) {
            sessions.delete(entry.session.token);
            await revoke(entry.chatToken).catch(() => {});
          }
          send(200, { ok: true });
        } else if (entry.session) {
          entry.delivered = true;
          send(200, { session: entry.session });
        } else send(200, { session: null });
        return;
      }
      const isBot =
        url.pathname.startsWith("/api/bot/") && route !== "POST /api/bot/token";
      const { token, session } = authorized(req, isBot);
      if (route === "DELETE /api/session") {
        sessions.delete(token);
        for (const [key, value] of bots)
          if (value.parent === token) bots.delete(key);
        const chatRevoked = await revoke(session.chatToken).then(
          () => true,
          () => false,
        );
        send(200, { ok: true, chatRevoked });
        return;
      }
      if (route === "PUT /api/grants") {
        const grants = await body(req);
        if (
          !["sync", "ai", "bot"].every(
            (key) => typeof grants[key] === "boolean",
          )
        )
          throw fail(400, "授权无效");
        session.grants = { sync: grants.sync, ai: grants.ai, bot: grants.bot };
        if (!grants.bot || !grants.sync)
          for (const [key, value] of bots)
            if (value.parent === token) bots.delete(key);
        if (!grants.sync)
          await locked(session, () =>
            unlink(projectPath(session)).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            }),
          );
        send(200, { ok: true });
        return;
      }
      if (route === "GET /api/project" || route === "GET /api/bot/project") {
        if (!session.grants.sync) throw fail(403, "同步未授权");
        send(200, await readProject(session));
        return;
      }
      if (route === "PUT /api/project") {
        const data = await body(req);
        send(200, await saveProject(req, session, data.content));
        return;
      }
      if (route === "POST /api/bot/token") {
        if (!session.grants.bot || !session.grants.sync)
          throw fail(403, "请先开启同步和 Bot 授权");
        for (const [key, value] of bots)
          if (value.parent === token) bots.delete(key);
        const botToken = random();
        bots.set(botToken, { parent: token, expiresAt: now + 3600000 });
        send(200, { token: botToken });
        return;
      }
      if (route === "POST /api/bot/operate") {
        const data = await body(req);
        const latest = await readProject(session);
        if (!latest.content) throw fail(404, "暂无项目");
        const project = parseProject(latest.content);
        if (data.action === "rename" && typeof data.name === "string")
          project.name = data.name.slice(0, 200);
        else if (data.action === "layer") {
          const layer = project.layers.find((value) => value.id === data.id);
          if (!layer || layer.locked) throw fail(400, "图层不存在或已锁定");
          if (data.visible !== undefined) {
            if (typeof data.visible !== "boolean")
              throw fail(400, "显隐值无效");
            layer.visible = data.visible;
          }
          if (data.opacity !== undefined) {
            if (
              typeof data.opacity !== "number" ||
              !Number.isFinite(data.opacity) ||
              data.opacity < 0 ||
              data.opacity > 1
            )
              throw fail(400, "不透明度无效");
            layer.opacity = data.opacity;
          }
        } else throw fail(400, "不支持的 Bot 操作");
        send(200, await saveProject(req, session, JSON.stringify(project)));
        return;
      }
      if (route === "POST /api/ai/text") {
        if (!session.grants.ai) throw fail(403, "AI 未授权");
        if (!config.hubOrigin || !config.hubKey || !config.hubModel)
          throw fail(503, "TokenHub 尚未配置");
        const { prompt } = await body(req);
        if (
          typeof prompt !== "string" ||
          !prompt.trim() ||
          prompt.length > 4000
        )
          throw fail(400, "提示词无效");
        const response = await transport(
          `${httpsOrigin(config.hubOrigin)}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.hubKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.hubModel,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok) throw fail(502, "TokenHub 请求失败");
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.length > 10000)
          throw fail(502, "TokenHub 返回无效内容");
        if (!session.grants.ai || !sessions.has(token))
          throw fail(403, "AI 授权已撤销");
        send(200, { text });
        return;
      }
      throw fail(404, "接口不存在");
    } catch (error) {
      if (!res.headersSent)
        send(error.status ?? 400, {
          error: error.status ? error.message : "请求无效或存储失败",
        });
      else res.end();
    } finally {
      if (acquired) activeRequests--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const environment = process.env.APP_ENV === "dev" ? "dev" : "prod";
  const text = await readFile(
    new URL(`../config/application-${environment}.properties`, import.meta.url),
    "utf8",
  );
  const properties = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const server = createService({
    chatIssuer: properties["chat.issuer"],
    publicOrigin: properties["ecosystem.url"],
    clientId: properties["chat.client-id"],
    clientSecret: process.env.COMPOSITOR_CHAT_CLIENT_SECRET,
    dataDirectory: process.env.COMPOSITOR_DATA_DIRECTORY ?? "./service-data",
    allowedOrigins: [
      "capacitor://localhost",
      "https://localhost",
      properties["ecosystem.url"],
      ...(environment === "dev" ? ["http://127.0.0.1:5173"] : []),
    ],
    hubOrigin: properties["hub.url"],
    hubKey: process.env.COMPOSITOR_HUB_KEY,
    hubModel: properties["hub.model"],
  });
  server.listen(Number(properties["service.port"] ?? 8787), "127.0.0.1", () =>
    console.log(`Compositor ${environment} service listening on loopback`),
  );
}
