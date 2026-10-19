import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { describePsdLayers, importWithReport, parsePsdStructure } from "../src/io.ts";
import { decodePsdSubset } from "../src/psd-subset.ts";
import { parseProject } from "../src/project.ts";
import { assertCanSave, explainIoFailure, platformSlots } from "../src/export-guard.ts";

test("psd catalog layers stay non-editable and raster loss is explicit", () => {
  const partial = describePsdLayers(["背景", "标题"], false);
  assert.equal(partial.support, "unsupported");
  assert.ok(partial.layers.every((layer) => layer.editable === false));
  assert.ok(partial.layers.every((layer) => layer.kind !== "raster"));
  assert.ok(partial.lost.includes("可编辑文字"));
  const decoded = describePsdLayers(["背景", "标题"], true);
  assert.equal(decoded.support, "partial");
  assert.equal(decoded.layers.at(-1)?.fidelity, "rasterized");
  assert.equal(decoded.layers.at(-1)?.editable, false);
});

test("damaged psd is rejected and does not look like a saved project", () => {
  assert.throws(() => parsePsdStructure(new Uint8Array([1, 2, 3, 4])), /不是有效的 PSD/);
});

function u16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}
function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}
function i16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value, 0);
  return bytes;
}
function pascalName(name: string) {
  const raw = Buffer.from(name, "ascii");
  const body = Buffer.concat([Buffer.from([raw.length]), raw]);
  const pad = (4 - (body.length % 4)) % 4;
  return Buffer.concat([body, Buffer.alloc(pad)]);
}
function tagged(key: string, data: Buffer) {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.from([0])]) : data;
  return Buffer.concat([
    Buffer.from("8BIM", "ascii"),
    Buffer.from(key, "ascii"),
    u32(padded.length),
    padded,
  ]);
}
function utf16(value: string) {
  const body = Buffer.alloc(value.length * 2);
  for (let i = 0; i < value.length; i++) body.writeUInt16BE(value.charCodeAt(i), i * 2);
  return Buffer.concat([u32(value.length), body]);
}
function descriptorKey(id: string) {
  if (id.length === 4) return Buffer.concat([Buffer.alloc(4), Buffer.from(id, "ascii")]);
  return Buffer.concat([u32(id.length), Buffer.from(id, "ascii")]);
}
function tysh(value: string, engine: string) {
  const header = Buffer.alloc(56);
  header.writeUInt16BE(1, 0);
  header.writeDoubleBE(1, 2);
  header.writeDoubleBE(1, 26);
  header.writeUInt16BE(50, 50);
  header.writeUInt32BE(16, 52);
  const engineBytes = Buffer.from(engine, "ascii");
  const descriptor = Buffer.concat([
    utf16(""),
    descriptorKey("TxLr"),
    u32(2),
    descriptorKey("Txt "),
    Buffer.from("TEXT", "ascii"),
    utf16(value),
    descriptorKey("EngineData"),
    Buffer.from("tdta", "ascii"),
    u32(engineBytes.length),
    engineBytes,
  ]);
  return Buffer.concat([header, descriptor]);
}
function rleSolid(value: number, width: number, height: number) {
  const row = Buffer.from([(1 - width) & 0xff, value]);
  const counts = Buffer.alloc(height * 2);
  for (let y = 0; y < height; y++) counts.writeUInt16BE(row.length, y * 2);
  return Buffer.concat([counts, ...Array.from({ length: height }, () => Buffer.from(row))]);
}

interface FixtureChannel {
  id: number;
  compression: 0 | 1 | 2;
  pixels: Buffer;
  width: number;
  height: number;
}
interface FixtureLayer {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  opacity?: number;
  blend?: string;
  channels?: FixtureChannel[];
  mask?: { pixels: Buffer; flags?: number };
  tags?: { key: string; data: Buffer }[];
  text?: { value: string; engine: string };
}

function buildPsd(options: {
  width: number;
  height: number;
  depth?: number;
  colorMode?: number;
  version?: number;
  layers?: FixtureLayer[];
}) {
  const header = Buffer.alloc(26);
  header.write("8BPS", 0);
  header.writeUInt16BE(options.version ?? 1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(options.height, 14);
  header.writeUInt32BE(options.width, 18);
  header.writeUInt16BE(options.depth ?? 8, 22);
  header.writeUInt16BE(options.colorMode ?? 3, 24);
  const records: Buffer[] = [];
  const channelData: Buffer[] = [];
  for (const layer of options.layers ?? []) {
    const infos: Buffer[] = [];
    const channels = [...(layer.channels ?? [])];
    if (layer.mask) {
      channels.push({
        id: -2,
        compression: 0,
        pixels: layer.mask.pixels,
        width: layer.right - layer.left,
        height: layer.bottom - layer.top,
      });
    }
    for (const channel of channels) {
      const body =
        channel.compression === 1
          ? rleSolid(channel.pixels[0], channel.width, channel.height)
          : channel.pixels;
      const payload = Buffer.concat([u16(channel.compression), body]);
      const info = Buffer.alloc(6);
      info.writeInt16BE(channel.id, 0);
      info.writeUInt32BE(payload.length, 2);
      infos.push(info);
      channelData.push(payload);
    }
    const extraParts = [u32(layer.mask ? 20 : 0)];
    if (layer.mask) {
      const mask = Buffer.alloc(20);
      mask.writeInt32BE(layer.top, 0);
      mask.writeInt32BE(layer.left, 4);
      mask.writeInt32BE(layer.bottom, 8);
      mask.writeInt32BE(layer.right, 12);
      mask[16] = 0;
      mask[17] = layer.mask.flags ?? 0;
      extraParts.push(mask);
    }
    extraParts.push(u32(0), pascalName(layer.name));
    if (layer.text) extraParts.push(tagged("TySh", tysh(layer.text.value, layer.text.engine)));
    for (const tag of layer.tags ?? []) extraParts.push(tagged(tag.key, tag.data));
    const extra = Buffer.concat(extraParts);
    const rect = Buffer.alloc(16);
    rect.writeInt32BE(layer.top, 0);
    rect.writeInt32BE(layer.left, 4);
    rect.writeInt32BE(layer.bottom, 8);
    rect.writeInt32BE(layer.right, 12);
    records.push(
      Buffer.concat([
        rect,
        u16(infos.length),
        ...infos,
        Buffer.from("8BIM", "ascii"),
        Buffer.from((layer.blend ?? "norm").padEnd(4, " ").slice(0, 4), "ascii"),
        Buffer.from([layer.opacity ?? 255, 0, 0, 0]),
        u32(extra.length),
        extra,
      ]),
    );
  }
  const body = Buffer.concat([i16((options.layers ?? []).length), ...records, ...channelData]);
  const padded = body.length % 2 === 1 ? Buffer.concat([body, Buffer.from([0])]) : body;
  const section = Buffer.concat([u32(padded.length), padded, u32(0)]);
  return Buffer.concat([header, u32(0), u32(0), u32(section.length), section, u16(0)]);
}

function dataUrl(bytes: Buffer) {
  return `data:application/octet-stream;base64,${bytes.toString("base64")}`;
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function readPng(dataUrlValue: string) {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const bytes = Buffer.from(dataUrlValue.slice(dataUrlValue.indexOf(",") + 1), "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(Buffer.concat([type, data])));
    if (type.toString("ascii") === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type.toString("ascii") === "IDAT") idat.push(data);
    if (type.toString("ascii") === "IEND") break;
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    assert.equal(inflated[y * (stride + 1)], 0);
    inflated.copy(rgba, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return rgba;
}

const engine =
  `/FontSize 18 /Values [ 1.0 ${17 / 255} ${19 / 255} ${35 / 255} ] /Name (Arial)`;

function pixelLayer(
  name: string,
  left: number,
  rgba: [number, number, number, number],
  compression: 0 | 1,
): FixtureLayer {
  const channels = rgba.map((value, index) => ({
    id: index === 3 ? -1 : index,
    compression,
    pixels: Buffer.alloc(4, value),
    width: 2,
    height: 2,
  }));
  return {
    name,
    top: 0,
    left,
    bottom: 2,
    right: left + 2,
    channels,
  };
}

test("declared 8-bit rgb subset keeps two pixel layers, a mask and text", () => {
  const psd = buildPsd({
    width: 4,
    height: 2,
    layers: [
      pixelLayer("Red", 0, [255, 0, 0, 255], 0),
      {
        ...pixelLayer("Green", 2, [0, 255, 0, 128], 1),
        opacity: 128,
        blend: "mul ",
        mask: { pixels: Buffer.from([255, 0, 255, 0]) },
      },
      {
        ...pixelLayer("Title", 0, [255, 255, 255, 255], 0),
        text: { value: "Hello\rLine", engine },
      },
    ],
  });
  const decoded = decodePsdSubset(new Uint8Array(psd), "poster.psd");
  assert.equal(decoded.support, "editable");
  assert.equal(decoded.blocked, false);
  assert.deepEqual(decoded.lost, []);
  assert.ok(decoded.retained.includes("像素图层 Red"));
  assert.ok(decoded.retained.includes("像素图层 Green"));
  assert.ok(decoded.retained.includes("图层 Green 的用户蒙版"));
  assert.ok(decoded.retained.includes("文字图层 Title"));
  assert.ok(decoded.issues.some((issue) => issue.message.includes("不是完整 Photoshop 兼容")));
  assert.equal(decoded.layers.find((layer) => layer.name === "Title")?.kind, "text");
  assert.notEqual(decoded.layers.find((layer) => layer.name === "Title")?.note, "Title");

  const reloaded = parseProject(JSON.stringify(parseProject(JSON.stringify(decoded.project))));
  assert.equal(reloaded.name, "poster");
  assert.equal(reloaded.layers.length, 3);
  const red = readPng(reloaded.layers[0].image);
  const green = readPng(reloaded.layers[1].image);
  const title = readPng(reloaded.layers[2].image);
  assert.equal(red.toString("hex"), "ff0000ffff0000ffff0000ffff0000ff");
  assert.equal(green.subarray(0, 4).toString("hex"), "00ff0080");
  assert.equal(green.subarray(12, 16).toString("hex"), "00ff0080");
  assert.equal(title[0], 255);
  assert.equal(reloaded.layers[1].x, 2);
  assert.equal(reloaded.layers[1].blend, "multiply");
  assert.ok(Math.abs(reloaded.layers[1].opacity - 128 / 255) < 1e-12);
  const mask = readPng(reloaded.layers[1].mask!.image);
  assert.deepEqual([mask[3], mask[7], mask[11], mask[15]], [255, 0, 255, 0]);
  assert.equal(reloaded.layers[1].mask?.inverted, false);
  assert.equal(reloaded.layers[2].kind, "text");
  assert.equal(reloaded.layers[2].text?.value, "Hello\nLine");
  assert.notEqual(reloaded.layers[2].text?.value, reloaded.layers[2].name);
  assert.equal(reloaded.layers[2].text?.font, "Arial");
  assert.equal(reloaded.layers[2].text?.size, 18);
  assert.equal(
    reloaded.layers[2].text?.color,
    "#" + [17, 19, 35].map((channel) => channel.toString(16).padStart(2, "0")).join(""),
  );
  reloaded.layers[2].text!.value = "Changed";
  const edited = parseProject(JSON.stringify(reloaded));
  assert.equal(edited.layers[2].kind, "text");
  assert.equal(edited.layers[2].text?.value, "Changed");
});

test("conversion report itemizes unsupported layers and never marks them editable", () => {
  const psd = buildPsd({
    width: 4,
    height: 2,
    layers: [
      {
        ...pixelLayer("Red", 0, [1, 2, 3, 255], 0),
        tags: [{ key: "lrFX", data: Buffer.alloc(4) }],
      },
      {
        ...pixelLayer("Green", 2, [4, 5, 6, 255], 0),
        mask: { pixels: Buffer.from([255, 255, 0, 0]) },
        tags: [{ key: "vmsk", data: Buffer.alloc(4) }],
      },
      { name: "Curves", top: 0, left: 0, bottom: 0, right: 0, tags: [{ key: "curv", data: Buffer.alloc(4) }] },
      { name: "Smart", top: 0, left: 0, bottom: 0, right: 0, tags: [{ key: "SoLd", data: Buffer.alloc(4) }] },
      {
        name: "Zippy",
        top: 0,
        left: 0,
        bottom: 1,
        right: 1,
        channels: [0, 1, 2].map((id) => ({
          id,
          compression: 2 as const,
          pixels: Buffer.alloc(4),
          width: 1,
          height: 1,
        })),
      },
    ],
  });
  const decoded = decodePsdSubset(new Uint8Array(psd), "mixed.psd");
  assert.equal(decoded.support, "partial");
  assert.equal(decoded.project?.layers.length, 2);
  assert.ok(decoded.lost.includes("图层 Red 的图层效果"));
  assert.ok(decoded.lost.includes("图层 Green 的矢量蒙版"));
  assert.ok(decoded.lost.includes("调整图层 Curves"));
  assert.ok(decoded.lost.includes("智能对象 Smart"));
  assert.ok(decoded.lost.includes("图层 Zippy 的压缩方式不在子集"));
  assert.ok(decoded.layers.filter((layer) => layer.editable).every((layer) => layer.kind !== "adjustment"));
  assert.equal(decoded.layers.find((layer) => layer.name === "Curves")?.editable, false);
  assert.equal(decoded.layers.find((layer) => layer.name === "Smart")?.editable, false);
  assert.equal(decoded.layers.find((layer) => layer.name === "Zippy")?.fidelity, "catalog");
  assert.equal(decoded.layers.find((layer) => layer.name === "Green")?.editable, true);
  assert.ok(decoded.retained.includes("图层 Green 的用户蒙版"));
});

test("structure-only catalog is never fidelity editable", async () => {
  const psd = buildPsd({
    width: 8,
    height: 8,
    layers: [
      { name: "OnlyName", top: 0, left: 0, bottom: 0, right: 0 },
      { name: "Another", top: 0, left: 0, bottom: 0, right: 0 },
    ],
  });
  const decoded = decodePsdSubset(new Uint8Array(psd), "catalog.psd");
  assert.equal(decoded.project, undefined);
  assert.equal(decoded.support, "unsupported");
  assert.ok(decoded.layers.every((layer) => layer.editable === false && layer.fidelity === "catalog"));
  const report = await importWithReport("catalog.psd", dataUrl(psd));
  assert.equal(report.projectJson, undefined);
  assert.notEqual(report.support, "editable");
  assert.ok(report.layers.every((layer) => layer.editable === false && layer.fidelity !== "editable"));
});

test("cmyk, 16-bit and psb stay explicitly unsupported", () => {
  for (const [bytes, reason] of [
    [buildPsd({ width: 8, height: 8, colorMode: 4, layers: [{ name: "Ink", top: 0, left: 0, bottom: 2, right: 2 }] }), "CMYK"],
    [buildPsd({ width: 8, height: 8, depth: 16, layers: [{ name: "Deep", top: 0, left: 0, bottom: 2, right: 2 }] }), "16 位"],
    [buildPsd({ width: 8, height: 8, version: 2 }), "PSB"],
  ] as const) {
    const decoded = decodePsdSubset(new Uint8Array(bytes), "blocked.psd");
    assert.equal(decoded.blocked, true);
    assert.equal(decoded.project, undefined);
    assert.equal(decoded.support, "unsupported");
    assert.ok(decoded.lost.some((item) => item.includes(reason)));
    assert.ok(decoded.layers.every((layer) => layer.editable === false && layer.fidelity !== "editable"));
  }
});

test("missing font stays text and does not count as a successful save", () => {
  const psd = buildPsd({
    width: 2,
    height: 2,
    layers: [
      {
        ...pixelLayer("Caption", 0, [0, 0, 0, 255], 0),
        text: { value: "Keep", engine: "/FontSize 20 /Name (MissingFace)" },
      },
    ],
  });
  const decoded = decodePsdSubset(new Uint8Array(psd), "font.psd");
  const layer = decoded.project!.layers[0];
  assert.equal(layer.kind, "text");
  assert.equal(layer.text?.value, "Keep");
  assert.equal(layer.text?.missingFont, "MissingFace");
  assert.throws(() => assertCanSave([layer]), /缺少字体「MissingFace」/);
});

test("damaged or over-limit psd fails without replacing an existing project", async () => {
  const damaged = Buffer.concat([
    buildPsd({ width: 8, height: 8 }).subarray(0, 26),
    u32(40),
  ]);
  const overLimit = buildPsd({ width: 9000, height: 8 });
  const layerOverLimit = buildPsd({
    width: 8,
    height: 8,
    layers: [{ name: "Huge", top: 0, left: 0, bottom: 4000, right: 5000 }],
  });
  let current = "existing-project";
  for (const bytes of [damaged, overLimit, layerOverLimit]) {
    try {
      const report = await importWithReport("broken.psd", dataUrl(bytes));
      if (report.ok || report.projectJson) current = "replaced";
    } catch (error) {
      assert.match((error as Error).message, /PSD 图层数据损坏|宽高须为|不是有效的 PSD/);
    }
  }
  assert.equal(current, "existing-project");
  assert.throws(() => parsePsdStructure(new Uint8Array([9, 9, 9, 9])), /不是有效的 PSD/);
});

test("missing font, full disk and corrupt projects are not successes", () => {
  assert.throws(
    () => assertCanSave([{ kind: "text", text: { font: "Missing", missingFont: "Missing" } }]),
    /缺少字体「Missing」/,
  );
  assert.equal(explainIoFailure("ENOSPC").includes("磁盘空间不足"), true);
  assert.equal(explainIoFailure(undefined, "JSON parse").includes("损坏"), true);
  assert.ok(platformSlots().every((slot) => slot.status === "blocked"));
});
