import {
  checkDimensions,
  defaults,
  type Blend,
  type LayerData,
  type ProjectData,
  type TextContent,
} from "./project";

/**
 * Declared PSD import subset. This is not full Photoshop compatibility.
 * Editable: version 1, 8-bit RGB, raw or PackBits channels 0/1/2 and optional
 * -1, a 20-byte user mask on channel -2, and TySh text whose descriptor has Txt.
 * CMYK, adjustment/fill layers, smart objects, layer effects, groups, vector
 * masks, ZIP channels, PSB, and 16/32-bit stay non-editable.
 */

export interface PsdSubsetLayer {
  name: string;
  kind: string;
  editable: boolean;
  fidelity: "catalog" | "rasterized" | "editable";
  note?: string;
}

export interface PsdSubsetIssue {
  severity: "info" | "warning" | "error";
  message: string;
}

export interface PsdSubsetResult {
  width: number;
  height: number;
  layers: PsdSubsetLayer[];
  issues: PsdSubsetIssue[];
  retained: string[];
  lost: string[];
  support: "partial" | "unsupported" | "editable";
  /** Unsupported file mode. Callers must not rasterize it into the open project. */
  blocked: boolean;
  project?: ProjectData;
}

const EXCLUSION_NOTE =
  "可编辑子集不是完整 Photoshop 兼容。CMYK、调整图层、智能对象、图层效果、PSB 和 16 位不会标成可编辑。";

const ADJUSTMENT_KEYS = new Set([
  "brit",
  "levl",
  "curv",
  "expA",
  "vibA",
  "hue2",
  "blnc",
  "nvrt",
  "post",
  "thrs",
  "grdm",
  "selc",
  "mixr",
  "phfl",
  "blwh",
  "clrL",
  "SoCo",
  "GdFl",
  "PtFl",
]);
const SMART_KEYS = new Set(["SoLd", "PlLd", "SoLE"]);
const EFFECT_KEYS = new Set(["lrFX", "lfx2"]);
const VECTOR_KEYS = new Set(["vmsk", "vsms"]);
const BLEND_KEYS: Record<string, Blend> = {
  norm: "source-over",
  dark: "darken",
  lite: "lighten",
  hue: "hue",
  sat: "saturation",
  colr: "color",
  lum: "luminosity",
  mul: "multiply",
  scrn: "screen",
  over: "overlay",
  hlit: "hard-light",
  slit: "soft-light",
  diff: "difference",
  smud: "exclusion",
  div: "color-dodge",
  idiv: "color-burn",
};
const FONT_MAP: Record<string, TextContent["font"]> = {
  arial: "Arial",
  arialmt: "Arial",
  georgia: "Georgia",
  consolas: "Consolas",
  "segoe ui": "Segoe UI",
  segoeui: "Segoe UI",
};

class SkipDescriptor extends Error {}

interface ChannelRef {
  id: number;
  length: number;
}

interface MaskInfo {
  top: number;
  left: number;
  bottom: number;
  right: number;
  defaultColor: number;
  flags: number;
}

interface ParsedText {
  value: string;
  font?: string;
  size?: number;
  color?: string;
  bold?: boolean;
}

interface RawLayer {
  name: string;
  top: number;
  left: number;
  bottom: number;
  opacity: number;
  clipping: number;
  flags: number;
  blendKey: string;
  channels: ChannelRef[];
  mask?: MaskInfo;
  maskRejected: boolean;
  keys: string[];
  sectionType?: number;
  text?: ParsedText;
}

function damaged(): never {
  throw new Error("PSD 图层数据损坏。");
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function u16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 16777216 +
    bytes[offset + 1] * 65536 +
    bytes[offset + 2] * 256 +
    bytes[offset + 3]
  );
}

function i16(bytes: Uint8Array, offset: number) {
  const value = u16(bytes, offset);
  return value > 0x7fff ? value - 0x10000 : value;
}

function i32(bytes: Uint8Array, offset: number) {
  const value = u32(bytes, offset);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

function requireRange(bytes: Uint8Array, offset: number, size: number) {
  if (
    offset < 0 ||
    size < 0 ||
    !Number.isFinite(offset + size) ||
    offset + size > bytes.length
  )
    damaged();
}

function readU32Bounded(bytes: Uint8Array, offset: number, end: number) {
  if (offset + 4 > end) throw new SkipDescriptor();
  return u32(bytes, offset);
}

function readUnicode(bytes: Uint8Array, offset: number, end: number) {
  const count = readU32Bounded(bytes, offset, end);
  offset += 4;
  if (count > 20000 || offset + count * 2 > end) throw new SkipDescriptor();
  let text = "";
  for (let i = 0; i < count; i++) {
    text += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
    offset += 2;
  }
  return { value: text.replace(/\0+$/g, ""), next: offset };
}

function readKey(bytes: Uint8Array, offset: number, end: number) {
  const length = readU32Bounded(bytes, offset, end);
  offset += 4;
  if (length === 0) {
    if (offset + 4 > end) throw new SkipDescriptor();
    return { value: ascii(bytes, offset, 4), next: offset + 4 };
  }
  if (length > 256 || offset + length > end) throw new SkipDescriptor();
  return { value: ascii(bytes, offset, length), next: offset + length };
}

function readOsType(
  type: string,
  bytes: Uint8Array,
  offset: number,
  end: number,
  depth: number,
): { value: unknown; next: number } {
  if (type === "Objc" || type === "GlbO" || type === "obj ") {
    const nested = readDescriptor(bytes, offset, end, depth + 1);
    return { value: nested.items, next: nested.next };
  }
  if (type === "VlLs") {
    const count = readU32Bounded(bytes, offset, end);
    offset += 4;
    if (count > 10000) throw new SkipDescriptor();
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 4 > end) throw new SkipDescriptor();
      const itemType = ascii(bytes, offset, 4);
      offset += 4;
      const item = readOsType(itemType, bytes, offset, end, depth);
      items.push(item.value);
      offset = item.next;
    }
    return { value: items, next: offset };
  }
  if (type === "TEXT") return readUnicode(bytes, offset, end);
  if (type === "enum") {
    const first = readKey(bytes, offset, end);
    const second = readKey(bytes, first.next, end);
    return { value: second.value, next: second.next };
  }
  if (type === "long") {
    if (offset + 4 > end) throw new SkipDescriptor();
    return { value: i32(bytes, offset), next: offset + 4 };
  }
  if (type === "comp") {
    if (offset + 8 > end) throw new SkipDescriptor();
    return { value: null, next: offset + 8 };
  }
  if (type === "doub") {
    if (offset + 8 > end) throw new SkipDescriptor();
    return { value: null, next: offset + 8 };
  }
  if (type === "UntF") {
    if (offset + 12 > end) throw new SkipDescriptor();
    return { value: null, next: offset + 12 };
  }
  if (type === "bool") {
    if (offset + 1 > end) throw new SkipDescriptor();
    return { value: bytes[offset] !== 0, next: offset + 1 };
  }
  if (type === "tdta" || type === "alis" || type === "Pth ") {
    const length = readU32Bounded(bytes, offset, end);
    offset += 4;
    if (length > end - offset) throw new SkipDescriptor();
    return { value: bytes.subarray(offset, offset + length), next: offset + length };
  }
  if (type === "type" || type === "GlbC") {
    const name = readUnicode(bytes, offset, end);
    const key = readKey(bytes, name.next, end);
    return { value: key.value, next: key.next };
  }
  throw new SkipDescriptor();
}

function readDescriptor(
  bytes: Uint8Array,
  offset: number,
  end: number,
  depth: number,
) {
  if (depth > 8) throw new SkipDescriptor();
  const name = readUnicode(bytes, offset, end);
  offset = name.next;
  const classId = readKey(bytes, offset, end);
  offset = classId.next;
  const count = readU32Bounded(bytes, offset, end);
  offset += 4;
  if (count > 10000) throw new SkipDescriptor();
  const items = new Map<string, unknown>();
  for (let i = 0; i < count; i++) {
    const key = readKey(bytes, offset, end);
    offset = key.next;
    if (offset + 4 > end) throw new SkipDescriptor();
    const type = ascii(bytes, offset, 4);
    offset += 4;
    const value = readOsType(type, bytes, offset, end, depth);
    items.set(key.value, value.value);
    offset = value.next;
  }
  return { items, next: offset };
}

function latin1(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function parseEngine(source: string): Omit<ParsedText, "value"> {
  const style: Omit<ParsedText, "value"> = {};
  const size = source.match(/\/FontSize\s+([0-9]+(?:\.[0-9]+)?)/);
  if (size) style.size = Number(size[1]);
  const font = source.match(/\/Name\s*\(([^)\\]*)\)/);
  if (font) style.font = font[1];
  const values = source.match(
    /\/Values\s*\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\]/,
  );
  if (values) {
    const channels = values.slice(1, 5).map(Number);
    if (channels.every((channel) => channel >= 0 && channel <= 1)) {
      const rgb = channels.slice(1).map((channel) =>
        Math.max(0, Math.min(255, Math.round(channel * 255))),
      );
      style.color =
        "#" + rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("");
    }
  }
  if (/\/(?:FauxBold|SyntheticBold)\s+true/.test(source)) style.bold = true;
  return style;
}

function parseTySh(data: Uint8Array): ParsedText | null {
  if (data.length < 56) return null;
  if (u16(data, 0) !== 1 || u16(data, 50) !== 50 || u32(data, 52) !== 16)
    return null;
  try {
    const descriptor = readDescriptor(data, 56, data.length, 0);
    const text = descriptor.items.get("Txt ");
    if (typeof text !== "string" || !text.trim()) return null;
    const engine = descriptor.items.get("EngineData");
    const style = engine instanceof Uint8Array ? parseEngine(latin1(engine)) : {};
    return { value: text, ...style };
  } catch {
    return null;
  }
}

function unpackBits(src: Uint8Array, expected: number) {
  const out = new Uint8Array(expected);
  let input = 0;
  let output = 0;
  while (output < expected) {
    if (input >= src.length) damaged();
    const marker = src[input] > 127 ? src[input] - 256 : src[input];
    input++;
    if (marker === -128) continue;
    if (marker >= 0) {
      const count = marker + 1;
      if (input + count > src.length || output + count > expected) damaged();
      out.set(src.subarray(input, input + count), output);
      input += count;
      output += count;
    } else {
      const count = 1 - marker;
      if (input >= src.length || output + count > expected) damaged();
      out.fill(src[input], output, output + count);
      input++;
      output += count;
    }
  }
  return out;
}

function decodeChannel(
  data: Uint8Array,
  width: number,
  height: number,
): Uint8Array | "unsupported" {
  if (data.length < 2) damaged();
  const compression = (data[0] << 8) | data[1];
  const body = data.subarray(2);
  const expected = width * height;
  if (compression === 0) {
    if (body.length !== expected) return "unsupported";
    return body;
  }
  if (compression !== 1) return "unsupported";
  if (body.length < height * 2) damaged();
  let offset = 0;
  const counts: number[] = [];
  for (let y = 0; y < height; y++) {
    counts.push((body[offset] << 8) | body[offset + 1]);
    offset += 2;
  }
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    if (offset + counts[y] > body.length) damaged();
    rows.push(unpackBits(body.subarray(offset, offset + counts[y]), width));
    offset += counts[y];
  }
  const out = new Uint8Array(expected);
  rows.forEach((row, index) => out.set(row, index * width));
  return out;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function adler32(data: Uint8Array) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a += data[i];
    b += a;
    if ((i & 0xfff) === 0xfff) {
      a %= 65521;
      b %= 65521;
    }
  }
  return ((((b % 65521) << 16) | (a % 65521)) >>> 0);
}

function storedZlib(raw: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.from([0x78, 0x01])];
  const max = 65535;
  const length = Math.max(raw.length, 0);
  let offset = 0;
  do {
    const end = Math.min(length, offset + max);
    const block = raw.subarray(offset, end);
    const header = new Uint8Array(5 + block.length);
    header[0] = end === length ? 1 : 0;
    header[1] = block.length & 0xff;
    header[2] = (block.length >> 8) & 0xff;
    const complement = block.length ^ 0xffff;
    header[3] = complement & 0xff;
    header[4] = (complement >> 8) & 0xff;
    header.set(block, 5);
    parts.push(header);
    offset = end;
  } while (offset < length);
  const sum = adler32(raw);
  parts.push(
    Uint8Array.from([
      (sum >>> 24) & 0xff,
      (sum >>> 16) & 0xff,
      (sum >>> 8) & 0xff,
      sum & 0xff,
    ]),
  );
  return concat(parts);
}

function pngChunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function toBase64(bytes: Uint8Array) {
  const bufferCtor = (
    globalThis as {
      Buffer?: { from(data: Uint8Array): { toString(encoding: string): string } };
    }
  ).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return out;
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array) {
  if (rgba.length !== width * height * 4) throw new Error("PNG 像素长度不正确。");
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), dest + 1);
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = concat([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
  return `data:image/png;base64,${toBase64(png)}`;
}

function solidRgba(width: number, height: number, rgba: [number, number, number, number]) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = rgba[0];
    out[i * 4 + 1] = rgba[1];
    out[i * 4 + 2] = rgba[2];
    out[i * 4 + 3] = rgba[3];
  }
  return out;
}

function hexByte(hex: string, offset: number) {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function catalog(
  name: string,
  kind: string,
  note: string,
): PsdSubsetLayer {
  return { name, kind, editable: false, fidelity: "catalog", note };
}

function blockedResult(
  fileName: string,
  width: number,
  height: number,
  reason: string,
  layers: PsdSubsetLayer[] = [],
): PsdSubsetResult {
  return {
    width,
    height,
    blocked: true,
    support: "unsupported",
    project: undefined,
    layers:
      layers.length > 0
        ? layers
        : [catalog(fileName, "unsupported", reason)],
    retained: layers.length > 0 ? ["文件头尺寸", "图层名称目录"] : ["文件头尺寸"],
    lost: [reason, "可编辑图层"],
    issues: [
      { severity: "warning", message: reason },
      { severity: "info", message: EXCLUSION_NOTE },
    ],
  };
}

function parseMask(bytes: Uint8Array, offset: number, extraEnd: number, length: number) {
  if (length !== 20 || offset + length > extraEnd) return { rejected: true as const };
  return {
    rejected: false as const,
    mask: {
      top: i32(bytes, offset),
      left: i32(bytes, offset + 4),
      bottom: i32(bytes, offset + 8),
      right: i32(bytes, offset + 12),
      defaultColor: bytes[offset + 16],
      flags: bytes[offset + 17],
    },
  };
}

function parseRecords(bytes: Uint8Array, offset: number, end: number) {
  requireRange(bytes, offset, 2);
  const count = Math.abs(i16(bytes, offset));
  offset += 2;
  if (count > 256) damaged();
  const layers: RawLayer[] = [];
  for (let index = 0; index < count; index++) {
    requireRange(bytes, offset, 18);
    const top = i32(bytes, offset);
    const left = i32(bytes, offset + 4);
    const bottom = i32(bytes, offset + 8);
    const right = i32(bytes, offset + 12);
    const channelCount = u16(bytes, offset + 16);
    offset += 18;
    if (channelCount > 56) damaged();
    const channels: ChannelRef[] = [];
    for (let channel = 0; channel < channelCount; channel++) {
      requireRange(bytes, offset, 6);
      channels.push({ id: i16(bytes, offset), length: u32(bytes, offset + 2) });
      offset += 6;
    }
    requireRange(bytes, offset, 16);
    if (ascii(bytes, offset, 4) !== "8BIM") damaged();
    const blendKey = ascii(bytes, offset + 4, 4);
    const opacity = bytes[offset + 8];
    const clipping = bytes[offset + 9];
    const flags = bytes[offset + 10];
    const extraLen = u32(bytes, offset + 12);
    offset += 16;
    requireRange(bytes, offset, extraLen);
    const extraEnd = offset + extraLen;
    let name = `图层 ${index + 1}`;
    let mask: MaskInfo | undefined;
    let maskRejected = false;
    const keys: string[] = [];
    let sectionType: number | undefined;
    let text: ParsedText | undefined;
    if (extraLen > 0) {
      if (extraLen < 8) damaged();
      const maskLen = u32(bytes, offset);
      if (4 + maskLen > extraLen) damaged();
      if (maskLen > 0) {
        const parsed = parseMask(bytes, offset + 4, extraEnd, maskLen);
        if (parsed.rejected) maskRejected = true;
        else mask = parsed.mask;
      }
      let cursor = offset + 4 + maskLen;
      if (cursor + 4 > extraEnd) damaged();
      const blendRangeLen = u32(bytes, cursor);
      cursor += 4;
      if (cursor + blendRangeLen > extraEnd) damaged();
      cursor += blendRangeLen;
      if (cursor >= extraEnd) damaged();
      const nameLen = bytes[cursor];
      if (cursor + 1 + nameLen > extraEnd) damaged();
      const rawName = ascii(bytes, cursor + 1, nameLen).replace(/\0/g, "").trim();
      if (rawName) name = rawName;
      cursor += 1 + nameLen;
      const pad = (4 - ((1 + nameLen) % 4)) % 4;
      if (cursor + pad <= extraEnd) cursor += pad;
      while (cursor + 12 <= extraEnd) {
        const signature = ascii(bytes, cursor, 4);
        if (signature !== "8BIM" && signature !== "8B64") break;
        const key = ascii(bytes, cursor + 4, 4);
        const length = u32(bytes, cursor + 8);
        const dataStart = cursor + 12;
        if (length > extraEnd - dataStart) damaged();
        const data = bytes.subarray(dataStart, dataStart + length);
        keys.push(key);
        if ((key === "lsct" || key === "lsdk") && data.length >= 4)
          sectionType = u32(data, 0);
        if (key === "luni" && data.length >= 4) {
          const chars = u32(data, 0);
          if (chars <= 200 && 4 + chars * 2 <= data.length) {
            let unicode = "";
            for (let i = 0; i < chars; i++) {
              unicode += String.fromCharCode(
                (data[4 + i * 2] << 8) | data[5 + i * 2],
              );
            }
            unicode = unicode.replace(/\0/g, "").trim();
            if (unicode) name = unicode;
          }
        }
        if (key === "TySh") text = parseTySh(data) ?? text;
        cursor = dataStart + length;
        if (length % 2 === 1 && cursor < extraEnd) cursor += 1;
      }
    }
    layers.push({
      name: name.slice(0, 200),
      top,
      left,
      bottom,
      right,
      opacity,
      clipping,
      flags,
      blendKey,
      channels,
      mask,
      maskRejected,
      keys,
      sectionType,
      text,
    });
    offset = extraEnd;
  }
  return { layers, offset };
}

function mapFont(name: string | undefined): Pick<TextContent, "font"> & {
  missingFont?: string;
} {
  if (!name) return { font: "Arial" };
  const mapped = FONT_MAP[name.trim().toLowerCase()];
  if (mapped) return { font: mapped };
  return { font: "Arial", missingFont: name.slice(0, 200) };
}

function textContent(text: ParsedText, issues: PsdSubsetIssue[], name: string): TextContent | null {
  const value = text.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!value || value.length > 10000) return null;
  let size = text.size === undefined ? 72 : Math.round(text.size);
  if (text.size === undefined)
    issues.push({
      severity: "info",
      message: `文字图层 ${name} 未含 FontSize，字号使用 72。`,
    });
  if (size < 1 || size > 512) {
    size = Math.max(1, Math.min(512, size));
    issues.push({
      severity: "warning",
      message: `文字图层 ${name} 的字号超出 1–512，已钳制。`,
    });
  }
  const color = text.color ?? "#000000";
  if (!text.color)
    issues.push({
      severity: "info",
      message: `文字图层 ${name} 未含子集颜色，使用 #000000。`,
    });
  const font = mapFont(text.font);
  if (font.missingFont)
    issues.push({
      severity: "warning",
      message: `缺少字体「${font.missingFont}」，文字仍保持可编辑，保存前需更换字体。`,
    });
  return {
    value,
    font: font.font,
    size,
    color,
    bold: text.bold === true,
    align: "left",
    ...(font.missingFont ? { missingFont: font.missingFont } : {}),
  };
}

function placeMask(
  layer: RawLayer,
  width: number,
  height: number,
  pixels: Uint8Array,
) {
  const mask = layer.mask;
  if (!mask || mask.flags & ~0x07) return null;
  const maskWidth = mask.right - mask.left;
  const maskHeight = mask.bottom - mask.top;
  if (maskWidth <= 0 || maskHeight <= 0 || pixels.length !== maskWidth * maskHeight)
    return null;
  const rgba = solidRgba(width, height, [255, 255, 255, mask.defaultColor]);
  const originLeft = mask.flags & 1 ? layer.left + mask.left : mask.left;
  const originTop = mask.flags & 1 ? layer.top + mask.top : mask.top;
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      const dx = originLeft + x - layer.left;
      const dy = originTop + y - layer.top;
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) continue;
      rgba[(dy * width + dx) * 4 + 3] = pixels[y * maskWidth + x];
    }
  }
  return rgba;
}

export function decodePsdSubset(
  bytes: Uint8Array,
  fileName = "imported.psd",
): PsdSubsetResult {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== "8BPS")
    throw new Error("不是有效的 PSD 文件。");
  const version = u16(bytes, 4);
  if (version !== 1 && version !== 2) throw new Error("不是有效的 PSD 文件。");
  const height = u32(bytes, 14);
  const width = u32(bytes, 18);
  const depth = u16(bytes, 22);
  const colorMode = u16(bytes, 24);
  checkDimensions(width, height);

  let offset = 26;
  requireRange(bytes, offset, 4);
  const colorLen = u32(bytes, offset);
  offset += 4;
  requireRange(bytes, offset, colorLen);
  offset += colorLen;
  requireRange(bytes, offset, 4);
  const resourceLen = u32(bytes, offset);
  offset += 4;
  requireRange(bytes, offset, resourceLen);
  offset += resourceLen;
  requireRange(bytes, offset, 4);
  const sectionLen = u32(bytes, offset);
  offset += 4;
  requireRange(bytes, offset, sectionLen);
  if (version !== 1)
    return blockedResult(fileName, width, height, "PSB 不在可编辑子集");

  const reason =
    depth !== 8
      ? `${depth} 位不在可编辑子集`
      : colorMode === 4
        ? "CMYK 不在可编辑子集"
        : colorMode !== 3
          ? `色彩模式 ${colorMode} 不在可编辑子集`
          : null;

  if (sectionLen === 0) {
    return reason
      ? blockedResult(fileName, width, height, reason)
      : {
          width,
          height,
          blocked: false,
          support: "unsupported",
          layers: [],
          retained: ["文件头尺寸"],
          lost: ["没有图层", "可编辑图层"],
          issues: [{ severity: "warning", message: "PSD 没有图层记录。" }],
        };
  }
  if (sectionLen < 4) damaged();
  const layerInfoLen = u32(bytes, offset);
  const layerInfoEnd = offset + 4 + layerInfoLen;
  if (layerInfoEnd > offset + sectionLen) damaged();
  const parsed = parseRecords(bytes, offset + 4, layerInfoEnd);
  const payloads: Uint8Array[][] = [];
  let cursor = parsed.offset;
  for (const layer of parsed.layers) {
    const widthPx = layer.right - layer.left;
    const heightPx = layer.bottom - layer.top;
    if (widthPx > 0 && heightPx > 0) checkDimensions(widthPx, heightPx);
    const slices: Uint8Array[] = [];
    for (const channel of layer.channels) {
      if (channel.length > 64 * 1024 * 1024) damaged();
      if (cursor + channel.length > layerInfoEnd) damaged();
      slices.push(bytes.subarray(cursor, cursor + channel.length));
      cursor += channel.length;
    }
    payloads.push(slices);
  }

  if (reason) {
    return blockedResult(
      fileName,
      width,
      height,
      reason,
      parsed.layers.map((layer) =>
        catalog(layer.name, "catalog", "只读结构目录，不是可编辑图层"),
      ),
    );
  }

  const issues: PsdSubsetIssue[] = [
    { severity: "info", message: EXCLUSION_NOTE },
  ];
  const retained: string[] = [];
  const lost: string[] = [];
  const reportLayers: PsdSubsetLayer[] = [];
  const projectLayers: LayerData[] = [];
  let pixels = 0;

  parsed.layers.forEach((layer, index) => {
    const adjustment = layer.keys.some((key) => ADJUSTMENT_KEYS.has(key));
    const smart = layer.keys.some((key) => SMART_KEYS.has(key));
    const effects = layer.keys.some((key) => EFFECT_KEYS.has(key));
    const vector = layer.keys.some((key) => VECTOR_KEYS.has(key));
    const group =
      layer.sectionType === 1 ||
      layer.sectionType === 2 ||
      layer.sectionType === 3;
    if (adjustment || smart || group) {
      const note = adjustment
        ? "调整图层或填充图层不在可编辑子集"
        : smart
          ? "智能对象不在可编辑子集"
          : "图层组不在可编辑子集";
      const kind = adjustment ? "adjustment" : smart ? "smart-object" : "group";
      reportLayers.push(catalog(layer.name, kind, note));
      lost.push(
        adjustment
          ? `调整图层 ${layer.name}`
          : smart
            ? `智能对象 ${layer.name}`
            : `图层组 ${layer.name}`,
      );
      return;
    }

    const layerWidth = layer.right - layer.left;
    const layerHeight = layer.bottom - layer.top;
    const decoded = new Map<number, Uint8Array | "unsupported">();
    layer.channels.forEach((channel, channelIndex) => {
      const maskWidth = layer.mask ? layer.mask.right - layer.mask.left : 0;
      const maskHeight = layer.mask ? layer.mask.bottom - layer.mask.top : 0;
      const channelWidth = channel.id === -2 ? maskWidth : layerWidth;
      const channelHeight = channel.id === -2 ? maskHeight : layerHeight;
      if (channelWidth <= 0 || channelHeight <= 0) {
        decoded.set(channel.id, "unsupported");
        return;
      }
      decoded.set(
        channel.id,
        decodeChannel(
          payloads[index][channelIndex],
          channelWidth,
          channelHeight,
        ),
      );
    });
    const red = decoded.get(0);
    const green = decoded.get(1);
    const blue = decoded.get(2);
    const alpha = decoded.get(-1);
    const pixelReady =
      layerWidth > 0 &&
      layerHeight > 0 &&
      red instanceof Uint8Array &&
      green instanceof Uint8Array &&
      blue instanceof Uint8Array &&
      !(alpha === "unsupported");
    const compressionLost = layer.channels.some((channel, channelIndex) => {
      const value = decoded.get(channel.id);
      return value === "unsupported" && payloads[index][channelIndex].length >= 2 &&
        u16(payloads[index][channelIndex], 0) > 1;
    });
    const text = layer.text ? textContent(layer.text, issues, layer.name) : null;
    if (!pixelReady && !text) {
      reportLayers.push(
        catalog(
          layer.name,
          "catalog",
          compressionLost
            ? "压缩方式不在可编辑子集"
            : "只读结构目录，不是可编辑图层",
        ),
      );
      lost.push(
        compressionLost
          ? `图层 ${layer.name} 的压缩方式不在子集`
          : `图层 ${layer.name} 没有可编辑像素或文字`,
      );
      return;
    }

    const previewWidth = text
      ? Math.max(1, Math.min(64, text.value.length * 8))
      : 1;
    const previewHeight = text ? Math.max(1, Math.min(64, text.size)) : 1;
    let rgba: Uint8Array;
    let imageWidth = layerWidth;
    let imageHeight = layerHeight;
    if (pixelReady) {
      rgba = new Uint8Array(layerWidth * layerHeight * 4);
      const alphaBytes = alpha instanceof Uint8Array ? alpha : null;
      for (let i = 0; i < layerWidth * layerHeight; i++) {
        rgba[i * 4] = (red as Uint8Array)[i];
        rgba[i * 4 + 1] = (green as Uint8Array)[i];
        rgba[i * 4 + 2] = (blue as Uint8Array)[i];
        rgba[i * 4 + 3] = alphaBytes ? alphaBytes[i] : 255;
      }
    } else {
      imageWidth = previewWidth;
      imageHeight = previewHeight;
      rgba = solidRgba(imageWidth, imageHeight, [
        hexByte(text!.color, 1),
        hexByte(text!.color, 3),
        hexByte(text!.color, 5),
        255,
      ]);
    }
    const image = encodeRgbaPng(imageWidth, imageHeight, rgba);
    pixels += imageWidth * imageHeight;
    const blend = BLEND_KEYS[layer.blendKey.trim().toLowerCase()] ?? "source-over";
    if (!BLEND_KEYS[layer.blendKey.trim().toLowerCase()])
      lost.push(`图层 ${layer.name} 的混合模式 ${layer.blendKey.trim() || "未知"} 未映射`);
    const projectLayer: LayerData = {
      id: `psd-${index + 1}`,
      name: layer.name,
      visible: (layer.flags & 2) === 0,
      locked: false,
      opacity: layer.opacity / 255,
      blend,
      x: layer.left,
      y: layer.top,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      flipX: false,
      flipY: false,
      adjustments: defaults(),
      image,
      kind: text ? "text" : "raster",
    };
    if (text) projectLayer.text = text;
    if (layer.clipping === 1) projectLayer.clipToBelow = true;

    let maskNote = "";
    const maskChannel = layer.channels.findIndex((channel) => channel.id === -2);
    if (maskChannel >= 0 && layer.mask && pixelReady) {
      const maskPixels = decoded.get(-2);
      const placed =
        maskPixels instanceof Uint8Array
          ? placeMask(layer, layerWidth, layerHeight, maskPixels)
          : null;
      if (placed) {
        projectLayer.mask = {
          image: encodeRgbaPng(layerWidth, layerHeight, placed),
          inverted: (layer.mask.flags & 4) !== 0,
          feather: 0,
          disabled: (layer.mask.flags & 2) !== 0,
        };
        pixels += layerWidth * layerHeight;
        retained.push(`图层 ${layer.name} 的用户蒙版`);
        maskNote = "，含简单用户蒙版";
      } else {
        lost.push(`图层 ${layer.name} 的蒙版不在子集`);
      }
    } else if (maskChannel >= 0 || layer.maskRejected) {
      lost.push(`图层 ${layer.name} 的蒙版不在子集`);
    }
    if (effects) lost.push(`图层 ${layer.name} 的图层效果`);
    if (vector) lost.push(`图层 ${layer.name} 的矢量蒙版`);
    if (pixels > 48_000_000)
      throw new Error("所有图层总像素超过 4800 万。");

    projectLayers.push(projectLayer);
    if (text) {
      retained.push(`文字图层 ${layer.name}`);
      reportLayers.push({
        name: layer.name,
        kind: "text",
        editable: true,
        fidelity: "editable",
        note: `简单文字，内容不是仅图层名${maskNote}`,
      });
    } else {
      retained.push(`像素图层 ${layer.name}`);
      reportLayers.push({
        name: layer.name,
        kind: "raster",
        editable: true,
        fidelity: "editable",
        note: `8 位 RGB 像素${maskNote}${effects ? "；图层效果未导入" : ""}`,
      });
    }
  });

  if (projectLayers.length > 40)
    throw new Error("图层上限为 40 个，总像素上限为 4800 万。请删除或合并一些图层。");
  if (projectLayers.length === 0) {
    return {
      width,
      height,
      blocked: false,
      support: "unsupported",
      layers: reportLayers,
      retained: ["文件头尺寸", "图层名称目录"],
      lost: lost.length > 0 ? lost : ["逐层像素", "蒙版", "可编辑文字"],
      issues: [
        ...issues,
        {
          severity: "warning",
          message: "没有落在声明子集内的可编辑图层。结构目录不是可编辑导入。",
        },
      ],
    };
  }

  const project: ProjectData = {
    format: "bgssai-compositor",
    version: 1,
    name: fileName.replace(/\.[^.]+$/, "").slice(0, 200) || "未命名",
    width,
    height,
    layers: projectLayers,
  };
  return {
    width,
    height,
    blocked: false,
    support: lost.length === 0 ? "editable" : "partial",
    layers: reportLayers,
    retained,
    lost,
    issues,
    project,
  };
}
