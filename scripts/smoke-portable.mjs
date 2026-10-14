import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const server = createServer();
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
  ),
);
const temp = await mkdtemp(join(tmpdir(), "compositor-test-portable-"));
env.COMPOSITOR_TEST = "1";
env.COMPOSITOR_TEST_DATA = temp;
const child = spawn(
  resolve(`release/BGSSAI-Compositor-${version}-win-x64-portable.exe`),
  [`--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: "ignore" },
);
let browser;
try {
  const deadline = Date.now() + 60_000;
  while (true) {
    if (child.exitCode !== null)
      throw new Error(`Portable launcher exited early (${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      /* Still extracting. */
    }
    if (Date.now() > deadline)
      throw new Error("Portable app did not launch within 60 seconds.");
    await new Promise((done) => setTimeout(done, 500));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.getByRole("heading", { name: "让灵感，自由成像。" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.desktop.getInfo()), {
    version,
    channel: "production",
  });
  await page.getByRole("button", { name: /打开示例/ }).click();
  assert.equal(await page.locator(".layer-row").count(), 5);
  console.log(
    "Portable executable passed: extraction, startup, production config and editable demo.",
  );
  await page.evaluate(() => window.desktop.confirmClose()).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((done) => child.once("exit", done)),
      new Promise((done) => setTimeout(done, 10_000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
  if (
    dirname(resolve(temp)) !== resolve(tmpdir()) ||
    !basename(temp).startsWith("compositor-test-portable-")
  )
    throw new Error("Unexpected temporary directory");
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
