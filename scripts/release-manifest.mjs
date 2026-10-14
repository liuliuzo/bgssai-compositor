import { readdir, readFile, writeFile } from "node:fs/promises";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
const root = new URL("../", import.meta.url),
  directory = new URL("../release/", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const artifactFiles = (await readdir(directory)).filter(
  (name) =>
    name.includes(`-${version}-`) &&
    /\.(exe|dmg|zip|AppImage|deb|apk|aab|ipa)$/.test(name),
);
if (!artifactFiles.length) throw new Error("没有本地构建产物");
const artifacts = [];
for (const file of artifactFiles) {
  if (!file.includes(`-${version}-`))
    throw new Error(`产物版本与源码不一致: ${file}`);
  const bytes = await readFile(new URL(file, directory));
  const platform = file.includes("-win-")
    ? "win32"
    : file.includes("-mac-")
      ? "darwin"
      : file.includes("-linux-")
        ? "linux"
        : file.includes("-android-")
          ? "android"
          : file.includes("-ios-")
            ? "ios"
            : null;
  if (!platform) throw new Error(`无法确定平台: ${file}`);
  artifacts.push({
    file,
    platform,
    arch: file.includes("-arm64") || platform === "ios" ? "arm64" : "x64",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/liuliuzo/bgssai-compossitor/releases/download/v${version}/${file}`,
  });
}
await writeFile(
  new URL("SHA256SUMS.txt", directory),
  artifacts.map((value) => `${value.sha256}  ${value.file}`).join("\n") + "\n",
);
const now = Date.now();
const workingTreeDirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
    .length > 0;
const payload = {
  schema: 1,
  version,
  sourceSha,
  workingTreeDirty,
  createdAt: now,
  expiresAt: now + 90 * 86400000,
  artifacts,
};
const keyValue = process.env.COMPOSITOR_RELEASE_KEY;
if (!keyValue) {
  if (process.argv.includes("--signed"))
    throw new Error("受控发布必须提供 Ed25519 私钥");
  await writeFile(
    new URL("build-manifest.json", directory),
    JSON.stringify({ ...payload, status: "local-unsigned" }, null, 2),
  );
  console.log(
    `Local build: ${version}, ${sourceSha}, ${artifacts.length} artifacts (no Release implied)`,
  );
} else {
  if (workingTreeDirty) throw new Error("正式签名清单只能绑定干净的源码提交");
  execFileSync("git", [
    "merge-base",
    "--is-ancestor",
    sourceSha,
    "origin/develop",
  ]);
  const key = createPrivateKey(keyValue),
    publicKey = createPublicKey(
      await readFile(new URL("config/update-public-key.pem", root)),
    );
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .equals(publicKey.export({ type: "spki", format: "der" }))
  )
    throw new Error("发布私钥与应用内置公钥不匹配");
  const envelope = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      payload: bytes.toString("base64"),
      signature: sign(null, bytes, key).toString("base64"),
    };
  };
  await writeFile(
    new URL("release-manifest.json", directory),
    JSON.stringify(envelope(payload), null, 2),
  );
  const previousArgument = process.argv.find((value) =>
    value.startsWith("--previous="),
  );
  if (previousArgument) {
    const previousEnvelope = JSON.parse(
      await readFile(previousArgument.slice(11), "utf8"),
    );
    const bytes = Buffer.from(previousEnvelope.payload, "base64");
    if (
      !verify(
        null,
        bytes,
        publicKey,
        Buffer.from(previousEnvelope.signature, "base64"),
      )
    )
      throw new Error("上一版清单签名无效");
    const previous = JSON.parse(bytes);
    if (
      !/^\d+\.\d+\.\d+$/.test(previous.version) ||
      !/^[a-f0-9]{40}$/.test(previous.sourceSha)
    )
      throw new Error("上一版清单版本无效");
    const compare = (a, b) => {
      const x = a.split(".").map(Number),
        y = b.split(".").map(Number);
      for (let i = 0; i < 3; i++)
        if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
      return 0;
    };
    if (compare(previous.version, version) >= 0)
      throw new Error("上一版必须低于当前发布版本");
    for (const artifact of artifacts.filter(
      (value) =>
        value.file.endsWith("-setup.exe") ||
        value.file.endsWith(".dmg") ||
        value.file.endsWith(".AppImage"),
    )) {
      const rollback = previous.artifacts.find(
        (value) =>
          value.platform === artifact.platform &&
          value.arch === artifact.arch &&
          value.file.endsWith(
            artifact.platform === "win32"
              ? "-setup.exe"
              : artifact.platform === "darwin"
                ? ".dmg"
                : ".AppImage",
          ),
      );
      if (!rollback)
        throw new Error(`缺少 ${artifact.platform}/${artifact.arch} 回滚包`);
      const update = {
        ...payload,
        artifacts: [artifact],
        rollback: {
          version: previous.version,
          sourceSha: previous.sourceSha,
          artifact: rollback,
        },
      };
      await writeFile(
        new URL(
          `updates-${artifact.platform}-${artifact.arch}.json`,
          directory,
        ),
        JSON.stringify(envelope(update), null, 2),
      );
    }
  }
  console.log(
    `Signed release manifest: ${version}, ${sourceSha}; first signed release is the rollback baseline`,
  );
}
