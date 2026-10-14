const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWrite } = require("./storage.cjs");
const MAX_PACKAGE = 1024 * 1024 * 1024;
const version = (value) => {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error("无效发布版本");
  return value.split(".").map(Number);
};
function compare(a, b) {
  const left = version(a),
    right = version(b);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function assetURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.href.startsWith(
      "https://github.com/liuliuzo/bgssai-compossitor/releases/download/",
    )
  )
    throw new Error("更新包必须来自登记的仓库 Release");
  return url.href;
}
function validateArtifact(artifact, releaseVersion) {
  if (
    !artifact ||
    !["win32", "darwin", "linux"].includes(artifact.platform) ||
    !["x64", "arm64"].includes(artifact.arch) ||
    !/^[A-Za-z0-9._-]+$/.test(artifact.file) ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > MAX_PACKAGE ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    throw new Error("发布包元数据无效");
  const url = assetURL(artifact.url);
  if (artifact.platform === "win32" && !artifact.file.endsWith("-setup.exe"))
    throw new Error("Windows 更新和回滚必须使用安装版");
  if (
    new URL(url).pathname !==
    `/liuliuzo/bgssai-compossitor/releases/download/v${releaseVersion}/${artifact.file}`
  )
    throw new Error("更新包版本与路径不一致");
}
function verifyManifest(
  envelope,
  publicKey,
  currentVersion,
  platform,
  arch,
  now = Date.now(),
) {
  if (
    !publicKey ||
    typeof envelope?.payload !== "string" ||
    envelope.payload.length > 128 * 1024 ||
    typeof envelope.signature !== "string"
  )
    throw new Error("更新签名未配置或无效");
  const bytes = Buffer.from(envelope.payload, "base64");
  const key = crypto.createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !crypto.verify(null, bytes, key, Buffer.from(envelope.signature, "base64"))
  )
    throw new Error("发布清单签名校验失败");
  const data = JSON.parse(bytes);
  if (
    data.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(data.sourceSha) ||
    !Number.isFinite(data.createdAt) ||
    !Number.isFinite(data.expiresAt) ||
    data.createdAt > now + 300000 ||
    data.expiresAt < now ||
    data.expiresAt > data.createdAt + 90 * 86400000 ||
    !Array.isArray(data.artifacts)
  )
    throw new Error("发布清单来源或有效期无效");
  if (compare(data.version, currentVersion) <= 0)
    throw new Error("拒绝重复或降级更新");
  for (const artifact of data.artifacts)
    validateArtifact(artifact, data.version);
  const artifact = data.artifacts.find(
    (value) => value.platform === platform && value.arch === arch,
  );
  if (!artifact) throw new Error("当前平台没有对应更新包");
  if (
    !data.rollback ||
    data.rollback.version !== currentVersion ||
    !/^[a-f0-9]{40}$/.test(data.rollback.sourceSha)
  )
    throw new Error("缺少与当前版本对应的回滚包");
  validateArtifact(data.rollback.artifact, currentVersion);
  if (
    data.rollback.artifact.platform !== platform ||
    data.rollback.artifact.arch !== arch
  )
    throw new Error("回滚包平台不匹配");
  return { ...data, artifact };
}
async function response(url, transport = fetch) {
  let target = url;
  for (let i = 0; i < 5; i++) {
    const parsed = new URL(target);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ![
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
      ].includes(parsed.hostname)
    )
      throw new Error("更新下载重定向不在可信范围");
    const result = await transport(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      target = new URL(result.headers.get("location"), target).href;
      continue;
    }
    if (!result.ok) throw new Error(`更新下载失败（${result.status}）`);
    return result;
  }
  throw new Error("更新重定向过多");
}
async function download(artifact, directory, transport = fetch) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, artifact.file),
    temporary = `${target}.download`;
  try {
    if ((await fs.stat(target)).size === artifact.size) {
      const handle = await fs.open(target);
      const hash = crypto.createHash("sha256");
      try {
        for await (const chunk of handle.createReadStream()) hash.update(chunk);
        if (hash.digest("hex") === artifact.sha256) return target;
      } finally {
        await handle.close().catch(() => {});
      }
    }
  } catch {
    /* Download a fresh candidate. */
  }
  let file;
  try {
    const result = await response(assetURL(artifact.url), transport);
    const length = result.headers.get("content-length");
    if (length && Number(length) !== artifact.size)
      throw new Error("更新包长度不匹配");
    file = await fs.open(temporary, "w", 0o600);
    let size = 0;
    const hash = crypto.createHash("sha256");
    for await (const chunk of result.body) {
      size += chunk.length;
      if (size > artifact.size) throw new Error("更新包超过声明大小");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== artifact.size || hash.digest("hex") !== artifact.sha256)
      throw new Error("更新包 SHA256 校验失败");
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(temporary, target);
    return target;
  } finally {
    await file?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
class Updater {
  constructor(options) {
    this.options = options;
    this.busy = false;
    this.candidate = null;
  }
  async exclusive(fn) {
    if (this.busy) throw new Error("更新正在进行");
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async check() {
    return this.exclusive(async () => {
      if (!this.options.feed || !this.options.publicKey)
        throw new Error("签名更新尚未开通");
      assetURL(this.options.feed);
      const result = await response(this.options.feed);
      const chunks = [];
      let size = 0;
      for await (const chunk of result.body) {
        size += chunk.length;
        if (size > 256 * 1024) throw new Error("更新清单过大");
        chunks.push(chunk);
      }
      this.candidate = verifyManifest(
        JSON.parse(Buffer.concat(chunks)),
        this.options.publicKey,
        this.options.version,
        this.options.platform,
        this.options.arch,
      );
      return {
        version: this.candidate.version,
        sourceSha: this.candidate.sourceSha,
      };
    });
  }
  async stage() {
    return this.exclusive(async () => {
      if (!this.candidate) throw new Error("请先检查签名更新");
      if (this.candidate.expiresAt < Date.now())
        throw new Error("更新清单已过期，请重新检查");
      const rollback = await download(
        this.candidate.rollback.artifact,
        this.options.directory,
      );
      const installer = await download(
        this.candidate.artifact,
        this.options.directory,
      );
      const state = {
        version: this.candidate.version,
        previousVersion: this.options.version,
        installer,
        rollback,
        sha256: this.candidate.artifact.sha256,
        rollbackSha256: this.candidate.rollback.artifact.sha256,
      };
      await atomicWrite(
        path.join(this.options.directory, "staged.json"),
        JSON.stringify(state),
      );
      const keep = new Set([path.basename(installer), path.basename(rollback)]);
      for (const name of await fs.readdir(this.options.directory))
        if (
          /^BGSSAI-Compositor-[A-Za-z0-9._-]+\.(exe|dmg|AppImage)$/.test(
            name,
          ) &&
          !keep.has(name)
        )
          await fs.unlink(path.join(this.options.directory, name));
      this.staged = state;
      return {
        version: state.version,
        canInstall: this.options.platform === "win32" && this.options.installed,
      };
    });
  }
}
module.exports = { compare, verifyManifest, download, Updater };
