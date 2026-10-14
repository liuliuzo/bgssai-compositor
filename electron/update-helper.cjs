// Runs outside the editor process so interrupted/failed installers can roll back.
const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { installWithRollback } = require("./update-runner.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sha(file) {
  const handle = await fs.open(file);
  const hash = crypto.createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}
async function main() {
  const [stateFile, executable, parentPID, receipt] = process.argv.slice(2);
  const directory = path.dirname(stateFile);
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  for (const [file, digest] of [
    [state.installer, state.sha256],
    [state.rollback, state.rollbackSha256],
  ]) {
    if (
      path.dirname(path.resolve(file)) !== path.resolve(directory) ||
      path.extname(file).toLowerCase() !== ".exe" ||
      (await sha(file)) !== digest
    )
      throw new Error("安装前校验失败");
  }
  if (path.dirname(path.resolve(receipt)) !== path.resolve(directory))
    throw new Error("健康检查路径无效");
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(Number(parentPID), 0);
      await sleep(500);
    } catch {
      break;
    }
    if (i === 59) throw new Error("旧进程未退出");
  }
  const runInstaller = (file) =>
    promisify(execFile)(file, ["/S", `/D=${path.dirname(executable)}`], {
      windowsHide: true,
      timeout: 180000,
    });
  const launch = async (version) => {
    const env = {
      ...process.env,
      COMPOSITOR_UPDATE_RECEIPT: receipt,
      COMPOSITOR_UPDATE_VERSION: version,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return child;
  };
  const healthy = async (version, child) => {
    for (let i = 0; i < 90; i++) {
      await sleep(500);
      try {
        if ((await fs.readFile(receipt, "utf8")) === version) {
          child.unref();
          return true;
        }
      } catch {}
    }
    return false;
  };
  try {
    const result = await installWithRollback({
      install: () => runInstaller(state.installer),
      launch: () => launch(state.version),
      healthy: (child) => healthy(state.version, child),
      stop: (child) =>
        promisify(execFile)(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
        ).catch(() => {}),
      rollback: () => runInstaller(state.rollback),
      launchPrevious: async () => {
        await fs.unlink(receipt).catch(() => {});
        const child = await launch(state.previousVersion);
        if (!(await healthy(state.previousVersion, child)))
          throw new Error("回滚安装完成，但上一版未通过启动检查");
      },
    });
    await fs.writeFile(
      path.join(directory, "result.json"),
      JSON.stringify({
        ...result,
        version:
          result.status === "updated" ? state.version : state.previousVersion,
        at: Date.now(),
      }),
    );
  } finally {
    await fs.unlink(receipt).catch(() => {});
  }
}
main().catch(async (error) => {
  try {
    await fs.writeFile(
      path.join(path.dirname(process.argv[2]), "result.json"),
      JSON.stringify({
        status: "failed",
        reason: error.message,
        at: Date.now(),
      }),
    );
  } catch {}
  process.exitCode = 1;
});
