import { _electron } from "@playwright/test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { version } = JSON.parse(
  await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const executablePath = resolve("release/win-unpacked/BGSSAI Compositor.exe");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
  ),
);
env.APP_ENV = "dev"; // Packaged builds must ignore this and use prod properties.
const temp = await fs.mkdtemp(join(tmpdir(), "compositor-test-package-"));
env.COMPOSITOR_TEST = "1";
env.COMPOSITOR_TEST_DATA = temp;
const app = await _electron.launch({ executablePath, env, timeout: 30_000 });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  // Packaged renderers retain normal background throttling. Hiding their window
  // can suspend animation frames on CI, including Playwright's stability checks.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await page.getByRole("heading", { name: "让灵感，自由成像。" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.desktop.getInfo()), {
    version,
    channel: "production",
  });
  await page.getByRole("button", { name: /打开示例/ }).click();
  await page.locator(".layer-row").first().waitFor();
  assert.equal(await page.locator(".layer-row").count(), 5);
  await page.screenshot({ path: "docs/review/windows-preview.png" });
  const projectPath = join(temp, "packaged.bgcomp");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, projectPath);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await page
    .locator('.toast[role="status"]')
    .filter({ hasText: "项目已保存" })
    .waitFor();
  const project = JSON.parse(await fs.readFile(projectPath, "utf8"));
  assert.equal(project.layers.length, 5);
  assert.equal(project.width, 1200);
  const exportPath = join(temp, "packaged.png");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await page
    .getByRole("button", { name: "导出图像", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导出图像", exact: true })
    .click();
  await page
    .locator('.toast[role="status"]')
    .filter({ hasText: "图像已导出" })
    .waitFor();
  assert.deepEqual(
    await app.evaluate(
      ({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(),
      exportPath,
    ),
    { width: 1200, height: 800 },
  );
  assert.deepEqual(errors, []);
  console.log(
    "Packaged Windows app passed: launch, production config, demo, project save and PNG export.",
  );
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  if (
    dirname(resolve(temp)) !== resolve(tmpdir()) ||
    !basename(temp).startsWith("compositor-test-package-")
  )
    throw new Error("Unexpected temporary directory.");
  await fs.rm(temp, { recursive: true, force: true });
}
