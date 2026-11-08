export const BLENDS = [
  ["source-over", "正常"],
  ["multiply", "正片叠底"],
  ["screen", "滤色"],
  ["overlay", "叠加"],
  ["darken", "变暗"],
  ["lighten", "变亮"],
  ["color-dodge", "颜色减淡"],
  ["color-burn", "颜色加深"],
  ["hard-light", "强光"],
  ["soft-light", "柔光"],
  ["difference", "差值"],
  ["exclusion", "排除"],
  ["hue", "色相"],
  ["saturation", "饱和度"],
  ["color", "颜色"],
  ["luminosity", "明度"],
] as const;
export const FONTS = ["Segoe UI", "Arial", "Georgia", "Consolas", "sans-serif", "serif", "monospace"] as const;
export type Blend = (typeof BLENDS)[number][0];
export type TextAlign = "left" | "center" | "right";
export type LayerKind = "raster" | "text" | "shape" | "adjustment";
export type SelectionKind = "rect" | "ellipse" | "lasso" | "polygon" | "wand";
export type SelectionMode = "replace" | "add" | "subtract";
export type ShapeKind = "rectangle" | "ellipse" | "line" | "polygon";
export type AdjustmentType =
  | "levels"
  | "curves"
  | "hueSat"
  | "exposure"
  | "bw";

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  blur: number;
}

export interface AdjustmentLayerParams {
  type: AdjustmentType;
  /** Levels: black / mid / white (0–255, mid as gamma 0.1–9.9 scaled as 10–990). */
  levelsBlack: number;
  levelsMid: number;
  levelsWhite: number;
  /** Curves as 0–255 control points (input→output), length 2–16. */
  curve: number[];
  hue: number;
  sat: number;
  lightness: number;
  exposure: number;
  gamma: number;
  bwAmount: number;
}

export interface TextContent {
  value: string;
  font: (typeof FONTS)[number];
  size: number;
  color: string;
  bold: boolean;
  align?: TextAlign;
  /** Set when the requested font was unavailable and a fallback was used. */
  missingFont?: string;
}

export interface ShapeContent {
  kind: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Local-space points for polygon/line; empty for rect/ellipse. */
  points: { x: number; y: number }[];
}

export interface LayerMaskData {
  image: string;
  inverted: boolean;
  feather: number;
  disabled: boolean;
}

export interface LayerData {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: Blend;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  adjustments: Adjustments;
  image: string;
  text?: TextContent;
  shape?: ShapeContent;
  kind?: LayerKind;
  mask?: LayerMaskData;
  clipToBelow?: boolean;
  adjustment?: AdjustmentLayerParams;
}

export interface ProjectData {
  format: "bgssai-compositor";
  version: 1;
  name: string;
  width: number;
  height: number;
  layers: LayerData[];
  selection?: SelectionData;
  history?: ProjectHistory;
}

export interface SelectionData {
  kind: SelectionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Point[];
  image?: string;
}

export interface ProjectHistory {
  entries: { json: string; label: string; selectedId: string }[];
  index: number;
}

export const MAX_HISTORY_ENTRIES = 30;
export const MAX_HISTORY_BYTES = 96 * 1024 * 1024;

export const MAX_DIMENSION = 8192;
export const MAX_DOCUMENT_PIXELS = 16_777_216;
export const MAX_LAYER_PIXELS = 48_000_000;
export const MAX_LAYERS = 40;
export const MAX_PROJECT_BYTES = 128 * 1024 * 1024;

export const defaults = (): Adjustments => ({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
});

export const defaultAdjustment = (
  type: AdjustmentType = "levels",
): AdjustmentLayerParams => ({
  type,
  levelsBlack: 0,
  levelsMid: 100,
  levelsWhite: 255,
  curve: [0, 64, 128, 192, 255],
  hue: 0,
  sat: 0,
  lightness: 0,
  exposure: 0,
  gamma: 1,
  bwAmount: 100,
});

export function checkDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_DOCUMENT_PIXELS
  ) {
    throw new Error(
      "宽高须为 1–8192 的整数，总像素不超过 1677 万（如 4096 × 4096）。",
    );
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("项目结构无效。");
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error("项目中的数值超出允许范围。");
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("项目中的文字数据无效或过长。");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("项目中的图层属性无效。");
  return value;
}

// Inspect IHDR before asking the image decoder to allocate memory.
export function pngDimensions(data: string): { width: number; height: number } {
  const prefix = "data:image/png;base64,";
  if (!data.startsWith(prefix)) throw new Error("项目图层必须使用内嵌 PNG。");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(data.slice(prefix.length, prefix.length + 44)),
      (char) => char.charCodeAt(0),
    );
  } catch {
    throw new Error("PNG 图层数据损坏。");
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 24 ||
    signature.some((byte, i) => bytes[i] !== byte) ||
    String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
  )
    throw new Error("PNG 图层数据损坏。");
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  checkDimensions(width, height);
  return { width, height };
}

function parseText(value: unknown): TextContent {
  const t = record(value);
  const font = string(t.font, 32) as TextContent["font"];
  if (!FONTS.includes(font) || !/^#[0-9a-f]{6}$/i.test(string(t.color, 7)))
    throw new Error("文本图层样式无效。");
  const text: TextContent = {
    value: string(t.value, 10000),
    font,
    size: number(t.size, 1, 512),
    color: t.color as string,
    bold: boolean(t.bold),
  };
  if (t.align !== undefined) {
    const align = string(t.align, 16);
    if (align !== "left" && align !== "center" && align !== "right")
      throw new Error("文本图层样式无效。");
    text.align = align;
  }
  if (t.missingFont !== undefined) text.missingFont = string(t.missingFont, 200);
  return text;
}

function parseShape(value: unknown): ShapeContent {
  const s = record(value);
  const kind = string(s.kind, 32) as ShapeKind;
  if (!["rectangle", "ellipse", "line", "polygon"].includes(kind))
    throw new Error("形状图层数据无效。");
  if (!/^#[0-9a-f]{6}$/i.test(string(s.fill, 7)))
    throw new Error("形状图层数据无效。");
  if (!/^#[0-9a-f]{6}$/i.test(string(s.stroke, 7)))
    throw new Error("形状图层数据无效。");
  if (!Array.isArray(s.points) || s.points.length > 256)
    throw new Error("形状图层数据无效。");
  const points = s.points.map((point) => {
    const p = record(point);
    return { x: number(p.x, -100000, 100000), y: number(p.y, -100000, 100000) };
  });
  return {
    kind,
    fill: s.fill as string,
    stroke: s.stroke as string,
    strokeWidth: number(s.strokeWidth, 0, 200),
    points,
  };
}

function parseMask(value: unknown): LayerMaskData {
  const m = record(value);
  const image = string(m.image, MAX_PROJECT_BYTES);
  pngDimensions(image);
  return {
    image,
    inverted: boolean(m.inverted),
    feather: number(m.feather, 0, 250),
    disabled: boolean(m.disabled),
  };
}

function parseAdjustment(value: unknown): AdjustmentLayerParams {
  const a = record(value);
  const type = string(a.type, 32) as AdjustmentType;
  if (!["levels", "curves", "hueSat", "exposure", "bw"].includes(type))
    throw new Error("调整图层参数无效。");
  if (!Array.isArray(a.curve) || a.curve.length < 2 || a.curve.length > 16)
    throw new Error("调整图层参数无效。");
  const curve = a.curve.map((c) => number(c, 0, 255));
  return {
    type,
    levelsBlack: number(a.levelsBlack, 0, 255),
    levelsMid: number(a.levelsMid, 10, 990),
    levelsWhite: number(a.levelsWhite, 0, 255),
    curve,
    hue: number(a.hue, -180, 180),
    sat: number(a.sat, -100, 100),
    lightness: number(a.lightness, -100, 100),
    exposure: number(a.exposure, -5, 5),
    gamma: number(a.gamma, 0.1, 9.9),
    bwAmount: number(a.bwAmount, 0, 100),
  };
}

function parseSelection(value: unknown, width: number, height: number): SelectionData {
  const data = record(value);
  const kind = string(data.kind, 16) as SelectionKind;
  if (!["rect", "ellipse", "lasso", "polygon", "wand"].includes(kind))
    throw new Error("选区类型无效。");
  const selection: SelectionData = {
    kind,
    x: number(data.x, 0, width),
    y: number(data.y, 0, height),
    width: number(data.width, 0, width),
    height: number(data.height, 0, height),
  };
  if (selection.width <= 0 || selection.height <= 0 ||
      selection.x + selection.width > width || selection.y + selection.height > height)
    throw new Error("选区超出画布范围。");
  if (data.points !== undefined) {
    if (!Array.isArray(data.points) || data.points.length > 20000)
      throw new Error("选区点数超出允许范围。");
    selection.points = data.points.map((value) => {
      const point = record(value);
      return { x: number(point.x, -100000, 100000), y: number(point.y, -100000, 100000) };
    });
  }
  if (data.image !== undefined) {
    selection.image = string(data.image, MAX_PROJECT_BYTES);
    const size = pngDimensions(selection.image);
    if (size.width !== width || size.height !== height)
      throw new Error("选区遮罩尺寸与画布不一致。");
  }
  if (kind === "wand" && !selection.image)
    throw new Error("魔棒选区缺少遮罩。");
  return selection;
}

export function parseProject(json: string): ProjectData {
  return parseProjectDocument(json, true);
}

function parseProjectDocument(json: string, allowHistory: boolean): ProjectData {
  if (new TextEncoder().encode(json).byteLength > MAX_PROJECT_BYTES)
    throw new Error("项目文件超过 128 MB。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("项目文件不是有效的 JSON。");
  }
  const data = record(parsed);
  if (!allowHistory && data.history !== undefined)
    throw new Error("历史快照不能包含嵌套历史。");
  if (data.format !== "bgssai-compositor" || data.version !== 1)
    throw new Error("不支持的项目格式或版本。");
  const width = number(data.width, 1, MAX_DIMENSION);
  const height = number(data.height, 1, MAX_DIMENSION);
  checkDimensions(width, height);
  if (
    !Array.isArray(data.layers) ||
    data.layers.length < 1 ||
    data.layers.length > MAX_LAYERS
  )
    throw new Error("项目须包含 1–40 个图层。");
  let pixels = 0;
  const ids = new Set<string>();
  const layers = data.layers.map((value): LayerData => {
    const layer = record(value);
    const adj = record(layer.adjustments);
    const id = string(layer.id, 100);
    if (!id || ids.has(id)) throw new Error("图层 ID 重复或为空。");
    ids.add(id);
    const image = string(layer.image, MAX_PROJECT_BYTES);
    const dimensions = pngDimensions(image);
    pixels += dimensions.width * dimensions.height;
    if (pixels > MAX_LAYER_PIXELS)
      throw new Error("所有图层总像素超过 4800 万。");
    const blend = string(layer.blend, 32) as Blend;
    if (!BLENDS.some(([mode]) => mode === blend))
      throw new Error("不支持的图层混合模式。");
    const result: LayerData = {
      id,
      image,
      name: string(layer.name, 200),
      visible: boolean(layer.visible),
      locked: boolean(layer.locked),
      opacity: number(layer.opacity, 0, 1),
      blend,
      x: number(layer.x, -100000, 100000),
      y: number(layer.y, -100000, 100000),
      scaleX: number(layer.scaleX, 0.01, 100),
      scaleY: number(layer.scaleY, 0.01, 100),
      rotation: number(layer.rotation, -36000, 36000),
      flipX: boolean(layer.flipX),
      flipY: boolean(layer.flipY),
      adjustments: {
        brightness: number(adj.brightness, -100, 100),
        contrast: number(adj.contrast, -100, 100),
        saturation: number(adj.saturation, -100, 200),
        blur: number(adj.blur, 0, 50),
      },
    };
    if (layer.text !== undefined) result.text = parseText(layer.text);
    if (layer.shape !== undefined) result.shape = parseShape(layer.shape);
    if (layer.kind !== undefined) {
      const kind = string(layer.kind, 32) as LayerKind;
      if (!["raster", "text", "shape", "adjustment"].includes(kind))
        throw new Error("图层类型无效。");
      result.kind = kind;
    }
    if (layer.mask !== undefined) {
      result.mask = parseMask(layer.mask);
      const maskSize = pngDimensions(result.mask.image);
      pixels += maskSize.width * maskSize.height;
      if (pixels > MAX_LAYER_PIXELS)
        throw new Error("所有图层总像素超过 4800 万。");
    }
    if (layer.clipToBelow !== undefined)
      result.clipToBelow = boolean(layer.clipToBelow);
    if (layer.adjustment !== undefined)
      result.adjustment = parseAdjustment(layer.adjustment);
    return result;
  });
  const project: ProjectData = {
    format: "bgssai-compositor",
    version: 1,
    name: string(data.name, 200),
    width,
    height,
    layers,
  };
  if (data.selection !== undefined)
    project.selection = parseSelection(data.selection, width, height);
  if (data.history !== undefined) {
    const history = record(data.history);
    if (!Array.isArray(history.entries) || history.entries.length < 1 ||
        history.entries.length > MAX_HISTORY_ENTRIES)
      throw new Error("历史记录须包含 1–30 个快照。");
    const index = history.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= history.entries.length)
      throw new Error("历史记录位置无效。");
    let bytes = 0;
    const entries = history.entries.map((value) => {
      const entry = record(value);
      const snapshot = string(entry.json, MAX_PROJECT_BYTES);
      bytes += snapshot.length * 2;
      if (bytes > MAX_HISTORY_BYTES) throw new Error("历史记录超过 96 MB。");
      const document = parseProjectDocument(snapshot, false);
      const selectedId = string(entry.selectedId, 100);
      if (!document.layers.some((layer) => layer.id === selectedId))
        throw new Error("历史记录中的选中图层无效。");
      return { json: JSON.stringify(document), label: string(entry.label, 200), selectedId };
    });
    if (entries[index].json !== JSON.stringify(project))
      throw new Error("当前工程与历史快照不一致。");
    project.history = { entries, index };
  }
  return project;
}

export interface Point {
  x: number;
  y: number;
}
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}
export function localToWorld(p: Point, g: Geometry): Point {
  const rad = (g.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = (p.x - g.width / 2) * g.scaleX * (g.flipX ? -1 : 1);
  const y = (p.y - g.height / 2) * g.scaleY * (g.flipY ? -1 : 1);
  return {
    x: g.x + (g.width * g.scaleX) / 2 + x * cos - y * sin,
    y: g.y + (g.height * g.scaleY) / 2 + x * sin + y * cos,
  };
}
export function worldToLocal(p: Point, g: Geometry): Point {
  const safeScaleX =
    Number.isFinite(g.scaleX) && Math.abs(g.scaleX) >= 1e-6 ? g.scaleX : 1;
  const safeScaleY =
    Number.isFinite(g.scaleY) && Math.abs(g.scaleY) >= 1e-6 ? g.scaleY : 1;
  const rad = (-g.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x = p.x - g.x - (g.width * safeScaleX) / 2;
  const y = p.y - g.y - (g.height * safeScaleY) / 2;
  return {
    x: (x * cos - y * sin) / (safeScaleX * (g.flipX ? -1 : 1)) + g.width / 2,
    y: (x * sin + y * cos) / (safeScaleY * (g.flipY ? -1 : 1)) + g.height / 2,
  };
}

export const MAX_RECOVERY_DIMENSION = 16384;

const BLEND_ALIASES: Record<string, Blend> = {
  normal: "source-over",
  "source-over": "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color dodge": "color-dodge",
  colordodge: "color-dodge",
  "color-burn": "color-burn",
  "color burn": "color-burn",
  colorburn: "color-burn",
  "hard-light": "hard-light",
  "hard light": "hard-light",
  hardlight: "hard-light",
  "soft-light": "soft-light",
  "soft light": "soft-light",
  softlight: "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export function clampCanvasDimension(
  value: unknown,
  fallback = 1600,
  max = MAX_RECOVERY_DIMENSION,
): number {
  const safeMax = Math.max(
    1,
    Math.min(MAX_RECOVERY_DIMENSION, Math.trunc(Number(max) || MAX_RECOVERY_DIMENSION)),
  );
  const safeFallback = Math.max(
    1,
    Math.min(safeMax, Math.trunc(Number(fallback) || 1600)),
  );
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return safeFallback;
  const rounded = Math.round(numeric);
  return Math.max(1, Math.min(safeMax, rounded));
}

export function clampOpacity(value: unknown, fallback = 1): number {
  const safeFallback =
    typeof fallback === "number" && Number.isFinite(fallback)
      ? Math.max(0, Math.min(1, fallback))
      : 1;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return safeFallback;
  return Math.max(0, Math.min(1, numeric));
}

export function normalizeBlendMode(
  value: unknown,
  fallback: Blend = "source-over",
): Blend {
  if (typeof value !== "string") return fallback;
  const key = value.trim().toLowerCase();
  if (BLEND_ALIASES[key]) return BLEND_ALIASES[key];
  const byLabel = BLENDS.find(([, label]) => label === value.trim());
  if (byLabel) return byLabel[0];
  return fallback;
}

export interface ClampedTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  clamped: boolean;
}

export function clampLayerTransform(
  input: Record<string, unknown>,
): ClampedTransform {
  let clamped = false;
  const clampNum = (
    raw: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      clamped = true;
      return fallback;
    }
    if (raw < min || raw > max) {
      clamped = true;
      return Math.max(min, Math.min(max, raw));
    }
    return raw;
  };
  const x = clampNum(input.x, -100000, 100000, 0);
  const y = clampNum(input.y, -100000, 100000, 0);
  const scaleX = clampNum(input.scaleX, 0.01, 100, 1);
  const scaleY = clampNum(input.scaleY, 0.01, 100, 1);
  const rotation = clampNum(input.rotation, -36000, 36000, 0);
  const flipX = typeof input.flipX === "boolean" ? input.flipX : false;
  const flipY = typeof input.flipY === "boolean" ? input.flipY : false;
  if (typeof input.flipX !== "boolean" || typeof input.flipY !== "boolean") {
    clamped = true;
  }
  return { x, y, scaleX, scaleY, rotation, flipX, flipY, clamped };
}

/** Deterministic 64-bit dual-lane FNV-1a digest for browser/Node snapshot verification. */
export function computeSnapshotChecksum(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 ^= code & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code >>> 8) & 0xff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}-${content.length.toString(16)}`;
}

export interface SnapshotEnvelope {
  schemaVersion: 1;
  content: string;
  checksum: string;
  sequence: number;
  writtenAt: number;
}

export function createSnapshotEnvelope(
  content: string,
  sequence = 1,
  writtenAt = Date.now(),
): SnapshotEnvelope {
  parseProject(content);
  return {
    schemaVersion: 1,
    content,
    checksum: computeSnapshotChecksum(content),
    sequence: Math.max(1, Math.trunc(sequence)),
    writtenAt: Number.isFinite(writtenAt) ? writtenAt : Date.now(),
  };
}

export function verifySnapshotEnvelope(
  envelope: unknown,
  options: { allowSalvage?: boolean } = {},
): {
  valid: boolean;
  salvaged: boolean;
  envelope: SnapshotEnvelope | null;
  project: ProjectData | null;
  reason?: string;
} {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { valid: false, salvaged: false, envelope: null, project: null, reason: "快照外壳不是有效对象" };
  }
  const raw = envelope as Record<string, unknown>;
  if (typeof raw.content !== "string" || !raw.content) {
    return { valid: false, salvaged: false, envelope: null, project: null, reason: "快照缺少项目内容" };
  }
  if (!Number.isFinite(raw.writtenAt)) {
    return { valid: false, salvaged: false, envelope: null, project: null, reason: "快照写入时间戳无效" };
  }
  const expectedChecksum = computeSnapshotChecksum(raw.content);
  if (typeof raw.checksum === "string" && raw.checksum !== expectedChecksum) {
    return { valid: false, salvaged: false, envelope: null, project: null, reason: "快照校验和不匹配" };
  }
  const sequence =
    typeof raw.sequence === "number" && Number.isSafeInteger(raw.sequence) && raw.sequence > 0
      ? raw.sequence
      : 1;
  try {
    const project = parseProject(raw.content);
    return {
      valid: true,
      salvaged: false,
      envelope: {
        schemaVersion: 1,
        content: raw.content,
        checksum: expectedChecksum,
        sequence,
        writtenAt: raw.writtenAt as number,
      },
      project,
    };
  } catch (error) {
    if (!options.allowSalvage) {
      return {
        valid: false,
        salvaged: false,
        envelope: null,
        project: null,
        reason: (error as Error).message,
      };
    }
    try {
      const recovered = recoverProjectState(raw.content);
      return {
        valid: true,
        salvaged: true,
        envelope: {
          schemaVersion: 1,
          content: recovered.json,
          checksum: computeSnapshotChecksum(recovered.json),
          sequence,
          writtenAt: raw.writtenAt as number,
        },
        project: recovered.project,
      };
    } catch (salvageError) {
      return {
        valid: false,
        salvaged: false,
        envelope: null,
        project: null,
        reason: (salvageError as Error).message,
      };
    }
  }
}

export interface QuarantinedLayerReport {
  index: number;
  id: string;
  name: string;
  reason: string;
  action: "clamped" | "quarantined" | "mask_dropped";
}

export interface ProjectRecoveryResult {
  project: ProjectData;
  json: string;
  recovered: boolean;
  clampedCanvas: boolean;
  quarantinedLayers: QuarantinedLayerReport[];
}

/**
 * Non-destructive layer & canvas state recovery guard:
 * - Clamps canvas dimensions within 1..16384 and fits document pixel budget (MAX_DIMENSION / MAX_DOCUMENT_PIXELS)
 * - Clamps layer opacity (0..1), blend modes, transforms, and adjustments
 * - Quarantines corrupted layers or corrupted layer masks without losing valid sibling layers
 */
export function recoverProjectState(
  json: string,
  options: { maxDimension?: number; fallbackPng?: string } = {},
): ProjectRecoveryResult {
  if (new TextEncoder().encode(json).byteLength > MAX_PROJECT_BYTES) {
    throw new Error("项目文件超过 128 MB。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("项目文件不是有效的 JSON。");
  }
  const data = record(parsed);
  if (data.format !== "bgssai-compositor" || data.version !== 1) {
    throw new Error("不支持的项目格式或版本。");
  }

  const maxAllowed = clampCanvasDimension(
    options.maxDimension ?? MAX_DIMENSION,
    MAX_DIMENSION,
    MAX_RECOVERY_DIMENSION,
  );
  const rawW = typeof data.width === "number" ? data.width : Number(data.width);
  const rawH = typeof data.height === "number" ? data.height : Number(data.height);
  let width = clampCanvasDimension(rawW, 1600, Math.min(maxAllowed, MAX_DIMENSION));
  let height = clampCanvasDimension(rawH, 1000, Math.min(maxAllowed, MAX_DIMENSION));
  let clampedCanvas =
    !Number.isInteger(rawW) ||
    !Number.isInteger(rawH) ||
    width !== rawW ||
    height !== rawH;
  if (width * height > MAX_DOCUMENT_PIXELS) {
    const ratio = Math.sqrt(MAX_DOCUMENT_PIXELS / (width * height));
    width = Math.max(1, Math.min(MAX_DIMENSION, Math.floor(width * ratio)));
    height = Math.max(1, Math.min(MAX_DIMENSION, Math.floor(height * ratio)));
    clampedCanvas = true;
  }

  if (!Array.isArray(data.layers) || data.layers.length === 0) {
    throw new Error("项目须包含 1–40 个图层。");
  }

  const quarantinedLayers: QuarantinedLayerReport[] = [];
  const validLayers: LayerData[] = [];
  const usedIds = new Set<string>();
  let totalPixels = 0;

  const rawLayers = data.layers.slice(0, MAX_LAYERS);
  if (data.layers.length > MAX_LAYERS) {
    quarantinedLayers.push({
      index: MAX_LAYERS,
      id: "overflow",
      name: "超出上限图层",
      reason: `图层数量超过 ${MAX_LAYERS} 上限，已截断多余图层`,
      action: "quarantined",
    });
  }

  for (let index = 0; index < rawLayers.length; index++) {
    const rawItem = rawLayers[index];
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
      quarantinedLayers.push({
        index,
        id: `layer-corrupt-${index + 1}`,
        name: `损坏图层 ${index + 1}`,
        reason: "图层记录不是有效对象",
        action: "quarantined",
      });
      continue;
    }
    const layer = rawItem as Record<string, unknown>;
    const rawName =
      typeof layer.name === "string" && layer.name.trim()
        ? layer.name.trim().slice(0, 200)
        : `图层 ${index + 1}`;
    let id =
      typeof layer.id === "string" && layer.id.trim()
        ? layer.id.trim().slice(0, 80)
        : `layer-${index + 1}`;
    let layerClamped = false;
    const clampReasons: string[] = [];

    if (usedIds.has(id)) {
      id = `${id}-recovered-${index + 1}`;
      layerClamped = true;
      clampReasons.push("重复图层 ID 已重命名");
    }

    if (typeof layer.image !== "string") {
      quarantinedLayers.push({
        index,
        id,
        name: rawName,
        reason: "缺少内嵌 PNG 图像数据",
        action: "quarantined",
      });
      continue;
    }

    let imgDims: { width: number; height: number };
    try {
      imgDims = pngDimensions(layer.image);
    } catch (error) {
      quarantinedLayers.push({
        index,
        id,
        name: rawName,
        reason: (error as Error).message,
        action: "quarantined",
      });
      continue;
    }

    if (totalPixels + imgDims.width * imgDims.height > MAX_LAYER_PIXELS) {
      quarantinedLayers.push({
        index,
        id,
        name: rawName,
        reason: "图层累计像素超出 4800 万预算",
        action: "quarantined",
      });
      continue;
    }
    totalPixels += imgDims.width * imgDims.height;
    usedIds.add(id);

    const opacity = clampOpacity(layer.opacity, 1);
    if (layer.opacity !== opacity) {
      layerClamped = true;
      clampReasons.push("不透明度已钳制至 0..1");
    }

    const blend = normalizeBlendMode(layer.blend, "source-over");
    if (layer.blend !== blend) {
      layerClamped = true;
      clampReasons.push("混合模式已归一化");
    }

    const transform = clampLayerTransform(layer);
    if (transform.clamped) {
      layerClamped = true;
      clampReasons.push("几何变换参数已钳制至安全边界");
    }

    const rawAdj =
      layer.adjustments && typeof layer.adjustments === "object" && !Array.isArray(layer.adjustments)
        ? (layer.adjustments as Record<string, unknown>)
        : {};
    const clampAdj = (val: unknown, min: number, max: number, fb: number) => {
      if (typeof val !== "number" || !Number.isFinite(val)) {
        layerClamped = true;
        return fb;
      }
      if (val < min || val > max) {
        layerClamped = true;
        return Math.max(min, Math.min(max, val));
      }
      return val;
    };
    const adjustments: Adjustments = {
      brightness: clampAdj(rawAdj.brightness, -100, 100, 0),
      contrast: clampAdj(rawAdj.contrast, -100, 100, 0),
      saturation: clampAdj(rawAdj.saturation, -100, 200, 0),
      blur: clampAdj(rawAdj.blur, 0, 50, 0),
    };

    const recoveredLayer: LayerData = {
      id,
      name: rawName,
      visible: typeof layer.visible === "boolean" ? layer.visible : true,
      locked: typeof layer.locked === "boolean" ? layer.locked : false,
      opacity,
      blend,
      x: transform.x,
      y: transform.y,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      rotation: transform.rotation,
      flipX: transform.flipX,
      flipY: transform.flipY,
      adjustments,
      image: layer.image,
    };

    if (layer.kind !== undefined) {
      if (
        typeof layer.kind === "string" &&
        ["raster", "text", "shape", "adjustment"].includes(layer.kind)
      ) {
        recoveredLayer.kind = layer.kind as LayerKind;
      } else {
        recoveredLayer.kind = "raster";
        layerClamped = true;
        clampReasons.push("无效图层类型已回退为 raster");
      }
    }

    if (layer.text !== undefined) {
      try {
        recoveredLayer.text = parseText(layer.text);
      } catch {
        layerClamped = true;
        clampReasons.push("损坏文字元数据已剥离并保留栅格像素");
      }
    }

    if (layer.shape !== undefined) {
      try {
        recoveredLayer.shape = parseShape(layer.shape);
      } catch {
        layerClamped = true;
        clampReasons.push("损坏形状元数据已剥离并保留栅格像素");
      }
    }

    if (layer.adjustment !== undefined) {
      try {
        recoveredLayer.adjustment = parseAdjustment(layer.adjustment);
      } catch {
        recoveredLayer.adjustment = defaultAdjustment();
        layerClamped = true;
        clampReasons.push("损坏调整图层参数已重置为默认值");
      }
    }

    if (layer.clipToBelow !== undefined) {
      recoveredLayer.clipToBelow = Boolean(layer.clipToBelow);
    }

    if (layer.mask !== undefined) {
      try {
        const parsedMask = parseMask(layer.mask);
        const maskSize = pngDimensions(parsedMask.image);
        if (totalPixels + maskSize.width * maskSize.height <= MAX_LAYER_PIXELS) {
          totalPixels += maskSize.width * maskSize.height;
          recoveredLayer.mask = parsedMask;
        } else {
          quarantinedLayers.push({
            index,
            id,
            name: rawName,
            reason: "图层蒙版超出总像素预算，已剥离蒙版",
            action: "mask_dropped",
          });
        }
      } catch (maskError) {
        quarantinedLayers.push({
          index,
          id,
          name: rawName,
          reason: `图层蒙版损坏已剥离：${(maskError as Error).message}`,
          action: "mask_dropped",
        });
      }
    }

    if (layerClamped) {
      quarantinedLayers.push({
        index,
        id,
        name: rawName,
        reason: clampReasons.join("；") || "图层属性已钳制修复",
        action: "clamped",
      });
    }

    validLayers.push(recoveredLayer);
  }

  if (validLayers.length === 0 && options.fallbackPng) {
    const dims = pngDimensions(options.fallbackPng);
    void dims;
    validLayers.push({
      id: "layer-recovered-fallback",
      name: "恢复空白图层",
      visible: true,
      locked: false,
      opacity: 1,
      blend: "source-over",
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      flipX: false,
      flipY: false,
      adjustments: defaults(),
      image: options.fallbackPng,
    });
  }

  if (validLayers.length === 0) {
    throw new Error("所有图层均已损坏，无法恢复有效图层。");
  }

  const projectName =
    typeof data.name === "string" && data.name.trim()
      ? data.name.trim().slice(0, 200)
      : "恢复文档";

  const project: ProjectData = {
    format: "bgssai-compositor",
    version: 1,
    name: projectName,
    width,
    height,
    layers: validLayers,
  };
  const serialized = JSON.stringify(project);
  parseProject(serialized);
  return {
    project,
    json: serialized,
    recovered: clampedCanvas || quarantinedLayers.length > 0,
    clampedCanvas,
    quarantinedLayers,
  };
}

export interface HistoryRingEntry {
  json: string;
  label: string;
  selectedId: string;
  sequence: number;
}

/**
 * Bounded undo/redo ring buffer with strict cursor & byte budget invariants.
 * Mirrors robbietilton/Compositor DocumentHistory semantics:
 * - No-op commits preserve future redo entries
 * - Trimming oldest entries adjusts the cursor in lockstep and retains at least 1 entry
 */
export class HistoryRingBuffer {
  entries: HistoryRingEntry[] = [];
  index = -1;
  private nextSequence = 1;
  readonly maxEntries: number;
  maxBytes: number;

  constructor(maxEntries = 30, maxBytes = 96 * 1024 * 1024) {
    this.maxEntries = Math.max(1, Math.trunc(maxEntries));
    this.maxBytes = Math.max(1024, Math.trunc(maxBytes));
  }

  get current(): HistoryRingEntry | null {
    return this.index >= 0 && this.index < this.entries.length
      ? this.entries[this.index]
      : null;
  }

  get retainedBytes(): number {
    return this.entries.reduce((total, entry) => total + entry.json.length * 2, 0);
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  reset(initial?: { json: string; label: string; selectedId: string }) {
    this.entries = [];
    this.index = -1;
    if (initial) {
      this.push(initial.json, initial.label, initial.selectedId);
    }
  }

  push(json: string, label: string, selectedId: string): boolean {
    if (!json || typeof json !== "string") {
      throw new Error("历史快照内容不能为空。");
    }
    if (this.current?.json === json) {
      // No-op edit: keep existing redo branch intact.
      return false;
    }
    if (this.index < this.entries.length - 1) {
      this.entries = this.entries.slice(0, this.index + 1);
    }
    this.entries.push({
      json,
      label: String(label || "编辑").slice(0, 100),
      selectedId: String(selectedId || ""),
      sequence: this.nextSequence++,
    });
    let bytes = this.retainedBytes;
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.maxEntries || bytes > this.maxBytes)
    ) {
      const removed = this.entries.shift()!;
      bytes -= removed.json.length * 2;
    }
    this.index = this.entries.length - 1;
    return true;
  }

  stepUndo(): HistoryRingEntry | null {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.current;
  }

  stepRedo(): HistoryRingEntry | null {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.current;
  }

  validateIntegrity(): {
    valid: boolean;
    entryCount: number;
    index: number;
    retainedBytes: number;
    issues: string[];
  } {
    const issues: string[] = [];
    if (this.entries.length === 0 && this.index !== -1) {
      issues.push("空历史栈游标必须为 -1");
    }
    if (
      this.entries.length > 0 &&
      (this.index < 0 || this.index >= this.entries.length)
    ) {
      issues.push(`历史游标 ${this.index} 超出范围 0..${this.entries.length - 1}`);
    }
    if (this.entries.length > this.maxEntries) {
      issues.push(`历史条目数 ${this.entries.length} 超出上限 ${this.maxEntries}`);
    }
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (!entry.json) issues.push(`历史条目 ${i} 缺少快照内容`);
      if (i > 0 && entry.sequence <= this.entries[i - 1].sequence) {
        issues.push(`历史条目 ${i} 序列号非单调递增`);
      }
    }
    return {
      valid: issues.length === 0,
      entryCount: this.entries.length,
      index: this.index,
      retainedBytes: this.retainedBytes,
      issues,
    };
  }
}

