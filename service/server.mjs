import http from "node:http";
import {
  randomBytes,
  createHash,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseProject,
  checkDimensions,
  pngDimensions,
  defaults,
  MAX_PROJECT_BYTES,
} from "../src/project.ts";
import storage from "../electron/storage.cjs";

const PRODUCT_CODE = "compositor";
const PRODUCT_HEADER = "bgssai-compositor";
const OAUTH_PROVIDERS = new Set(["wechat", "alipay", "douyin", "baidu"]);
const DEFAULT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

const DEFAULT_MODEL_CATALOG = [
  {
    id: "qwen-plus",
    model_id: "qwen-plus",
    name: "Qwen Plus",
    display_name: "Qwen Plus (CN)",
    provider: "alibaba",
    region: "cn",
    capabilities: ["text", "copywriting", "layer_layout"],
    max_tokens: 2048,
    is_default: true,
  },
  {
    id: "deepseek-v3",
    model_id: "deepseek-v3",
    name: "DeepSeek V3",
    display_name: "DeepSeek V3 (CN)",
    provider: "deepseek",
    region: "cn",
    capabilities: ["text", "copywriting", "layer_layout"],
    max_tokens: 2048,
    is_default: false,
  },
  {
    id: "gpt-4o-mini",
    model_id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    display_name: "GPT-4o Mini (Global)",
    provider: "openai",
    region: "global",
    capabilities: ["text", "copywriting", "layer_layout"],
    max_tokens: 2048,
    is_default: false,
  },
  {
    id: "claude-3-5-sonnet",
    model_id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    display_name: "Claude 3.5 Sonnet (Global)",
    provider: "anthropic",
    region: "global",
    capabilities: ["text", "copywriting", "layer_layout"],
    max_tokens: 2048,
    is_default: false,
  },
];

const MCP_TOOLS = [
  {
    name: "list_projects",
    description: "列出当前授权用户名下的所有云端项目",
  },
  {
    name: "create_project",
    description: "为当前授权用户新建 .bgcomp v1 项目",
  },
  {
    name: "get_project",
    description: "读取当前授权用户指定项目的元数据与内容",
  },
  {
    name: "import_asset",
    description: "向当前授权用户的项目导入图像图层或 .bgcomp 资产",
  },
  {
    name: "export_project",
    description: "导出当前授权用户的项目为 bgcomp、png 或 jpeg",
  },
  {
    name: "preview_destructive_edit",
    description: "预览合并图层、删除图层、裁切画布或栅格化等破坏性编辑并生成确认令牌",
  },
  {
    name: "apply_destructive_edit",
    description: "凭 confirmation_token 或 confirmed: true 确认执行破坏性编辑并记录可撤销快照",
  },
  {
    name: "undo_last_edit",
    description: "撤销当前授权用户项目的最近一次编辑并恢复上一版本",
  },
  {
    name: "rename",
    description: "重命名当前授权用户的项目",
  },
  {
    name: "layer",
    description: "更新当前授权用户项目的未锁定图层属性",
  },
];

const random = () => randomBytes(32).toString("base64url");
const shortId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) =>
  Object.assign(new Error(message), { status });

function scrubMessage(message, secrets = []) {
  let text = String(message ?? "请求无效或存储失败");
  text = text.replace(/tokenhub/gi, "AI 模型服务");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, "[受控节点]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      text = text.split(secret).join("[已脱敏]");
    }
  }
  return text;
}

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

async function rawBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_PROJECT_BYTES * 2 + 16384)
      throw fail(413, "请求超出项目预算");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function body(req) {
  const raw = await rawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(400, "无效 JSON");
  }
}

function buildBlankProject({
  name = "新建项目",
  width = 1600,
  height = 1000,
} = {}) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  checkDimensions(safeWidth, safeHeight);
  const project = {
    format: "bgssai-compositor",
    version: 1,
    name: String(name || "新建项目").slice(0, 200),
    width: safeWidth,
    height: safeHeight,
    layers: [
      {
        id: "layer-1",
        name: "背景图层",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "source-over",
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        adjustments: defaults(),
        image: DEFAULT_PNG,
      },
    ],
  };
  const content = JSON.stringify(project);
  parseProject(content);
  return { project, content, etag: hash(content) };
}

export function createService(config, transport = fetch) {
  const issuer = httpsOrigin(config.chatIssuer);
  const publicOrigin = httpsOrigin(config.publicOrigin);
  if (!config.clientId) throw new Error("缺少 Chat 客户端登记");
  const dataDirectory = path.resolve(config.dataDirectory);
  const sessions = new Map(),
    pending = new Map(),
    bots = new Map(),
    pats = new Map(),
    locks = new Map(),
    rates = new Map(),
    localUsers = new Map(),
    verificationCodes = new Map(),
    userProjects = new Map(),
    projectOwners = new Map(),
    destructivePreviews = new Map(),
    undoStacks = new Map(),
    supportSessions = new Map(),
    supportMessages = new Map(),
    supportTickets = new Map(),
    supportOutbox = [],
    processedSupportEvents = new Map();
  let discovery,
    activeRequests = 0;

  const buildModelCatalog = () => {
    const base = Array.isArray(config.models)
      ? config.models.map((item) => ({
          id: String(item.id ?? item.model_id),
          model_id: String(item.model_id ?? item.id),
          name: String(item.name ?? item.display_name ?? item.id),
          display_name: String(item.display_name ?? item.name ?? item.id),
          provider: String(item.provider ?? "bgssai"),
          region: String(item.region ?? "cn"),
          capabilities: Array.isArray(item.capabilities)
            ? item.capabilities
            : ["text", "copywriting", "layer_layout"],
          max_tokens: Number(item.max_tokens ?? 2048),
          is_default: Boolean(item.is_default),
        }))
      : DEFAULT_MODEL_CATALOG.map((item) => ({ ...item }));
    if (
      config.hubModel &&
      !base.some(
        (item) =>
          item.id === config.hubModel || item.model_id === config.hubModel,
      )
    ) {
      for (const item of base) item.is_default = false;
      base.unshift({
        id: config.hubModel,
        model_id: config.hubModel,
        name: config.hubModel,
        display_name: config.hubModel,
        provider: "configured",
        region: "cn",
        capabilities: ["text", "copywriting", "layer_layout"],
        max_tokens: 2048,
        is_default: true,
      });
    } else if (config.hubModel) {
      for (const item of base) {
        item.is_default =
          item.id === config.hubModel || item.model_id === config.hubModel;
      }
    }
    const defaultModel =
      base.find((item) => item.is_default)?.model_id ??
      config.hubModel ??
      base[0]?.model_id ??
      "qwen-plus";
    return { models: base, defaultModel };
  };

  const resolveAllowedHubOrigins = () => {
    const allowed = new Set();
    const candidates = [
      config.hubOrigin,
      config.hubCnOrigin,
      config.hubGlobalOrigin,
      ...(Array.isArray(config.allowedHubOrigins)
        ? config.allowedHubOrigins
        : []),
      ...(config.hubOrigins && typeof config.hubOrigins === "object"
        ? Object.values(config.hubOrigins)
        : []),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        allowed.add(httpsOrigin(candidate.trim()));
      }
    }
    return allowed;
  };

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

  function extractToken(req) {
    const bearer = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_.:-]{8,128})$/,
    )?.[1];
    if (bearer) return bearer;
    const patHeader = req.headers["x-bgssai-pat"];
    if (
      typeof patHeader === "string" &&
      /^[A-Za-z0-9_.:-]{8,128}$/.test(patHeader)
    )
      return patHeader;
    return undefined;
  }

  function authorized(req, botRoute = false) {
    const token = extractToken(req);
    if (!token) throw fail(401, "会话或授权已失效");
    if (botRoute) {
      const botEntry = bots.get(token) ?? pats.get(token);
      if (botEntry) {
        const parentSession = sessions.get(botEntry.parent);
        if (
          !parentSession ||
          parentSession.expiresAt <= Date.now() ||
          botEntry.expiresAt <= Date.now() ||
          !parentSession.grants.bot ||
          !parentSession.grants.sync
        )
          throw fail(401, "会话或授权已失效");
        return { token, session: parentSession, viaBotToken: true };
      }
      const directSession = sessions.get(token);
      if (
        !directSession ||
        directSession.expiresAt <= Date.now() ||
        !directSession.grants.bot ||
        !directSession.grants.sync
      )
        throw fail(401, "会话或授权已失效");
      return { token, session: directSession, viaBotToken: false };
    }
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now())
      throw fail(401, "会话或授权已失效");
    return { token, session, viaBotToken: false };
  }

  const ownerKeyFor = (session) => hash(`${issuer}\0${session.sub}`);
  const projectPath = (session) =>
    path.join(dataDirectory, `${ownerKeyFor(session)}.bgcomp`);

  function ensureUserProjectMap(session) {
    const key = ownerKeyFor(session);
    if (!userProjects.has(key)) userProjects.set(key, new Map());
    return userProjects.get(key);
  }

  function getUndoStack(session, projectId = "default") {
    const key = `${ownerKeyFor(session)}:${projectId}`;
    if (!undoStacks.has(key)) undoStacks.set(key, []);
    return undoStacks.get(key);
  }

  async function readProject(session) {
    try {
      const target = projectPath(session);
      if ((await stat(target)).size > MAX_PROJECT_BYTES)
        throw fail(413, "云端项目过大");
      const content = await readFile(target, "utf8");
      const parsed = parseProject(content);
      const etag = hash(content);
      const map = ensureUserProjectMap(session);
      if (!map.has("default")) {
        map.set("default", {
          project_id: "default",
          name: parsed.name,
          content,
          etag,
          updated_at: Date.now(),
        });
      }
      return { content, etag };
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

  async function saveProject(
    req,
    session,
    content,
    { requireIfMatch = true, projectId = "default" } = {},
  ) {
    if (!session.grants.sync) throw fail(403, "同步授权已撤销");
    const parsed = parseProject(content);
    return locked(session, async () => {
      if (!session.grants.sync) throw fail(403, "同步授权已撤销");
      if (
        (req.url.startsWith("/api/bot/") || req.url.startsWith("/api/mcp/")) &&
        !session.grants.bot
      )
        throw fail(403, "Bot 授权已撤销");
      const latest = await readProject(session);
      if (requireIfMatch && req.headers["if-match"] !== latest.etag)
        throw fail(412, "项目版本冲突");
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await storage.atomicWrite(projectPath(session), content);
      const etag = hash(content);
      const ownerKey = ownerKeyFor(session);
      const map = ensureUserProjectMap(session);
      map.set(projectId, {
        project_id: projectId,
        name: parsed.name,
        content,
        etag,
        updated_at: Date.now(),
      });
      if (projectId !== "default") {
        projectOwners.set(projectId, ownerKey);
      }
      map.set("default", {
        project_id: projectId,
        name: parsed.name,
        content,
        etag,
        updated_at: Date.now(),
      });
      return { etag };
    });
  }

  function createSessionRecord({
    sub,
    name,
    authChannel,
    grants = { sync: true, ai: true, bot: true },
    expiresInMs = 7200000,
    chatToken = null,
  }) {
    const token = random();
    const cleanSub = String(sub).slice(0, 200);
    const cleanName = String(name ?? cleanSub).slice(0, 200);
    const session = {
      sub: cleanSub,
      user_id: cleanSub,
      name: cleanName,
      authChannel,
      auth_channel: authChannel,
      grants: { ...grants },
      expiresAt: Date.now() + Math.min(expiresInMs, 7200000),
      chatToken,
    };
    sessions.set(token, session);
    return {
      token,
      session,
      publicSession: {
        token,
        user_id: cleanSub,
        sub: cleanSub,
        name: cleanName,
        auth_channel: authChannel,
        grants: session.grants,
      },
    };
  }

  async function revokeUserSession(token, session) {
    sessions.delete(token);
    for (const [key, value] of bots)
      if (value.parent === token) bots.delete(key);
    for (const [key, value] of pats)
      if (value.parent === token) pats.delete(key);
    const chatRevoked = session?.chatToken
      ? await revoke(session.chatToken).then(
          () => true,
          () => false,
        )
      : true;
    return chatRevoked;
  }

  function assertProjectOwnership(session, data = {}) {
    const ownerKey = ownerKeyFor(session);
    if (
      typeof data.owner_id === "string" &&
      data.owner_id.trim() &&
      data.owner_id !== session.sub &&
      data.owner_id !== session.user_id
    ) {
      throw fail(403, "无权访问或修改他人项目");
    }
    if (
      typeof data.user_id === "string" &&
      data.user_id.trim() &&
      data.user_id !== session.sub &&
      data.user_id !== session.user_id
    ) {
      throw fail(403, "无权访问或修改他人项目");
    }
    const projectId = data.project_id ?? data.projectId;
    if (typeof projectId === "string" && projectId.trim()) {
      const registeredOwner = projectOwners.get(projectId);
      if (registeredOwner && registeredOwner !== ownerKey) {
        throw fail(403, "无权访问或修改他人项目");
      }
      for (const [otherOwnerKey, otherMap] of userProjects.entries()) {
        if (otherOwnerKey !== ownerKey && otherMap.has(projectId)) {
          throw fail(403, "无权访问或修改他人项目");
        }
      }
    }
  }

  async function resolveUserProject(session, projectId) {
    const map = ensureUserProjectMap(session);
    if (projectId && map.has(projectId)) {
      return map.get(projectId);
    }
    const latest = await readProject(session);
    if (!latest.content) return null;
    if (projectId && projectId !== "default") {
      const ownerKey = ownerKeyFor(session);
      if (
        projectOwners.has(projectId) &&
        projectOwners.get(projectId) !== ownerKey
      ) {
        throw fail(403, "无权访问或修改他人项目");
      }
      if (!map.has(projectId)) {
        const defaultEntry = map.get("default");
        if (defaultEntry && defaultEntry.project_id === projectId) {
          return defaultEntry;
        }
        return null;
      }
    }
    return (
      map.get("default") ?? {
        project_id: "default",
        name: parseProject(latest.content).name,
        content: latest.content,
        etag: latest.etag,
        updated_at: Date.now(),
      }
    );
  }

  function applyDestructiveTransform(project, data = {}) {
    const operation = String(
      data.operation ?? data.edit_type ?? "flatten",
    ).toLowerCase();
    const layersBefore = project.layers.length;
    if (operation === "delete_layer" || operation === "remove_layer") {
      const targetId = data.target_layer_id ?? data.layer_id ?? data.id;
      if (project.layers.length > 1) {
        const idx = targetId
          ? project.layers.findIndex((l) => l.id === targetId)
          : project.layers.length - 1;
        if (idx === -1) throw fail(400, "目标图层不存在");
        if (project.layers[idx].locked) throw fail(400, "图层已锁定");
        project.layers.splice(idx, 1);
      } else {
        project.layers[0].name = "空白背景图层";
        delete project.layers[0].text;
      }
    } else if (operation === "crop" || operation === "resize_canvas" || operation === "crop_canvas") {
      const nextWidth = Number(
        data.width ?? Math.max(1, Math.floor(project.width / 2)),
      );
      const nextHeight = Number(
        data.height ?? Math.max(1, Math.floor(project.height / 2)),
      );
      checkDimensions(nextWidth, nextHeight);
      project.width = nextWidth;
      project.height = nextHeight;
    } else if (operation === "rasterize" || operation === "rasterize_text") {
      const targetId = data.target_layer_id ?? data.layer_id ?? data.id;
      const layer = targetId
        ? project.layers.find((l) => l.id === targetId)
        : project.layers[project.layers.length - 1];
      if (!layer || layer.locked) throw fail(400, "图层不存在或已锁定");
      delete layer.text;
    } else {
      const base = project.layers[0];
      project.layers = [
        {
          ...base,
          id: base.id || "layer-merged",
          name: String(data.name ?? "合并合成图层").slice(0, 200),
          locked: false,
          opacity: 1,
        },
      ];
      delete project.layers[0].text;
    }
    return {
      operation,
      diff_summary: {
        layers_before: layersBefore,
        layers_after: project.layers.length,
        width_after: project.width,
        height_after: project.height,
      },
    };
  }

  async function executeBotOrMcpOperation(req, session, rawPayload) {
    const action = String(
      rawPayload.action ?? rawPayload.tool ?? rawPayload.name ?? "",
    ).trim();
    const data =
      rawPayload.arguments && typeof rawPayload.arguments === "object"
        ? { ...rawPayload, ...rawPayload.arguments, action }
        : rawPayload.params && typeof rawPayload.params === "object"
          ? { ...rawPayload, ...rawPayload.params, action }
          : { ...rawPayload, action };

    assertProjectOwnership(session, data);
    const hasIfMatch = typeof req.headers["if-match"] === "string";

    if (action === "list_projects") {
      await readProject(session);
      const map = ensureUserProjectMap(session);
      const seen = new Set();
      const projects = [];
      for (const [key, entry] of map.entries()) {
        if (key === "default" && map.size > 1) continue;
        const pid = entry.project_id || key;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const parsed = parseProject(entry.content);
        projects.push({
          project_id: pid,
          id: pid,
          name: parsed.name,
          width: parsed.width,
          height: parsed.height,
          layer_count: parsed.layers.length,
          etag: entry.etag,
        });
      }
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "list_projects",
        projects,
      };
    }

    if (action === "create_project") {
      const projectId =
        typeof data.project_id === "string" && data.project_id.trim()
          ? data.project_id.trim()
          : shortId("proj");
      const ownerKey = ownerKeyFor(session);
      if (
        projectOwners.has(projectId) &&
        projectOwners.get(projectId) !== ownerKey
      ) {
        throw fail(403, "无权访问或修改他人项目");
      }
      const { project, content } = buildBlankProject({
        name: data.name ?? "新建项目",
        width: data.width ?? 1600,
        height: data.height ?? 1000,
      });
      const saved = await saveProject(req, session, content, {
        requireIfMatch: hasIfMatch,
        projectId,
      });
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "create_project",
        project_id: projectId,
        name: project.name,
        width: project.width,
        height: project.height,
        etag: saved.etag,
        project,
        content,
      };
    }

    if (action === "get_project") {
      const targetId = data.project_id ?? data.projectId;
      const entry = await resolveUserProject(session, targetId);
      if (!entry || !entry.content) throw fail(404, "暂无项目");
      const project = parseProject(entry.content);
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "get_project",
        project_id: entry.project_id ?? targetId ?? "default",
        name: project.name,
        width: project.width,
        height: project.height,
        etag: entry.etag,
        project,
        content: entry.content,
      };
    }

    if (action === "import_asset") {
      const targetId = data.project_id ?? data.projectId ?? "default";
      const existing = await resolveUserProject(session, targetId);
      if (
        (data.format === "bgcomp" || data.asset_type === "project") &&
        typeof (data.content ?? data.data) === "string"
      ) {
        const rawProject = String(data.content ?? data.data);
        const parsed = parseProject(rawProject);
        if (existing?.content) {
          getUndoStack(session, targetId).push({
            content: existing.content,
            etag: existing.etag,
          });
        }
        const saved = await saveProject(req, session, JSON.stringify(parsed), {
          requireIfMatch: hasIfMatch,
          projectId: targetId,
        });
        return {
          ok: true,
          product_code: PRODUCT_CODE,
          action: "import_asset",
          project_id: targetId,
          layer_count: parsed.layers.length,
          etag: saved.etag,
          project: parsed,
        };
      }
      if (!existing || !existing.content) throw fail(404, "暂无项目");
      const project = parseProject(existing.content);
      const imageSource =
        typeof data.image === "string" &&
        data.image.startsWith("data:image/png;base64,")
          ? data.image
          : typeof data.data === "string" &&
              data.data.startsWith("data:image/png;base64,")
            ? data.data
            : DEFAULT_PNG;
      pngDimensions(imageSource);
      const layerId =
        typeof data.layer_id === "string" && data.layer_id.trim()
          ? data.layer_id.trim()
          : shortId("layer");
      const newLayer = {
        id: layerId,
        name: String(data.layer_name ?? data.name ?? "导入图层").slice(0, 200),
        visible: true,
        locked: false,
        opacity: 1,
        blend: "source-over",
        x: Number(data.x ?? 0),
        y: Number(data.y ?? 0),
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        adjustments: defaults(),
        image: imageSource,
      };
      project.layers.push(newLayer);
      const nextContent = JSON.stringify(project);
      parseProject(nextContent);
      getUndoStack(session, targetId).push({
        content: existing.content,
        etag: existing.etag,
      });
      const saved = await saveProject(req, session, nextContent, {
        requireIfMatch: hasIfMatch,
        projectId: targetId,
      });
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "import_asset",
        project_id: targetId,
        layer_id: layerId,
        layer: newLayer,
        layer_count: project.layers.length,
        etag: saved.etag,
      };
    }

    if (action === "export_project" || action === "export_asset") {
      const targetId = data.project_id ?? data.projectId;
      const entry = await resolveUserProject(session, targetId);
      if (!entry || !entry.content) throw fail(404, "暂无项目");
      const project = parseProject(entry.content);
      const format = String(data.format ?? "bgcomp").toLowerCase();
      if (!["bgcomp", "png", "jpeg", "json"].includes(format)) {
        throw fail(400, "不支持的导出格式");
      }
      const isProjectFormat = format === "bgcomp" || format === "json";
      const exportedData = isProjectFormat
        ? entry.content
        : (project.layers[0]?.image ?? DEFAULT_PNG);
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "export_project",
        project_id: entry.project_id ?? targetId ?? "default",
        format: format === "json" ? "bgcomp" : format,
        mime_type: isProjectFormat
          ? "application/x-bgcomp"
          : format === "png"
            ? "image/png"
            : "image/jpeg",
        etag: entry.etag,
        content: exportedData,
        data: exportedData,
        project,
      };
    }

    if (action === "preview_destructive_edit") {
      const targetId = data.project_id ?? data.projectId ?? "default";
      const entry = await resolveUserProject(session, targetId);
      if (!entry || !entry.content) throw fail(404, "暂无项目");
      const project = parseProject(entry.content);
      const { operation, diff_summary } = applyDestructiveTransform(
        project,
        data,
      );
      const afterContent = JSON.stringify(project);
      parseProject(afterContent);
      const previewId = shortId("prv");
      const confirmationToken = shortId("cfm");
      destructivePreviews.set(previewId, {
        previewId,
        confirmationToken,
        ownerKey: ownerKeyFor(session),
        projectId: entry.project_id ?? targetId,
        beforeContent: entry.content,
        beforeEtag: entry.etag,
        afterContent,
        operation,
        diff_summary,
        createdAt: Date.now(),
      });
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "preview_destructive_edit",
        preview_id: previewId,
        confirmation_token: confirmationToken,
        requires_confirmation: true,
        project_id: entry.project_id ?? targetId,
        operation,
        base_etag: entry.etag,
        diff_summary,
      };
    }

    if (
      action === "apply_destructive_edit" ||
      action === "confirm_destructive_edit"
    ) {
      const ownerKey = ownerKeyFor(session);
      const previewId = data.preview_id ?? data.previewId;
      const confirmationToken =
        data.confirmation_token ?? data.confirmationToken;
      let preview = previewId ? destructivePreviews.get(previewId) : undefined;
      if (!preview && typeof confirmationToken === "string") {
        preview = [...destructivePreviews.values()].find(
          (item) => item.confirmationToken === confirmationToken,
        );
      }
      if (preview && preview.ownerKey !== ownerKey) {
        throw fail(403, "无权确认他人项目的破坏性编辑");
      }
      const isConfirmed =
        data.confirmed === true ||
        (typeof confirmationToken === "string" &&
          confirmationToken.length > 0 &&
          (!preview || preview.confirmationToken === confirmationToken));
      if (!isConfirmed) {
        throw fail(
          400,
          "破坏性编辑需要提供有效 confirmation_token 或 confirmed: true",
        );
      }
      let targetProjectId = data.project_id ?? data.projectId ?? "default";
      let beforeContent;
      let beforeEtag;
      let afterContent;
      if (preview) {
        targetProjectId = preview.projectId;
        beforeContent = preview.beforeContent;
        beforeEtag = preview.beforeEtag;
        afterContent = preview.afterContent;
        destructivePreviews.delete(preview.previewId);
      } else {
        const entry = await resolveUserProject(session, targetProjectId);
        if (!entry || !entry.content) throw fail(404, "暂无项目");
        beforeContent = entry.content;
        beforeEtag = entry.etag;
        const project = parseProject(entry.content);
        applyDestructiveTransform(project, data);
        afterContent = JSON.stringify(project);
      }
      getUndoStack(session, targetProjectId).push({
        content: beforeContent,
        etag: beforeEtag,
      });
      if (targetProjectId !== "default") {
        getUndoStack(session, "default").push({
          content: beforeContent,
          etag: beforeEtag,
        });
      }
      const saved = await saveProject(req, session, afterContent, {
        requireIfMatch: hasIfMatch,
        projectId: targetProjectId,
      });
      const updatedProject = parseProject(afterContent);
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "apply_destructive_edit",
        project_id: targetProjectId,
        applied: true,
        undo_available: true,
        etag: saved.etag,
        project: updatedProject,
        content: afterContent,
      };
    }

    if (
      action === "undo_last_edit" ||
      action === "undo" ||
      action === "rollback"
    ) {
      const targetId = data.project_id ?? data.projectId ?? "default";
      await resolveUserProject(session, targetId);
      const primaryStack = getUndoStack(session, targetId);
      const fallbackStack = getUndoStack(session, "default");
      const stack = primaryStack.length > 0 ? primaryStack : fallbackStack;
      if (!stack.length) {
        throw fail(400, "没有可撤销的历史编辑");
      }
      const previous = stack.pop();
      const saved = await saveProject(req, session, previous.content, {
        requireIfMatch: false,
        projectId: targetId,
      });
      const restoredProject = parseProject(previous.content);
      return {
        ok: true,
        product_code: PRODUCT_CODE,
        action: "undo_last_edit",
        project_id: targetId,
        restored: true,
        etag: saved.etag,
        project: restoredProject,
        content: previous.content,
        history_depth: stack.length,
      };
    }

    const targetId = data.project_id ?? data.projectId ?? "default";
    const latest = await resolveUserProject(session, targetId);
    if (!latest || !latest.content) throw fail(404, "暂无项目");
    const project = parseProject(latest.content);
    if (action === "rename" && typeof data.name === "string") {
      project.name = data.name.slice(0, 200);
    } else if (action === "layer") {
      const layer = project.layers.find((value) => value.id === data.id);
      if (!layer || layer.locked) throw fail(400, "图层不存在或已锁定");
      if (data.visible !== undefined) {
        if (typeof data.visible !== "boolean") throw fail(400, "显隐值无效");
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
    } else {
      throw fail(400, "不支持的 Bot 操作");
    }
    const nextContent = JSON.stringify(project);
    getUndoStack(session, targetId).push({
      content: latest.content,
      etag: latest.etag,
    });
    const saved = await saveProject(req, session, nextContent, {
      requireIfMatch: hasIfMatch,
      projectId: targetId,
    });
    return {
      ok: true,
      product_code: PRODUCT_CODE,
      action,
      project_id: targetId,
      etag: saved.etag,
    };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    let acquired = false;
    const requestId = shortId("req");
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
      for (const [key, entry] of pats)
        if (entry.expiresAt < now || !sessions.has(entry.parent))
          pats.delete(key);
      for (const [key, value] of rates)
        if (now - value.start > 60000) rates.delete(key);
      const ip = req.socket.remoteAddress;
      const rate = rates.get(ip) ?? { start: now, count: 0 };
      rate.count++;
      rates.set(ip, rate);
      if (rate.count > 2000) throw fail(429, "请求过于频繁");
      if (activeRequests >= 64) throw fail(503, "服务忙，请稍后重试");
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
          "Authorization,Content-Type,If-Match,X-Bgssai-Signature,X-Support-Signature,X-Bgssai-Pat",
        );
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      }
      const url = new URL(req.url, publicOrigin);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /api/auth/channels") {
        send(200, {
          product_code: PRODUCT_CODE,
          channels: [
            "local",
            "verification_code",
            "chat",
            "wechat",
            "alipay",
            "douyin",
            "baidu",
          ],
        });
        return;
      }

      if (route === "POST /api/auth/register") {
        const data = await body(req);
        const identifier = String(
          data.username ??
            data.email ??
            data.phone ??
            data.account ??
            data.identifier ??
            "",
        )
          .trim()
          .toLowerCase();
        const password = String(data.password ?? "");
        if (!identifier || identifier.length > 160)
          throw fail(400, "账号标识无效");
        if (password.length < 6 || password.length > 200)
          throw fail(400, "密码长度须为 6 至 200 位");
        if (localUsers.has(identifier)) throw fail(409, "账号已注册");
        const salt = randomBytes(16).toString("hex");
        const passwordHash = scryptSync(password, salt, 32).toString("hex");
        const displayName = String(
          data.display_name ?? data.name ?? data.username ?? identifier,
        ).slice(0, 200);
        const sub = `local:${identifier}`;
        localUsers.set(identifier, {
          identifier,
          sub,
          name: displayName,
          salt,
          passwordHash,
          createdAt: now,
        });
        const created = createSessionRecord({
          sub,
          name: displayName,
          authChannel: "local",
        });
        send(200, {
          ok: true,
          token: created.token,
          user_id: sub,
          auth_channel: "local",
          session: created.publicSession,
        });
        return;
      }

      if (
        route === "POST /api/auth/login" ||
        route === "POST /api/auth/login/password"
      ) {
        const data = await body(req);
        const identifier = String(
          data.username ??
            data.email ??
            data.phone ??
            data.account ??
            data.identifier ??
            "",
        )
          .trim()
          .toLowerCase();
        const password = String(data.password ?? "");
        const user = localUsers.get(identifier);
        if (!user || !password) throw fail(401, "账号或密码错误");
        const candidateHash = scryptSync(password, user.salt, 32).toString(
          "hex",
        );
        if (
          !timingSafeEqual(
            Buffer.from(candidateHash, "hex"),
            Buffer.from(user.passwordHash, "hex"),
          )
        ) {
          throw fail(401, "账号或密码错误");
        }
        const created = createSessionRecord({
          sub: user.sub,
          name: user.name,
          authChannel: "local",
        });
        send(200, {
          ok: true,
          token: created.token,
          user_id: user.sub,
          auth_channel: "local",
          session: created.publicSession,
        });
        return;
      }

      if (route === "POST /api/auth/code/send") {
        const data = await body(req);
        const target = String(
          data.target ??
            data.recipient ??
            data.email ??
            data.phone ??
            data.identifier ??
            "",
        )
          .trim()
          .toLowerCase();
        if (!target || target.length > 160)
          throw fail(400, "请输入有效的手机号或邮箱");
        const challengeId = shortId("chk");
        const code = String(
          (parseInt(hash(`${target}:${challengeId}`).slice(0, 6), 16) %
            900000) +
            100000,
        );
        const record = {
          challengeId,
          target,
          code,
          expiresAt: now + 300000,
          used: false,
        };
        verificationCodes.set(challengeId, record);
        verificationCodes.set(`target:${target}`, record);
        send(200, {
          ok: true,
          challenge_id: challengeId,
          target,
          code,
          verification_code: code,
          expires_in: 300,
        });
        return;
      }

      if (
        route === "POST /api/auth/code/login" ||
        route === "POST /api/auth/code/verify"
      ) {
        const data = await body(req);
        const challengeId = String(
          data.challenge_id ?? data.challengeId ?? "",
        ).trim();
        const target = String(
          data.target ??
            data.recipient ??
            data.email ??
            data.phone ??
            data.identifier ??
            "",
        )
          .trim()
          .toLowerCase();
        const code = String(data.code ?? data.verification_code ?? "").trim();
        const record =
          (challengeId ? verificationCodes.get(challengeId) : undefined) ??
          (target ? verificationCodes.get(`target:${target}`) : undefined);
        if (
          !record ||
          record.used ||
          record.expiresAt <= now ||
          !code ||
          record.code !== code
        ) {
          throw fail(401, "验证码无效或已过期");
        }
        record.used = true;
        const sub = `code:${record.target}`;
        const created = createSessionRecord({
          sub,
          name: record.target,
          authChannel: "verification_code",
        });
        send(200, {
          ok: true,
          token: created.token,
          user_id: sub,
          auth_channel: "verification_code",
          session: created.publicSession,
        });
        return;
      }

      const oauthAuthorizeMatch = url.pathname.match(
        /^\/api\/auth\/oauth\/([a-z0-9_-]+)\/authorize$/,
      );
      if (
        (oauthAuthorizeMatch &&
          (req.method === "GET" || req.method === "POST")) ||
        route === "POST /api/auth/oauth/begin"
      ) {
        const payload = req.method === "POST" ? await body(req) : {};
        const provider = String(
          oauthAuthorizeMatch?.[1] ??
            payload.provider ??
            url.searchParams.get("provider") ??
            "",
        )
          .trim()
          .toLowerCase();
        if (!OAUTH_PROVIDERS.has(provider)) {
          throw fail(400, "不支持的第三方 OAuth 登录渠道");
        }
        const reqId = random();
        const state = random();
        const verifier = random();
        const authorizeUrl = `https://oauth.${provider}.bgssai.internal/authorize?client_id=${encodeURIComponent(config.clientId)}&provider=${encodeURIComponent(provider)}&response_type=code&redirect_uri=${encodeURIComponent(`${publicOrigin}/api/auth/oauth/${provider}/callback`)}&state=${encodeURIComponent(state)}`;
        pending.set(reqId, {
          requestId: reqId,
          provider,
          state,
          verifier,
          expiresAt: now + 600000,
        });
        send(200, {
          ok: true,
          provider,
          state,
          request_id: reqId,
          authorize_url: authorizeUrl,
          requestId: reqId,
          authorizeUrl,
        });
        return;
      }

      const oauthCallbackMatch = url.pathname.match(
        /^\/api\/auth\/oauth\/([a-z0-9_-]+)\/callback$/,
      );
      if (
        (oauthCallbackMatch &&
          (req.method === "GET" || req.method === "POST")) ||
        route === "POST /api/auth/oauth/callback"
      ) {
        const payload = req.method === "POST" ? await body(req) : {};
        const provider = String(
          oauthCallbackMatch?.[1] ??
            payload.provider ??
            url.searchParams.get("provider") ??
            "",
        )
          .trim()
          .toLowerCase();
        if (!OAUTH_PROVIDERS.has(provider)) {
          throw fail(400, "不支持的第三方 OAuth 登录渠道");
        }
        const state = String(
          payload.state ?? url.searchParams.get("state") ?? "",
        ).trim();
        const code = String(
          payload.code ?? url.searchParams.get("code") ?? "",
        ).trim();
        const errParam = payload.error ?? url.searchParams.get("error");
        const entry = [...pending.values()].find(
          (value) => value.state === state && value.provider === provider,
        );
        if (!entry || entry.exchanging || entry.session || entry.cancelled) {
          throw fail(400, "授权状态无效或已消费");
        }
        entry.exchanging = true;
        if (errParam) {
          entry.cancelled = true;
          throw fail(400, "用户拒绝授权");
        }
        if (!code || code.length > 4096) throw fail(400, "缺少授权码");
        const externalSub = String(
          payload.openid ??
            payload.sub ??
            payload.user_id ??
            url.searchParams.get("openid") ??
            url.searchParams.get("sub") ??
            hash(`${provider}:${code}`).slice(0, 24),
        ).slice(0, 160);
        const sub = `${provider}:${externalSub}`;
        const displayName = String(
          payload.nickname ??
            payload.name ??
            url.searchParams.get("nickname") ??
            `${provider}_${externalSub.slice(0, 8)}`,
        ).slice(0, 200);
        const created = createSessionRecord({
          sub,
          name: displayName,
          authChannel: provider,
        });
        entry.session = created.publicSession;
        send(200, {
          ok: true,
          provider,
          token: created.token,
          user_id: sub,
          auth_channel: provider,
          session: created.publicSession,
        });
        return;
      }

      if (route === "POST /api/auth/begin") {
        if (pending.size >= 100 || sessions.size >= 1000)
          throw fail(429, "授权会话达到上限");
        const meta = await metadata();
        const reqId = random(),
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
        pending.set(reqId, {
          state,
          verifier,
          provider: "chat",
          expiresAt: now + 600000,
        });
        send(200, {
          requestId: reqId,
          authorizeUrl: authorize.href,
          request_id: reqId,
          authorize_url: authorize.href,
        });
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
        const created = createSessionRecord({
          sub: info.sub,
          name: String(info.nickname ?? info.name ?? info.sub).slice(0, 200),
          authChannel: "chat",
          grants: { sync: false, ai: false, bot: false },
          expiresInMs: tokens.expires_in * 1000,
          chatToken: tokens.access_token,
        });
        entry.session = created.publicSession;
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
        const data = await body(req);
        const targetReqId = data.requestId ?? data.request_id;
        const entry = pending.get(targetReqId);
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

      if (
        route === "POST /api/support-bridge/inbox" ||
        route === "POST /api/support/webhook"
      ) {
        const raw = await rawBody(req);
        const secret =
          config.supportBridgeSecret ??
          config.supportWebhookSecret ??
          process.env.COMPOSITOR_SUPPORT_BRIDGE_SECRET ??
          "compositor-support-secret";
        const signatureHeader = String(
          req.headers["x-bgssai-signature"] ??
            req.headers["x-support-signature"] ??
            req.headers["x-signature"] ??
            req.headers["x-hub-signature-256"] ??
            "",
        ).trim();
        const cleanedSig = signatureHeader.replace(/^sha256=/i, "");
        const expectedHex = createHmac("sha256", secret)
          .update(raw)
          .digest("hex");
        const validSig =
          cleanedSig.length === expectedHex.length &&
          /^[0-9a-f]+$/i.test(cleanedSig) &&
          timingSafeEqual(
            Buffer.from(cleanedSig.toLowerCase(), "hex"),
            Buffer.from(expectedHex.toLowerCase(), "hex"),
          );
        if (!validSig) {
          throw fail(401, "客服桥接签名校验失败");
        }
        let payload;
        try {
          payload = raw ? JSON.parse(raw) : {};
        } catch {
          throw fail(400, "无效 JSON");
        }
        const productCode = payload.product_code ?? PRODUCT_CODE;
        if (productCode !== PRODUCT_CODE) {
          throw fail(400, "客服桥接产品标识不匹配");
        }
        const eventId = String(payload.event_id ?? "").trim();
        if (!eventId) {
          throw fail(400, "缺少 event_id");
        }
        if (processedSupportEvents.has(eventId)) {
          send(200, {
            ok: true,
            product_code: PRODUCT_CODE,
            event_id: eventId,
            deduplicated: true,
            idempotent_replay: true,
          });
          return;
        }
        processedSupportEvents.set(eventId, now);
        const sessionId = payload.session_id ?? payload.sessionId ?? null;
        const ticketId = payload.ticket_id ?? payload.ticketId ?? null;
        const replyContent = String(
          payload.content ?? payload.message ?? payload.reply ?? "",
        ).trim();
        const targetSession = sessionId
          ? supportSessions.get(sessionId)
          : undefined;
        const targetTicket = ticketId
          ? supportTickets.get(ticketId)
          : undefined;
        if (payload.status) {
          const nextStatus = String(payload.status);
          if (targetSession) {
            targetSession.status = nextStatus;
            targetSession.updated_at = now;
          }
          if (targetTicket) {
            targetTicket.status = nextStatus;
            targetTicket.updated_at = now;
          }
        }
        let createdMessage = null;
        if (replyContent) {
          const ownerKey =
            targetSession?.ownerKey ?? targetTicket?.ownerKey ?? null;
          const userId =
            targetSession?.user_id ?? targetTicket?.user_id ?? null;
          createdMessage = {
            message_id: shortId("supmsg"),
            id: shortId("supmsg"),
            session_id:
              sessionId ?? targetTicket?.session_id ?? "supsess_bridge",
            ticket_id: ticketId,
            product_code: PRODUCT_CODE,
            user_id: userId,
            ownerKey,
            sender_role: "agent",
            content: replyContent,
            event_id: eventId,
            created_at: now,
          };
          supportMessages.set(createdMessage.message_id, createdMessage);
          if (targetTicket) {
            targetTicket.messages.push(createdMessage);
            targetTicket.updated_at = now;
          }
        }
        send(200, {
          ok: true,
          product_code: PRODUCT_CODE,
          event_id: eventId,
          deduplicated: false,
          idempotent_replay: false,
          message: createdMessage,
        });
        return;
      }

      if (route === "GET /api/ai/models") {
        if (req.headers.authorization) {
          authorized(req, false);
        }
        const { models, defaultModel } = buildModelCatalog();
        send(200, {
          product_code: PRODUCT_CODE,
          default_model: defaultModel,
          models,
        });
        return;
      }

      const isBot =
        (url.pathname.startsWith("/api/bot/") &&
          route !== "POST /api/bot/token" &&
          route !== "POST /api/bot/pat") ||
        url.pathname.startsWith("/api/mcp/");
      const { token, session } = authorized(req, isBot);

      if (
        route === "DELETE /api/session" ||
        route === "POST /api/auth/logout" ||
        route === "POST /api/auth/revoke"
      ) {
        const chatRevoked = await revokeUserSession(token, session);
        send(200, {
          ok: true,
          revoked: true,
          chatRevoked,
          chat_revoked: chatRevoked,
        });
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
        if (!grants.bot || !grants.sync) {
          for (const [key, value] of bots)
            if (value.parent === token) bots.delete(key);
          for (const [key, value] of pats)
            if (value.parent === token) pats.delete(key);
        }
        if (!grants.sync) {
          userProjects.delete(ownerKeyFor(session));
          await locked(session, () =>
            unlink(projectPath(session)).catch((e) => {
              if (e.code !== "ENOENT") throw e;
            }),
          );
        }
        send(200, { ok: true, grants: session.grants });
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
        bots.set(botToken, {
          parent: token,
          ownerKey: ownerKeyFor(session),
          sub: session.sub,
          expiresAt: now + 3600000,
        });
        send(200, { token: botToken, bot_token: botToken });
        return;
      }
      if (route === "POST /api/pat" || route === "POST /api/bot/pat") {
        if (!session.grants.bot || !session.grants.sync)
          throw fail(403, "请先开启同步和 Bot 授权");
        const data = await body(req);
        const patToken = random();
        const patId = shortId("pat");
        pats.set(patToken, {
          id: patId,
          name: String(data.name ?? "compositor-pat").slice(0, 100),
          parent: token,
          ownerKey: ownerKeyFor(session),
          sub: session.sub,
          expiresAt: now + 86400000,
        });
        send(200, {
          ok: true,
          pat_id: patId,
          token: patToken,
          pat: patToken,
        });
        return;
      }

      if (route === "GET /api/mcp/tools" || route === "GET /api/bot/tools") {
        send(200, {
          product_code: PRODUCT_CODE,
          tools: MCP_TOOLS,
        });
        return;
      }

      if (
        route === "POST /api/bot/operate" ||
        route === "POST /api/mcp/call" ||
        route === "POST /api/bot/mcp"
      ) {
        const data = await body(req);
        const result = await executeBotOrMcpOperation(req, session, data);
        send(200, result);
        return;
      }

      if (route === "GET /api/support/sessions") {
        const ownerKey = ownerKeyFor(session);
        const requestedId = url.searchParams.get("session_id");
        if (requestedId) {
          const target = supportSessions.get(requestedId);
          if (!target) throw fail(404, "客服会话不存在");
          if (target.ownerKey !== ownerKey)
            throw fail(403, "无权访问他人客服会话");
          send(200, {
            product_code: PRODUCT_CODE,
            sessions: [target],
          });
          return;
        }
        const list = [...supportSessions.values()].filter(
          (item) => item.ownerKey === ownerKey,
        );
        send(200, {
          product_code: PRODUCT_CODE,
          sessions: list,
        });
        return;
      }

      if (route === "POST /api/support/sessions") {
        const data = await body(req);
        const ownerKey = ownerKeyFor(session);
        const sessionId = shortId("supsess");
        const subject = String(
          data.subject ?? data.title ?? data.topic ?? "客服咨询",
        ).slice(0, 200);
        const record = {
          session_id: sessionId,
          id: sessionId,
          product_code: PRODUCT_CODE,
          user_id: session.sub,
          ownerKey,
          subject,
          status: "open",
          created_at: now,
          updated_at: now,
        };
        supportSessions.set(sessionId, record);
        const outboxEvent = {
          outbox_id: shortId("out"),
          event_id: shortId("evt"),
          event_type: "session_created",
          product_code: PRODUCT_CODE,
          session_id: sessionId,
          user_id: session.sub,
          ownerKey,
          status: "delivered",
          created_at: now,
        };
        supportOutbox.push(outboxEvent);
        const initialContent = String(
          data.initial_message ?? data.message ?? data.content ?? "",
        ).trim();
        if (initialContent) {
          const msg = {
            message_id: shortId("supmsg"),
            id: shortId("supmsg"),
            session_id: sessionId,
            ticket_id: null,
            product_code: PRODUCT_CODE,
            user_id: session.sub,
            ownerKey,
            sender_role: "user",
            content: initialContent,
            created_at: now,
          };
          supportMessages.set(msg.message_id, msg);
        }
        send(200, {
          ok: true,
          product_code: PRODUCT_CODE,
          session_id: sessionId,
          session: record,
          outbox_event: outboxEvent,
        });
        return;
      }

      if (route === "GET /api/support/messages") {
        const ownerKey = ownerKeyFor(session);
        const sessionId = url.searchParams.get("session_id");
        const ticketId = url.searchParams.get("ticket_id");
        if (sessionId) {
          const target = supportSessions.get(sessionId);
          if (!target) throw fail(404, "客服会话不存在");
          if (target.ownerKey !== ownerKey)
            throw fail(403, "无权访问他人客服会话消息");
        }
        if (ticketId) {
          const target = supportTickets.get(ticketId);
          if (!target) throw fail(404, "客服工单不存在");
          if (target.ownerKey !== ownerKey)
            throw fail(403, "无权访问他人客服工单消息");
        }
        const list = [...supportMessages.values()].filter((item) => {
          if (item.ownerKey !== ownerKey) return false;
          if (sessionId && item.session_id !== sessionId) return false;
          if (ticketId && item.ticket_id !== ticketId) return false;
          return true;
        });
        send(200, {
          product_code: PRODUCT_CODE,
          messages: list,
        });
        return;
      }

      const ticketMessageMatch = url.pathname.match(
        /^\/api\/support\/tickets\/([A-Za-z0-9_-]+)\/messages$/,
      );
      if (
        route === "POST /api/support/messages" ||
        (ticketMessageMatch && req.method === "POST")
      ) {
        const data = await body(req);
        const ownerKey = ownerKeyFor(session);
        const content = String(
          data.content ?? data.message ?? data.text ?? "",
        ).trim();
        if (!content || content.length > 4000)
          throw fail(400, "客服消息内容无效");
        let sessionId = data.session_id ?? data.sessionId ?? null;
        const ticketId =
          ticketMessageMatch?.[1] ?? data.ticket_id ?? data.ticketId ?? null;
        if (sessionId) {
          const targetSession = supportSessions.get(sessionId);
          if (!targetSession) throw fail(404, "客服会话不存在");
          if (targetSession.ownerKey !== ownerKey)
            throw fail(403, "无权向他人客服会话发送消息");
          targetSession.updated_at = now;
        }
        let targetTicket = null;
        if (ticketId) {
          targetTicket = supportTickets.get(ticketId);
          if (!targetTicket) throw fail(404, "客服工单不存在");
          if (targetTicket.ownerKey !== ownerKey)
            throw fail(403, "无权向他人客服工单发送消息");
          targetTicket.updated_at = now;
          if (!sessionId) sessionId = targetTicket.session_id;
        }
        if (!sessionId) {
          const defaultSessionId = shortId("supsess");
          supportSessions.set(defaultSessionId, {
            session_id: defaultSessionId,
            id: defaultSessionId,
            product_code: PRODUCT_CODE,
            user_id: session.sub,
            ownerKey,
            subject: "默认客服会话",
            status: "open",
            created_at: now,
            updated_at: now,
          });
          sessionId = defaultSessionId;
        }
        const msg = {
          message_id: shortId("supmsg"),
          id: shortId("supmsg"),
          session_id: sessionId,
          ticket_id: ticketId,
          product_code: PRODUCT_CODE,
          user_id: session.sub,
          ownerKey,
          sender_role: "user",
          content,
          created_at: now,
        };
        supportMessages.set(msg.message_id, msg);
        if (targetTicket) {
          targetTicket.messages.push(msg);
        }
        const outboxEvent = {
          outbox_id: shortId("out"),
          event_id: shortId("evt"),
          event_type: "user_message",
          product_code: PRODUCT_CODE,
          session_id: sessionId,
          ticket_id: ticketId,
          message_id: msg.message_id,
          user_id: session.sub,
          ownerKey,
          status: "delivered",
          created_at: now,
        };
        supportOutbox.push(outboxEvent);
        send(200, {
          ok: true,
          product_code: PRODUCT_CODE,
          message_id: msg.message_id,
          message: msg,
          outbox_event: outboxEvent,
        });
        return;
      }

      if (route === "GET /api/support/tickets") {
        const ownerKey = ownerKeyFor(session);
        const ticketId = url.searchParams.get("ticket_id");
        if (ticketId) {
          const target = supportTickets.get(ticketId);
          if (!target) throw fail(404, "客服工单不存在");
          if (target.ownerKey !== ownerKey)
            throw fail(403, "无权访问他人客服工单");
          send(200, {
            product_code: PRODUCT_CODE,
            tickets: [target],
          });
          return;
        }
        const tickets = [...supportTickets.values()].filter(
          (item) => item.ownerKey === ownerKey,
        );
        const outbox = supportOutbox.filter(
          (item) => item.ownerKey === ownerKey,
        );
        send(200, {
          product_code: PRODUCT_CODE,
          tickets,
          outbox,
        });
        return;
      }

      if (route === "POST /api/support/tickets") {
        const data = await body(req);
        const ownerKey = ownerKeyFor(session);
        const subject = String(
          data.subject ?? data.title ?? "Compositor 客服工单",
        )
          .trim()
          .slice(0, 200);
        const content = String(
          data.content ?? data.message ?? data.description ?? subject,
        )
          .trim()
          .slice(0, 4000);
        if (!subject || !content) throw fail(400, "工单标题和内容不能为空");
        const sessionId = data.session_id ?? data.sessionId ?? null;
        if (sessionId) {
          const targetSession = supportSessions.get(sessionId);
          if (!targetSession) throw fail(404, "关联客服会话不存在");
          if (targetSession.ownerKey !== ownerKey)
            throw fail(403, "无权关联他人客服会话");
        }
        const ticketId = shortId("tkt");
        const initialMsg = {
          message_id: shortId("supmsg"),
          id: shortId("supmsg"),
          session_id: sessionId,
          ticket_id: ticketId,
          product_code: PRODUCT_CODE,
          user_id: session.sub,
          ownerKey,
          sender_role: "user",
          content,
          created_at: now,
        };
        supportMessages.set(initialMsg.message_id, initialMsg);
        const ticket = {
          ticket_id: ticketId,
          id: ticketId,
          session_id: sessionId,
          product_code: PRODUCT_CODE,
          user_id: session.sub,
          ownerKey,
          subject,
          content,
          priority: String(data.priority ?? "normal"),
          status: "open",
          messages: [initialMsg],
          created_at: now,
          updated_at: now,
        };
        supportTickets.set(ticketId, ticket);
        const outboxEvent = {
          outbox_id: shortId("out"),
          event_id: shortId("evt"),
          event_type: "ticket_created",
          product_code: PRODUCT_CODE,
          ticket_id: ticketId,
          session_id: sessionId,
          user_id: session.sub,
          ownerKey,
          status: "delivered",
          created_at: now,
        };
        supportOutbox.push(outboxEvent);
        send(200, {
          ok: true,
          product_code: PRODUCT_CODE,
          ticket_id: ticketId,
          ticket,
          outbox_event: outboxEvent,
        });
        return;
      }

      if (route === "GET /api/support/outbox") {
        const ownerKey = ownerKeyFor(session);
        send(200, {
          product_code: PRODUCT_CODE,
          outbox: supportOutbox.filter((item) => item.ownerKey === ownerKey),
        });
        return;
      }

      if (route === "POST /api/ai/text") {
        if (!session.grants.ai) throw fail(403, "AI 未授权");
        const data = await body(req);
        const prompt = data.prompt;
        if (
          typeof prompt !== "string" ||
          !prompt.trim() ||
          prompt.length > 4000
        )
          throw fail(400, "提示词无效");
        const { models, defaultModel } = buildModelCatalog();
        const requestedModelId = String(
          data.model ?? data.model_id ?? defaultModel,
        ).trim();
        const selectedModel = models.find(
          (item) =>
            item.id === requestedModelId || item.model_id === requestedModelId,
        );
        if (!selectedModel) {
          throw fail(400, "所选 AI 模型不在受控模型目录中");
        }
        const allowedOrigins = resolveAllowedHubOrigins();
        const explicitOrigin =
          data.hub_origin ?? data.target_hub_origin ?? data.endpoint ?? null;
        if (explicitOrigin !== null && explicitOrigin !== undefined) {
          let normalizedExplicit;
          try {
            normalizedExplicit = httpsOrigin(String(explicitOrigin));
          } catch {
            throw fail(403, "AI 模型服务路由地址未受信任");
          }
          if (!allowedOrigins.has(normalizedExplicit)) {
            throw fail(403, "AI 模型服务路由地址未受信任");
          }
        }
        const regionalOrigin =
          (selectedModel.region === "cn"
            ? config.hubCnOrigin ?? config.hubOrigins?.cn
            : config.hubGlobalOrigin ?? config.hubOrigins?.global) ??
          config.hubOrigin;
        if (!regionalOrigin || !config.hubKey)
          throw fail(503, "AI 模型服务尚未配置");
        const targetOrigin = httpsOrigin(regionalOrigin);
        if (!allowedOrigins.has(targetOrigin)) {
          throw fail(403, "AI 模型服务路由地址未受信任");
        }
        let response;
        try {
          response = await transport(`${targetOrigin}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.hubKey}`,
              "Content-Type": "application/json",
              "X-Bgssai-Product": PRODUCT_HEADER,
              "X-Bgssai-Model": selectedModel.model_id,
              "X-Bgssai-Region": selectedModel.region,
            },
            body: JSON.stringify({
              model: selectedModel.model_id,
              messages: [{ role: "user", content: prompt }],
              max_tokens: 512,
              stream: false,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          throw fail(502, "AI 模型服务请求失败，请稍后重试");
        }
        if (!response.ok) throw fail(502, "AI 模型服务请求失败，请稍后重试");
        const completion = await response.json();
        const text = completion.choices?.[0]?.message?.content;
        if (typeof text !== "string" || text.length > 10000)
          throw fail(502, "AI 模型服务返回无效内容");
        if (!session.grants.ai || !sessions.has(token))
          throw fail(403, "AI 授权已撤销");
        send(200, {
          text: scrubMessage(text, [config.hubKey, config.clientSecret]),
          model: selectedModel.model_id,
          model_id: selectedModel.model_id,
          region: selectedModel.region,
          product_code: PRODUCT_CODE,
          request_id: requestId,
        });
        return;
      }
      throw fail(404, "接口不存在");
    } catch (error) {
      if (!res.headersSent) {
        const safeError = scrubMessage(
          error.status ? error.message : "请求无效或存储失败",
          [config.hubKey, config.clientSecret, config.supportBridgeSecret],
        );
        send(error.status ?? 400, {
          error: safeError,
          request_id: requestId,
        });
      } else res.end();
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
    supportBridgeSecret: process.env.COMPOSITOR_SUPPORT_BRIDGE_SECRET,
  });
  server.listen(Number(properties["service.port"] ?? 8787), "127.0.0.1", () =>
    console.log(`Compositor ${environment} service listening on loopback`),
  );
}
