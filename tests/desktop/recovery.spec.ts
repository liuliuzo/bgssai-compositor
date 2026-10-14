import {
  _electron as electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
let app: ElectronApplication, page: Page, directory: string;
let alive = false;
let env: Record<string, string>;
async function launch() {
  app = await electron.launch({ args: ["."], env });
  alive = true;
  page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "让灵感，自由成像。" }),
  ).toBeVisible();
}
test.beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-test-"));
  env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.COMPOSITOR_TEST = "1";
  env.COMPOSITOR_TEST_DATA = directory;
  await launch();
});
test.afterEach(async () => {
  if (alive) {
    await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app?.close().catch(() => {});
  }
  expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory)).toMatch(/^compositor-test-/);
  await fs.rm(directory, { recursive: true, force: true });
});
test("force exit recovers editable project and saving clears recovery", async () => {
  const file = path.resolve("fixtures/shared.bgcomp");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, file);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByLabel("图层名称").fill("恢复图层");
  await page.getByLabel("图层名称").blur();
  await expect(page.locator(".recovery-status")).toContainText(
    "已自动恢复保存",
  );
  const data = await page.evaluate(() => window.desktop!.readRecovery());
  expect(JSON.parse(data!.content).layers[0].name).toBe("恢复图层");
  const pid = await app.evaluate(() => process.pid);
  alive = false;
  if (process.platform === "win32")
    await promisify(execFile)(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
    );
  else process.kill(pid, "SIGKILL");
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  await launch();
  await expect(
    page.getByRole("button", { name: "恢复上次项目", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复上次项目", exact: true }).click();
  await expect(page.getByLabel("图层名称")).toHaveValue("恢复图层");
  await expect(page.locator(".dirty-dot")).toBeVisible();
  const target = path.join(directory, "restored.bgcomp");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator(".toast")).toContainText("项目已保存");
  await expect
    .poll(() => page.evaluate(() => window.desktop!.readRecovery()))
    .toBe(null);
  expect(JSON.parse(await fs.readFile(target, "utf8")).layers[0].name).toBe(
    "恢复图层",
  );
});
test("phone viewport keeps local project editing and connection controls accessible", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /打开示例/ }).click();
  await expect(page.locator(".layer-row")).toHaveCount(5);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("button", { name: "账户与连接", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "账户与连接", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "账户与连接" })).toContainText(
    "在线服务尚未开通",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: "test-results/phone-layout.png" });
});
test("software filter fallback edits the shared bgcomp sample when native Canvas filter is unavailable", async () => {
  await page.evaluate(() =>
    Reflect.deleteProperty(CanvasRenderingContext2D.prototype, "filter"),
  );
  const sample = JSON.parse(
    await fs.readFile("fixtures/shared.bgcomp", "utf8"),
  );
  sample.layers[0].adjustments.brightness = -100;
  const target = path.join(directory, "fallback.bgcomp");
  await fs.writeFile(target, JSON.stringify(sample));
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, target);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await expect(page.locator(".artboard")).toBeVisible();
  expect(
    await page
      .locator(".image-canvas")
      .evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext("2d")!.getImageData(32, 32, 1, 1).data,
      ]),
  ).toEqual([0, 0, 0, 255]);
  await expect(page.getByLabel("图层名称")).toHaveValue("可编辑红色图层");
});
