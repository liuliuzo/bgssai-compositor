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
import { buildPsd, pixelLayer, engine } from "../helpers/psd-fixture";

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
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

test("unavailable authentication channels are disabled while password and Chat remain available", async () => {
  await page.getByRole("button", { name: "账户与连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "账户与连接" });
  const channels = dialog.getByLabel("登录方式");
  for (const channel of ["verification_code", "wechat", "alipay", "douyin", "baidu"]) {
    await expect(channels.locator(`option[value="${channel}"]`)).toHaveJSProperty("disabled", true);
  }
  await expect(dialog.getByRole("status")).toContainText("暂未启用");
  await expect(channels.locator('option[value="local"]')).toHaveJSProperty("disabled", false);
  await expect(channels.locator('option[value="chat"]')).toHaveJSProperty("disabled", false);
  await channels.selectOption("local");
  await expect(dialog.getByLabel("登录账号", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("登录密码", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "发送验证码", exact: true })).toHaveCount(0);
});
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

test("PSD desktop import edits two pixel layers, text and mask, then round trips and exports", async () => {
  const source = path.join(temp, "editable.psd");
  await fs.writeFile(source, buildPsd({ width: 64, height: 64, layers: [
    pixelLayer("Red", 0, [255, 0, 0, 255], 0, 16, 16),
    { ...pixelLayer("Green", 0, [0, 255, 0, 255], 1, 16, 16),
      mask: { pixels: Buffer.from(Array.from({ length: 256 }, (_, index) => index % 2 === 0 ? 255 : 0)) } },
    { ...pixelLayer("Title", 32, [255, 255, 255, 255], 0), top: 32, bottom: 34,
      text: { value: "Hello", engine } },
  ] }));
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async (...args: any[]) => {
      const filters = args.at(-1).filters as { extensions: string[] }[];
      if (!filters.every((filter) => filter.extensions.includes("psd")))
        throw new Error("原生打开对话框缺少 PSD 过滤器");
      return { canceled: false, filePaths: [filePath] };
    };
  }, source);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  const report = page.getByRole("dialog", { name: "导入转换报告" });
  await expect(report).toContainText("像素图层 Red");
  await expect(report).toContainText("像素图层 Green");
  await expect(report).toContainText("用户蒙版");
  await expect(report).toContainText("文字图层 Title");
  await report.getByRole("button", { name: "继续导入" }).click();
  await expect(page.locator(".layer-row")).toHaveCount(3);
  expect(await pixel(0, 0)).toEqual([0, 255, 0, 255]);
  expect(await pixel(1, 0)).toEqual([255, 0, 0, 255]);
  await page.getByRole("button", { name: "选择图层 Green", exact: true }).click();
  await page.getByRole("button", { name: "反相", exact: true }).click();
  expect(await pixel(0, 0)).toEqual([255, 0, 0, 255]);
  expect(await pixel(1, 0)).toEqual([0, 255, 0, 255]);
  await page.getByRole("button", { name: "羽化", exact: true }).click();
  const softened = await pixel(8, 8);
  expect(softened[0]).toBeGreaterThan(0);
  expect(softened[1]).toBeGreaterThan(0);
  for (const name of ["Red", "Green"]) {
    await page.getByRole("button", { name: `选择图层 ${name}`, exact: true }).click();
    await page.getByLabel("Y", { exact: true }).fill("4");
    await page.getByLabel("Y", { exact: true }).press("Enter");
  }
  await page.getByLabel("混合模式", { exact: true }).selectOption("screen");
  await page.getByRole("button", { name: "选择图层 Title", exact: true }).click();
  await page.getByLabel("文字内容", { exact: true }).fill("Changed");
  await page.getByLabel("文字内容", { exact: true }).blur();
  const target = path.join(temp, "editable.bgcomp");
  const saved = await saveTo(target);
  expect(saved.layers.map((layer) => layer.name)).toEqual(["Red", "Green", "Changed"]);
  expect(saved.layers.slice(0, 2).map((layer) => layer.y)).toEqual([4, 4]);
  expect(saved.layers[1].blend).toBe("screen");
  expect(saved.layers[1].mask).toMatchObject({ inverted: true, feather: 4 });
  expect(saved.layers[2].text?.value).toBe("Changed");
  await openFrom(target);
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveValue("Changed");
  expect((await saveTo(target)).layers).toEqual(saved.layers);
  const expected = await pixel(1, 4);
  const output = path.join(temp, "editable.png");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, output);
  await page.getByRole("button", { name: "导出图像", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "导出图像", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText("图像已导出");
  const exported = await app.evaluate(({ nativeImage }, filePath) => {
    const image = nativeImage.createFromPath(filePath);
    const pixels = image.toBitmap();
    const offset = (4 * image.getSize().width + 1) * 4;
    return { size: image.getSize(), pixel: [pixels[offset + 2], pixels[offset + 1], pixels[offset], pixels[offset + 3]] };
  }, output);
  expect(exported.size).toEqual({ width: 64, height: 64 });
  expect(exported.pixel).toEqual(expected);
});

test("PSD unsupported, damaged and oversized imports preserve the open project and save path", async () => {
  await create();
  const target = path.join(temp, "original.bgcomp");
  const original = await saveTo(target);
  const unsupported = [
    buildPsd({ width: 8, height: 8, colorMode: 4 }),
    buildPsd({ width: 8, height: 8, depth: 16 }),
    buildPsd({ width: 8, height: 8, depth: 32 }),
    buildPsd({ width: 8, height: 8, version: 2 }),
    buildPsd({ width: 8, height: 8, layers: [{ name: "OnlyName", top: 0, left: 0, bottom: 0, right: 0 }] }),
  ];
  for (const [index, bytes] of unsupported.entries()) {
    const source = path.join(temp, `unsupported-${index}.psd`);
    await fs.writeFile(source, bytes);
    await openFrom(source);
    const report = page.getByRole("dialog", { name: "导入转换报告" });
    await expect(report.getByRole("button", { name: "无法导入" })).toBeDisabled();
    await expect(report).toContainText("未导入可编辑图层");
    await report.getByRole("button", { name: "取消", exact: true }).click();
    expect(await fs.readFile(source)).toEqual(bytes);
  }
  for (const [index, bytes] of [Buffer.from("broken"), buildPsd({ width: 9000, height: 8 })].entries()) {
    const source = path.join(temp, `invalid-${index}.psd`);
    await fs.writeFile(source, bytes);
    await openFrom(source);
    await expect(page.getByRole("alert")).toContainText(index === 0 ? "不是有效的 PSD" : "宽高须为");
  }
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText("项目已保存");
  expect((JSON.parse(await fs.readFile(target, "utf8")) as ProjectData).layers).toEqual(original.layers);
  await expect(page.locator(".layer-row")).toHaveCount(1);
});

test("saved project retains selection and both undo and redo branches", async () => {
  await create();
  await page.getByRole("button", { name: "选区 (M)", exact: true }).click();
  await draw(16, 16, 48, 48);
  await page.getByLabel("前景色", { exact: true }).fill("#00ff00");
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await draw(2, 32, 62, 32);
  await page.getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true }).click();
  await expect.poll(async () => (await pixel(32, 32))[3]).toBe(0);
  const target = path.join(temp, "history.bgcomp");
  const saved = await saveTo(target);
  expect(saved.selection).toMatchObject({ kind: "rect", x: 16, y: 16, width: 32, height: 32 });
  expect(saved.selection?.image).toMatch(/^data:image\/png;base64,/);
  expect(saved.history!.index).toBeLessThan(saved.history!.entries.length - 1);
  await openFrom(target);
  await expect(page.locator(".selection-outline")).toBeVisible();
  await page.getByRole("button", { name: "重做 (Ctrl+Shift+Z)", exact: true }).click();
  await expect.poll(() => pixel(32, 32)).toEqual([0, 255, 0, 255]);
  expect((await pixel(4, 32))[3]).toBe(0);
  await page.getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true }).click();
  await expect.poll(async () => (await pixel(32, 32))[3]).toBe(0);
  await page.getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true }).click();
  await expect(page.locator(".selection-outline")).toHaveCount(0);
});

test("decode failures and invalid history preserve the current project and its destination", async () => {
  await create();
  const target = path.join(temp, "good.bgcomp");
  const saved = await saveTo(target);
  const before = await fs.readFile(target, "utf8");
  const invalid = structuredClone(saved);
  delete invalid.history;
  const bytes = Buffer.from(invalid.layers[0].image.split(",")[1], "base64");
  invalid.layers[0].image = `data:image/png;base64,${bytes.subarray(0, 33).toString("base64")}`;
  const source = path.join(temp, "undecodable.bgcomp");
  await fs.writeFile(source, JSON.stringify(invalid));
  await openFrom(source);
  await expect(page.getByRole("alert")).toContainText("无法读取图像");
  await expect(page.locator(".layer-row")).toHaveCount(1);
  const error = await page.evaluate(async (project) => {
    try {
      await window.desktop!.saveProject("broken", JSON.stringify({ ...project, history: { index: 0, entries: [] } }), false);
      return "incorrectly saved";
    } catch (error) { return (error as Error).message; }
  }, saved);
  expect(error).toContain("工程数据损坏");
  expect(await fs.readFile(target, "utf8")).toBe(before);
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText("项目已保存");
  expect((JSON.parse(await fs.readFile(target, "utf8")) as ProjectData).layers).toEqual(saved.layers);
  expect(await fs.readFile(source, "utf8")).toBe(JSON.stringify(invalid));
});

test("font availability is rechecked on open and blocks save without rasterizing text", async () => {
  const source = path.join(temp, "font.psd");
  await fs.writeFile(source, buildPsd({ width: 64, height: 64, layers: [
    { ...pixelLayer("Caption", 0, [0, 0, 0, 255], 0), text: { value: "Keep text", engine } },
  ] }));
  // Simulate a device without Arial; all other Canvas metrics still use the real engine.
  await page.evaluate(() => {
    const measure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function (text) {
      const font = this.font;
      if (font.includes("72px") && font.includes("Arial"))
        this.font = font.replace(/"?Arial"?,?\s*/g, "");
      const result = measure.call(this, text);
      this.font = font;
      return result;
    };
  });
  await openFrom(source);
  await page.getByRole("dialog").getByRole("button", { name: "继续导入" }).click();
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveValue("Keep text");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("缺少字体「Arial」");
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveValue("Keep text");
  await page.getByLabel("字体", { exact: true }).selectOption("sans-serif");
  const saved = await saveTo(path.join(temp, "font.bgcomp"));
  expect(saved.layers[0].kind).toBe("text");
  expect(saved.layers[0].text).toMatchObject({ value: "Keep text", font: "sans-serif" });
  expect(saved.layers[0].text?.missingFont).toBeUndefined();
});

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
  await expect(page.getByRole("dialog")).toContainText("RAW 与 CMYK 仍不支持");
  await expect(page.getByRole("dialog")).toContainText("PSD 导入为尽力而为");
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
  await page.getByRole("button", { name: "选区 (M)", exact: true }).click();
  await draw(16, 16, 48, 48);
  await page.getByLabel("前景色", { exact: true }).fill("#00ff00");
  await page.getByRole("button", { name: "画笔 (B)", exact: true }).click();
  await draw(2, 32, 62, 32);
  expect((await pixel(4, 32))[3]).toBe(0);
  expect(await pixel(32, 32)).toEqual([0, 255, 0, 255]);
  expect((await pixel(58, 32))[3]).toBe(0);
  await page.getByRole("button", { name: "选区 (M)", exact: true }).click();
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
