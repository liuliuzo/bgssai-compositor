const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  clipboard,
  protocol,
  net,
  session,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { atomicWrite, RecoveryStore } = require("./storage.cjs");
const { Updater } = require("./updates.cjs");
const { spawn } = require("node:child_process");
const os = require("node:os");
if (process.env.COMPOSITOR_TEST === "1" && process.env.COMPOSITOR_TEST_DATA) {
  const target = path.resolve(process.env.COMPOSITOR_TEST_DATA);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith("compositor-test-")
  )
    throw new Error("Invalid test data directory");
  app.setPath("userData", target);
}
let recoveryStore, updater, config;
const connectionRoutes = new Set([
  "auth/begin",
  "auth/poll",
  "auth/cancel",
  "auth/channels",
  "auth/register",
  "auth/login",
  "auth/login/password",
  "auth/code/send",
  "auth/code/login",
  "auth/code/verify",
  "auth/oauth/begin",
  "auth/oauth/callback",
  "auth/logout",
  "auth/revoke",
  "session",
  "grants",
  "project",
  "bot/token",
  "bot/operate",
  "bot/project",
  "pat",
  "mcp/tools",
  "mcp/call",
  "ai/models",
  "ai/text",
  "support/sessions",
  "support/messages",
  "support/tickets",
  "support/outbox",
]);
function isAllowedConnectionRoute(route) {
  if (typeof route !== "string") return false;
  const clean = route.split("?")[0];
  if (connectionRoutes.has(clean)) return true;
  if (/^auth\/oauth\/(wechat|alipay|douyin|baidu)\/(authorize|callback)$/.test(clean))
    return true;
  if (/^support\/tickets\/[A-Za-z0-9_-]+\/messages$/.test(clean)) return true;
  return false;
}

const MAX_BYTES = 128 * 1024 * 1024;
const devURL =
  !app.isPackaged && process.env.COMPOSITOR_DEV_URL === "http://127.0.0.1:5173"
    ? process.env.COMPOSITOR_DEV_URL
    : null;
let window;
let dirty = false;
let closeConfirmed = false;
let projectPath = null;
const pendingProjects = new Map();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "compositor",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Untrusted sender");
  const url = new URL(event.senderFrame.url);
  if (
    !(devURL
      ? url.origin === devURL
      : url.protocol === "compositor:" && url.hostname === "app")
  )
    throw new Error("Untrusted origin");
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    trusted(event);
    return fn(...args);
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    trusted(event);
    fn(...args);
  });
}
function action(name) {
  window?.webContents.send("editor:action", name);
}
function safeName(name) {
  return (
    String(name ?? "未命名")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 100) || "未命名"
  );
}
function setupIPC() {
  handle("recovery:read", () => recoveryStore.read());
  handle("recovery:write", (content) => recoveryStore.write(content));
  handle("recovery:clear", () => recoveryStore.clear());
  handle("connections:config", () =>
    Object.fromEntries(
      [
        "ecosystem.url",
        "chat.issuer",
        "support.url",
        "downloads.url",
        "bot.url",
      ].map((key) => [key, config[key] ?? ""]),
    ),
  );
  handle(
    "connections:request",
    async ({ route, method, body, token, etag }) => {
      if (
        !isAllowedConnectionRoute(route) ||
        !["GET", "POST", "PUT", "DELETE"].includes(method)
      )
        throw new Error("连接请求无效");
      if (!config["ecosystem.url"]) throw new Error("在线服务尚未开通");
      const base = new URL(config["ecosystem.url"]);
      if (
        base.protocol !== "https:" ||
        base.pathname !== "/" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error("在线服务地址无效");
      const headers = { "Content-Type": "application/json" };
      if (token) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("会话无效");
        headers.Authorization = `Bearer ${token}`;
      }
      if (etag) {
        if (!/^(empty|[a-f0-9]{64})$/.test(etag))
          throw new Error("项目版本无效");
        headers["If-Match"] = etag;
      }
      const content = body === undefined ? undefined : JSON.stringify(body);
      if (content && Buffer.byteLength(content) > MAX_BYTES * 2 + 16384)
        throw new Error("请求过大");
      const response = await net.fetch(`${base.origin}/api/${route}`, {
        method,
        headers,
        body: content,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(
          response.status === 412
            ? "云端版本已变化，请先下载云端版本，避免覆盖。"
            : `连接失败（${response.status}）`,
        );
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES * 2 + 16384) throw new Error("服务响应过大");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks));
    },
  );
  handle("connections:external", async (value) => {
    const url = new URL(value);
    const origins = ["chat.issuer", "support.url", "downloads.url", "bot.url"]
      .map((key) => config[key])
      .filter(Boolean)
      .map((value) => new URL(value).origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !origins.includes(url.origin)
    )
      throw new Error("链接不在已配置的服务范围内");
    await shell.openExternal(url.href);
  });
  handle("update:check", () => updater.check());
  handle("update:stage", () => updater.stage());
  handle("update:install", async () => {
    if (dirty) throw new Error("请先保存当前项目再安装更新");
    if (
      !updater.staged ||
      process.platform !== "win32" ||
      !updater.options.installed
    )
      throw new Error("当前安装方式需从下载入口手动安装并保留上一版");
    const directory = updater.options.directory;
    const helper = path.join(directory, "update-helper.cjs");
    await fs.copyFile(path.join(__dirname, "update-helper.cjs"), helper);
    await fs.copyFile(
      path.join(__dirname, "update-runner.cjs"),
      path.join(directory, "update-runner.cjs"),
    );
    const receipt = path.join(directory, `health-${randomUUID()}.txt`);
    const child = spawn(
      process.execPath,
      [
        helper,
        path.join(directory, "staged.json"),
        process.execPath,
        String(process.pid),
        receipt,
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    closeConfirmed = true;
    app.quit();
  });
  handle("update:result", async () => {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(updater.options.directory, "result.json"),
          "utf8",
        ),
      );
    } catch {
      return null;
    }
  });
  handle("update:healthy", async () => {
    const receipt = process.env.COMPOSITOR_UPDATE_RECEIPT;
    if (
      receipt &&
      process.env.COMPOSITOR_UPDATE_VERSION === app.getVersion() &&
      path.dirname(path.resolve(receipt)) ===
        path.resolve(updater.options.directory) &&
      /^health-[a-f0-9-]+\.txt$/.test(path.basename(receipt))
    )
      await atomicWrite(receipt, app.getVersion());
  });
  handle("app:info", async () => {
    const environment =
      !app.isPackaged && process.env.APP_ENV === "dev" ? "dev" : "prod";
    const config = await fs.readFile(
      path.join(__dirname, `../config/application-${environment}.properties`),
      "utf8",
    );
    return {
      version: app.getVersion(),
      channel: config.match(/^app.channel=(.*)$/m)?.[1] ?? "production",
    };
  });
  handle("file:open", async (kind) => {
    if (!["document", "image"].includes(kind))
      throw new Error("无效的文件类型");
    const filters = [
      { name: "图像", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] },
    ];
    if (kind === "document")
      filters.unshift({
        name: "Compositor 项目或图像",
        extensions: ["bgcomp", "png", "jpg", "jpeg", "webp", "bmp"],
      });
    const result = await dialog.showOpenDialog(window, {
      title: kind === "image" ? "导入图像为图层" : "打开项目或图像",
      properties: ["openFile"],
      filters,
    });
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    if ((await fs.stat(selected)).size > MAX_BYTES)
      throw new Error("文件超过 128 MB，请缩小文件后再导入。");
    const bytes = await fs.readFile(selected);
    const ext = path.extname(selected).toLowerCase();
    if (ext === ".bgcomp") {
      const token = randomUUID();
      pendingProjects.clear();
      pendingProjects.set(token, selected);
      return {
        name: path.basename(selected),
        kind: "project",
        data: bytes.toString("utf8"),
        token,
      };
    }
    const mime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    }[ext];
    if (!mime)
      throw new Error("首版支持 PNG、JPEG、WebP、BMP 和 .bgcomp 项目。");
    return {
      name: path.basename(selected),
      kind: "image",
      data: `data:${mime};base64,${bytes.toString("base64")}`,
    };
  });
  // A read dialog alone must never change the destination of the current project.
  // Renderer adoption happens only after successful decoding and validation.
  handle("file:adopt-project", (token) => {
    if (!pendingProjects.has(token)) throw new Error("项目打开请求已失效");
    projectPath = pendingProjects.get(token);
    pendingProjects.clear();
  });
  handle("file:save-project", async ({ name, content, saveAs }) => {
    if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES)
      throw new Error("项目过大（上限 128 MB）");
    const parsed = JSON.parse(content);
    if (parsed.format !== "bgssai-compositor" || parsed.version !== 1)
      throw new Error("项目格式无效");
    let target = projectPath;
    if (!target || saveAs) {
      const result = await dialog.showSaveDialog(window, {
        title: "保存可编辑项目",
        defaultPath: `${safeName(name)}.bgcomp`,
        filters: [{ name: "Compositor 项目", extensions: ["bgcomp"] }],
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath.toLowerCase().endsWith(".bgcomp")
        ? result.filePath
        : `${result.filePath}.bgcomp`;
    }
    await atomicWrite(target, content);
    projectPath = target;
    return { name: path.basename(target), path: target };
  });
  handle("file:export", async ({ name, data, format }) => {
    if (
      !["png", "jpeg"].includes(format) ||
      typeof data !== "string" ||
      data.length > MAX_BYTES * 1.4
    )
      throw new Error("导出内容无效");
    const prefix = `data:image/${format};base64,`;
    if (!data.startsWith(prefix)) throw new Error("图像格式不匹配");
    const ext = format === "jpeg" ? "jpg" : "png";
    const result = await dialog.showSaveDialog(window, {
      title: "导出图像",
      defaultPath: `${safeName(name)}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return null;
    const target = result.filePath.toLowerCase().endsWith(`.${ext}`)
      ? result.filePath
      : `${result.filePath}.${ext}`;
    await atomicWrite(target, Buffer.from(data.slice(prefix.length), "base64"));
    return { path: target };
  });
  handle("clipboard:image", () => {
    const image = clipboard.readImage();
    return image.isEmpty() ? null : image.toDataURL();
  });
  listen("document:dirty", (value) => {
    dirty = value === true;
  });
  listen("document:title", (title) => {
    if (typeof title === "string")
      window.setTitle(`${title.slice(0, 150)} — BGSSAI Compositor`);
  });
  listen("document:reset-path", () => {
    projectPath = null;
    pendingProjects.clear();
  });
  listen("window:close-confirmed", async () => {
    await recoveryStore.clear().catch(() => {});
    closeConfirmed = true;
    window.close();
  });
}

function setupMenu() {
  const item = (label, name, accelerator) => ({
    label,
    accelerator,
    click: () => action(name),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          item("新建…", "new", "CommandOrControl+N"),
          item("打开…", "open", "CommandOrControl+O"),
          item("导入图像为图层…", "import", "CommandOrControl+Shift+O"),
          { type: "separator" },
          item("保存项目", "save", "CommandOrControl+S"),
          item("项目另存为…", "save-as", "CommandOrControl+Shift+S"),
          item("导出图像…", "export", "CommandOrControl+Shift+E"),
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          item("撤销", "undo", "CommandOrControl+Z"),
          item("重做", "redo", "CommandOrControl+Shift+Z"),
          { type: "separator" },
          { role: "cut", label: "剪切文本" },
          { role: "copy", label: "复制文本" },
          { role: "paste", label: "粘贴" },
          item("复制图层", "duplicate", "CommandOrControl+J"),
          item("取消选区", "deselect", "CommandOrControl+D"),
        ],
      },
      {
        label: "视图",
        submenu: [
          item("适合窗口", "fit", "CommandOrControl+0"),
          item("实际像素", "actual-size", "CommandOrControl+1"),
          { role: "togglefullscreen", label: "全屏" },
          ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
        ],
      },
      {
        label: "帮助",
        submenu: [
          item("快捷键与使用说明", "help"),
          item("账户与连接", "connections"),
          item("检查更新", "updates"),
        ],
      },
    ]),
  );
}

app.whenReady().then(async () => {
  const environment =
    !app.isPackaged && process.env.APP_ENV === "dev" ? "dev" : "prod";
  const properties = await fs.readFile(
    path.join(__dirname, `../config/application-${environment}.properties`),
    "utf8",
  );
  config = Object.fromEntries(
    properties
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  recoveryStore = new RecoveryStore(
    path.join(app.getPath("userData"), "recovery"),
  );
  await recoveryStore.init();
  const updateDirectory = path.join(app.getPath("userData"), "updates");
  await fs.mkdir(updateDirectory, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(updateDirectory))
    if (
      /^BGSSAI-Compositor-[A-Za-z0-9._-]+\.download$/.test(name) ||
      /^staged\.json\.[a-f0-9-]+\.tmp$/.test(name)
    )
      await fs.unlink(path.join(updateDirectory, name)).catch(() => {});
  const publicKey = await fs
    .readFile(path.join(__dirname, "../config/update-public-key.pem"), "utf8")
    .catch(() => null);
  updater = new Updater({
    feed: config["update.feed"],
    publicKey,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    directory: updateDirectory,
    installed: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE,
  });
  protocol.handle("compositor", async (request) => {
    const url = new URL(request.url);
    const dist = path.resolve(__dirname, "../dist");
    const requested = path.resolve(
      dist,
      `.${decodeURIComponent(url.pathname)}`,
    );
    if (url.hostname !== "app" || !requested.startsWith(`${dist}${path.sep}`))
      return new Response("Forbidden", { status: 403 });
    try {
      return await net.fetch(pathToFileURL(requested).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 720,
    minHeight: 720,
    backgroundColor: "#161819",
    title: "BGSSAI Compositor",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling:
        app.isPackaged || process.env.COMPOSITOR_TEST !== "1",
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (dirty && !closeConfirmed) {
      event.preventDefault();
      action("close");
    }
  });
  setupIPC();
  setupMenu();
  window.once("ready-to-show", () => {
    if (app.isPackaged || process.env.COMPOSITOR_TEST !== "1") window.show();
  });
  await window.loadURL(devURL ?? "compositor://app/index.html");
});
app.on("window-all-closed", () => app.quit());
