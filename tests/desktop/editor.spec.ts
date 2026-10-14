import {
  _electron as electron,
  test,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectData } from "../../src/project";

let app: ElectronApplication;
let page: Page;
let temp: string;
let errors: string[];
test.beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-test-"));
  errors = [];
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.COMPOSITOR_TEST = "1";
  env.COMPOSITOR_TEST_DATA = temp;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ["."], env, timeout: 30_000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "让灵感，自由成像。" }),
  ).toBeVisible();
});
test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  if (
    path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) ||
    !path.basename(temp).startsWith("compositor-test-")
  )
    throw new Error("Unexpected temporary directory.");
  await fs.rm(temp, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
async function create(width = 64, height = 64) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("文档名称").fill("Windows 测试");
  await page.getByLabel("画布宽度").fill(String(width));
  await page.getByLabel("画布高度").fill(String(height));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建画布", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".artboard")).toBeVisible();
}
async function point(x: number, y: number) {
  const box = await page.locator(".artboard").boundingBox();
  if (!box) throw new Error("Missing artboard");
  const size = await page
    .locator(".image-canvas")
    .evaluate((canvas: HTMLCanvasElement) => ({
      w: canvas.width,
      h: canvas.height,
    }));
  return {
    x: box.x + (x / size.w) * box.width,
    y: box.y + (y / size.h) * box.height,
  };
}
async function pixel(x: number, y: number) {
  return page
    .locator(".image-canvas")
    .evaluate(
      (canvas: HTMLCanvasElement, p) => [
        ...canvas.getContext("2d")!.getImageData(p.x, p.y, 1, 1).data,
      ],
      { x, y },
    );
}
async function clickPixel(x: number, y: number) {
  const p = await point(x, y);
  await page.mouse.click(p.x, p.y);
}
async function draw(x1: number, y1: number, x2: number, y2: number) {
  const a = await point(x1, y1);
  const b = await point(x2, y2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}
async function saveTo(target: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, target);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "项目已保存",
  );
  return JSON.parse(await fs.readFile(target, "utf8")) as ProjectData;
}
async function openFrom(target: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, target);
  await page.getByRole("button", { name: "打开", exact: true }).click();
}

test("Windows desktop bridge is isolated and demo renders as editable layers", async () => {
  expect(page.url()).toBe("compositor://app/index.html");
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    ),
  ).toBe("undefined");
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): Record<string, boolean>;
      }
    ).getLastWebPreferences(),
  );
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  await page.getByRole("button", { name: /打开示例/ }).click();
  await expect(page.locator(".layer-row")).toHaveCount(5);
  expect(await pixel(0, 0)).toEqual([235, 231, 221, 255]);
  await page.screenshot({ path: "test-results/windows-demo.png" });
  await page
    .getByRole("button", { name: "使用说明", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText("首版不支持 PSD/PSB");
});

test("closing an edited document can cancel, survive a cancelled save, or discard", async () => {
  await create();
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await clickPixel(32, 32);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect(page.getByRole("dialog")).toHaveAttribute(
    "aria-label",
    "保存更改",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await app.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".dirty-dot")).toHaveCount(1);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  const closed = page.waitForEvent("close");
  await page
    .getByRole("button", { name: "不保存", exact: true })
    .click({ noWaitAfter: true })
    .catch((error) => {
      if (!page.isClosed()) throw error;
    });
  await closed;
});

test("brush, eraser, layer visibility, undo and redo change actual pixels", async () => {
  await create();
  await page.getByLabel("前景色", { exact: true }).fill("#ff0000");
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await draw(15, 32, 49, 32);
  expect(await pixel(32, 32)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "橡皮擦 (E)", exact: true }).click();
  await clickPixel(32, 32);
  expect((await pixel(32, 32))[3]).toBe(0);
  await page
    .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
    .click();
  await expect.poll(() => pixel(32, 32)).toEqual([255, 0, 0, 255]);
  await page
    .getByRole("button", { name: "重做 (Ctrl+Shift+Z)", exact: true })
    .click();
  await expect.poll(async () => (await pixel(32, 32))[3]).toBe(0);
  await page
    .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
    .click();
  await expect.poll(() => pixel(32, 32)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "新建图层", exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await page.getByLabel("前景色", { exact: true }).fill("#0000ff");
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await clickPixel(32, 32);
  expect(await pixel(32, 32)).toEqual([0, 0, 255, 255]);
  await page.getByRole("button", { name: "隐藏 图层 2", exact: true }).click();
  expect(await pixel(32, 32)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "显示 图层 2", exact: true }).click();
  expect(await pixel(32, 32)).toEqual([0, 0, 255, 255]);
});

test("selection clips painting and crop retains editable layer pixels", async () => {
  await create();
  await page.getByRole("button", { name: "矩形选区 (M)", exact: true }).click();
  await draw(16, 16, 48, 48);
  await page.getByLabel("前景色", { exact: true }).fill("#00ff00");
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await draw(2, 32, 62, 32);
  expect((await pixel(4, 32))[3]).toBe(0);
  expect(await pixel(32, 32)).toEqual([0, 255, 0, 255]);
  expect((await pixel(58, 32))[3]).toBe(0);
  await page.getByRole("button", { name: "矩形选区 (M)", exact: true }).click();
  await page.getByRole("button", { name: "裁切画布", exact: true }).click();
  expect(
    await page
      .locator(".image-canvas")
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]),
  ).toEqual([32, 32]);
  expect(await pixel(16, 16)).toEqual([0, 255, 0, 255]);
  await page
    .getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true })
    .click();
  await expect
    .poll(() =>
      page.locator(".image-canvas").evaluate((c: HTMLCanvasElement) => c.width),
    )
    .toBe(64);
});

test("project round trip preserves text, transforms and layers; PNG/JPEG export writes valid files", async () => {
  await create(256, 128);
  await page.getByRole("button", { name: "矩形 (U)", exact: true }).click();
  await draw(8, 8, 100, 100);
  await page.getByRole("button", { name: "文字 (T)", exact: true }).click();
  await clickPixel(40, 30);
  await page.getByLabel("文字内容", { exact: true }).fill("你好 Windows");
  await page.getByLabel("字号", { exact: true }).fill("24");
  await page.getByLabel("字号", { exact: true }).press("Enter");
  await page.getByLabel("旋转", { exact: true }).fill("12");
  await page.getByLabel("旋转", { exact: true }).press("Enter");
  const projectPath = path.join(temp, "test.bgcomp");
  const data = await saveTo(projectPath);
  expect(data.layers).toHaveLength(3);
  expect(data.layers[2].text?.value).toBe("你好 Windows");
  expect(data.layers[2].text?.size).toBe(24);
  expect(data.layers[2].rotation).toBe(12);
  await page.getByRole("button", { name: "删除图层", exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await openFrom(projectPath);
  await page.getByRole("button", { name: "不保存", exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(3);
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveValue(
    "你好 Windows",
  );
  const pngPath = path.join(temp, "output.png");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pngPath);
  await page
    .getByRole("button", { name: "导出图像", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导出图像", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "图像已导出",
  );
  expect([...(await fs.readFile(pngPath)).subarray(0, 8)]).toEqual([
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  const jpgPath = path.join(temp, "output.jpg");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, jpgPath);
  await page
    .getByRole("button", { name: "导出图像", exact: true })
    .first()
    .click();
  await page.getByLabel("导出格式").selectOption("jpeg");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "导出图像", exact: true })
    .click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "图像已导出",
  );
  expect([...(await fs.readFile(jpgPath)).subarray(0, 2)]).toEqual([255, 216]);
});

test("cancelled saving and invalid projects preserve current document and save destination", async () => {
  await create();
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await clickPixel(32, 32);
  const target = path.join(temp, "good.bgcomp");
  await saveTo(target);
  await page.getByLabel("前景色", { exact: true }).fill("#ff0000");
  await clickPixel(32, 32);
  const invalid = path.join(temp, "broken.bgcomp");
  await fs.writeFile(invalid, '{"format":"broken"}');
  await openFrom(invalid);
  await page.getByRole("button", { name: "不保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不支持的项目格式");
  await expect(page.locator(".layer-row")).toHaveCount(1);
  expect(await pixel(32, 32)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText(
    "项目已保存",
  );
  expect(
    (JSON.parse(await fs.readFile(target, "utf8")) as ProjectData).layers[0]
      .image,
  ).not.toBe("");
  expect(await fs.readFile(invalid, "utf8")).toBe('{"format":"broken"}');
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建画布", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await clickPixel(32, 32);
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  });
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建画布", exact: true })
    .click();
  await page.getByRole("button", { name: "保存并继续", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAttribute(
    "aria-label",
    "新建画布",
  );
  await expect(page.locator(".dirty-dot")).toHaveCount(1);
});

test("image import, duplicate, reordering, lock protection and movement operate on real layers", async () => {
  await create(128, 128);
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 20;
    c.height = 10;
    const context = c.getContext("2d")!;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 20, 10);
    return c.toDataURL();
  });
  const source = path.join(temp, "red.png");
  await fs.writeFile(source, Buffer.from(image.split(",")[1], "base64"));
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    });
  }, source);
  await page
    .getByRole("button", { name: "导入图像为图层 (Ctrl+Shift+O)", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(2);
  expect(await pixel(64, 64)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "移动 (V)", exact: true }).click();
  await draw(64, 64, 74, 74);
  await expect(page.getByLabel("X", { exact: true })).toHaveValue("64");
  await expect(page.getByLabel("Y", { exact: true })).toHaveValue("69");
  await page.getByRole("button", { name: "锁定图层", exact: true }).click();
  await expect(page.getByLabel("X", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await clickPixel(74, 74);
  await expect(page.getByRole("alert")).toContainText("解锁");
  await page.getByRole("button", { name: "解锁图层", exact: true }).click();
  await page
    .getByRole("button", { name: "复制图层 (Ctrl+J)", exact: true })
    .click();
  await expect(page.locator(".layer-row")).toHaveCount(3);
  await page.getByRole("button", { name: "下移图层", exact: true }).click();
  await expect(page.locator(".layer-row").nth(1)).toHaveClass(/active/);
});
