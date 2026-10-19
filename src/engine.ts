import {
  checkDimensions,
  defaultAdjustment,
  defaults,
  localToWorld,
  worldToLocal,
  MAX_LAYER_PIXELS,
  MAX_LAYERS,
  MAX_PROJECT_BYTES,
  parseProject,
  pngDimensions,
  type AdjustmentLayerParams,
  type AdjustmentType,
  type Adjustments,
  type Blend,
  type Geometry,
  type LayerData,
  type LayerKind,
  type Point,
  type ProjectData,
  type SelectionKind,
  type SelectionMode,
  type ShapeContent,
  type ShapeKind,
  type TextAlign,
  type TextContent,
} from "./project";
import {
  checkMemory,
  estimateMemory,
  DEFAULT_MEMORY_BYTES,
  HISTORY_BYTES,
} from "./memory";
import { imageDimensions } from "./image-header";
import {
  adjustPixels,
  applyAdjustmentPixels,
  blurPixels,
  featherMaskPixels,
  motionBlurPixels,
  noisePixels,
  sharpenPixels,
} from "./filters";

export type Tool =
  | "move"
  | "brush"
  | "eraser"
  | "select"
  | "rectangle"
  | "ellipse"
  | "text"
  | "eyedropper"
  | "hand"
  | "clone"
  | "heal"
  | "gradient"
  | "mask"
  | "crop"
  | "transform";

export type LayerMask = {
  canvas: HTMLCanvasElement;
  inverted: boolean;
  feather: number;
  disabled: boolean;
};

export type Layer = Omit<LayerData, "image" | "mask"> & {
  canvas: HTMLCanvasElement;
  mask?: LayerMask;
};

/** Document-space selection with optional alpha mask for non-rect kinds. */
export interface Selection {
  kind: SelectionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Document-sized grayscale mask (R channel = selection strength). */
  mask?: HTMLCanvasElement;
  points?: Point[];
}

interface Snapshot {
  json: string;
  label: string;
  selectedId: string;
}

export function makeCanvas(width: number, height: number) {
  checkDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function ctx(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法初始化图像引擎。");
  return context;
}
function layerFromCanvas(canvas: HTMLCanvasElement, name: string): Layer {
  return {
    id: crypto.randomUUID(),
    name,
    canvas,
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
    kind: "raster",
  };
}
export function geometry(layer: Layer): Geometry {
  return { ...layer, width: layer.canvas.width, height: layer.canvas.height };
}
export function corners(layer: Layer): Point[] {
  const { width, height } = layer.canvas;
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((p) => localToWorld(p, geometry(layer)));
}
async function decode(
  data: string,
  beforeAllocate?: (width: number, height: number) => void,
): Promise<HTMLCanvasElement> {
  const dimensions = imageDimensions(data);
  beforeAllocate?.(dimensions.width, dimensions.height);
  const image = new Image();
  image.src = data;
  try {
    await image.decode();
  } catch {
    throw new Error("无法读取图像，请使用有效的 PNG、JPEG、WebP 或 BMP 文件。");
  }
  checkDimensions(image.naturalWidth, image.naturalHeight);
  if (
    image.naturalWidth !== dimensions.width ||
    image.naturalHeight !== dimensions.height
  )
    throw new Error("图像实际尺寸与文件头不一致");
  const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
  ctx(canvas).drawImage(image, 0, 0);
  return canvas;
}

function emptyMask(width: number, height: number) {
  return makeCanvas(width, height);
}

function selectionBounds(mask: HTMLCanvasElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const data = ctx(mask).getImageData(0, 0, mask.width, mask.height).data;
  let minX = mask.width,
    minY = mask.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < mask.height; y++)
    for (let x = 0; x < mask.width; x++) {
      if (data[(y * mask.width + x) * 4] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function fillSelectionShape(
  context: CanvasRenderingContext2D,
  selection: Selection,
) {
  const { kind, x, y, width, height, points } = selection;
  context.beginPath();
  if (kind === "ellipse") {
    context.ellipse(
      x + width / 2,
      y + height / 2,
      Math.abs(width) / 2,
      Math.abs(height) / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else if ((kind === "lasso" || kind === "polygon") && points && points.length > 1) {
    points.forEach((p, i) =>
      i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
    );
    context.closePath();
  } else {
    context.rect(x, y, width, height);
  }
}

export class Editor {
  name = "未命名";
  width = 1600;
  height = 1000;
  layers: Layer[] = [];
  selectedId = "";
  selection: Selection | null = null;
  selectKind: SelectionKind = "rect";
  selectionMode: SelectionMode = "replace";
  cropAspect: number | null = null;
  tool: Tool = "move";
  color = "#efb87a";
  brushSize = 28;
  brushOpacity = 1;
  brushHardness = 0.8;
  cloneSource: Point | null = null;
  gradientFrom: Point | null = null;
  maskPaintMode = false;
  private listeners = new Set<() => void>();
  revision = 0;
  history: Snapshot[] = [];
  historyIndex = -1;
  private savedJSON = "";
  private pending = false;
  busy = false;
  memoryBudget = DEFAULT_MEMORY_BYTES;
  /** Baseline revision captured when an AI preview was requested. */
  aiBaselineRevision: number | null = null;
  get snapshot() {
    return this.pending
      ? null
      : (this.history[this.historyIndex]?.json ?? null);
  }
  get historyBytes() {
    return this.history.reduce(
      (total, entry) => total + entry.json.length * 2,
      0,
    );
  }
  private checkAdoption(data: ProjectData, json: string) {
    const pixels = data.layers.reduce((sum, layer) => {
      const size = pngDimensions(layer.image);
      let total = sum + size.width * size.height;
      if (layer.mask) {
        const mask = pngDimensions(layer.mask.image);
        total += mask.width * mask.height;
      }
      return total;
    }, 0);
    const softwareFilters = !("filter" in ctx(this.layers[0]?.canvas ?? makeCanvas(1, 1)));
    const filterPixels = softwareFilters
      ? Math.max(
          ...data.layers.map((layer) => {
            const adj = layer.adjustments;
            if (
              !adj.brightness &&
              !adj.contrast &&
              !adj.saturation &&
              !adj.blur
            )
              return 0;
            const size = pngDimensions(layer.image),
              padding = Math.ceil(adj.blur) * 6;
            return (size.width + padding) * (size.height + padding) * 4;
          }),
        )
      : 0;
    checkMemory(
      estimateMemory(
        pixels + this.pixelBudget + filterPixels,
        data.width * data.height + this.width * this.height,
        json.length * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
  }
  checkLayerAllocation(width: number, height: number, replacing?: Layer) {
    checkDimensions(width, height);
    const pixels =
      this.pixelBudget +
      width * height -
      (replacing ? replacing.canvas.width * replacing.canvas.height : 0);
    if (
      (!replacing && this.layers.length >= MAX_LAYERS) ||
      pixels > MAX_LAYER_PIXELS
    )
      throw new Error(
        "图层上限为 40 个，总像素上限为 4800 万。请删除或合并一些图层。",
      );
    checkMemory(
      estimateMemory(
        this.pixelBudget + width * height,
        this.width * this.height,
        (this.snapshot?.length ?? 0) * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
  }
  allocateLayer(width: number, height: number, replacing?: Layer) {
    this.checkLayerAllocation(width, height, replacing);
    return makeCanvas(width, height);
  }

  constructor() {
    this.newDocument("未命名", 1600, 1000, "transparent");
  }
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  };
  getRevision = () => this.revision;
  notify() {
    this.revision++;
    this.listeners.forEach((callback) => callback());
  }
  get selected() {
    return (
      this.layers.find((layer) => layer.id === this.selectedId) ??
      this.layers[this.layers.length - 1]
    );
  }
  get dirty() {
    return (
      this.pending || this.history[this.historyIndex]?.json !== this.savedJSON
    );
  }
  get canUndo() {
    return this.historyIndex > 0 && !this.busy;
  }
  get canRedo() {
    return this.historyIndex < this.history.length - 1 && !this.busy;
  }
  get pixelBudget() {
    return this.layers.reduce((total, layer) => {
      let sum = total + layer.canvas.width * layer.canvas.height;
      if (layer.mask)
        sum += layer.mask.canvas.width * layer.mask.canvas.height;
      return sum;
    }, 0);
  }
  assertBudget(canvas: HTMLCanvasElement, replacing?: Layer) {
    if (
      (!replacing && this.layers.length >= MAX_LAYERS) ||
      this.pixelBudget +
        canvas.width * canvas.height -
        (replacing ? replacing.canvas.width * replacing.canvas.height : 0) >
        MAX_LAYER_PIXELS
    )
      throw new Error(
        "图层上限为 40 个，总像素上限为 4800 万。请删除或合并一些图层。",
      );
  }
  change() {
    this.pending = true;
    this.notify();
  }
  private serializeLayer(layer: Layer): LayerData {
    const { canvas, mask, ...rest } = layer;
    const data: LayerData = {
      ...rest,
      image: canvas.toDataURL("image/png"),
    };
    if (mask) {
      data.mask = {
        image: mask.canvas.toDataURL("image/png"),
        inverted: mask.inverted,
        feather: mask.feather,
        disabled: mask.disabled,
      };
    }
    return data;
  }
  serialize(): string {
    checkMemory(
      estimateMemory(
        this.pixelBudget,
        this.width * this.height,
        (this.snapshot?.length ?? 0) * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
    const data: ProjectData = {
      format: "bgssai-compositor",
      version: 1,
      name: this.name,
      width: this.width,
      height: this.height,
      layers: this.layers.map((layer) => this.serializeLayer(layer)),
    };
    const json = JSON.stringify(data);
    if (new TextEncoder().encode(json).byteLength > MAX_PROJECT_BYTES)
      throw new Error("项目超过 128 MB，请减少图层后保存。");
    return json;
  }
  commit(label: string) {
    const json = this.serialize();
    this.pending = false;
    if (this.history[this.historyIndex]?.json === json) {
      this.notify();
      return;
    }
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({ json, label, selectedId: this.selectedId });
    let bytes = this.history.reduce(
      (total, entry) => total + entry.json.length * 2,
      0,
    );
    while (
      this.history.length > 1 &&
      (this.history.length > 30 ||
        bytes > Math.min(HISTORY_BYTES, this.memoryBudget / 8))
    ) {
      bytes -= this.history.shift()!.json.length * 2;
    }
    this.historyIndex = this.history.length - 1;
    this.notify();
  }
  markSaved(json: string) {
    this.savedJSON = json;
    this.notify();
  }
  private resetHistory(label: string, saved: boolean) {
    this.history = [];
    this.historyIndex = -1;
    this.pending = false;
    this.commit(label);
    this.savedJSON = saved ? this.history[0].json : "";
    this.notify();
  }
  newDocument(name: string, width: number, height: number, background: string) {
    checkDimensions(width, height);
    checkMemory(
      estimateMemory(
        this.pixelBudget + width * height,
        this.width * this.height + width * height,
        0,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
    const canvas = makeCanvas(width, height);
    if (background !== "transparent") {
      const context = ctx(canvas);
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
    }
    this.name = name.trim().slice(0, 200) || "未命名";
    this.width = width;
    this.height = height;
    this.layers = [
      layerFromCanvas(canvas, background === "transparent" ? "图层 1" : "背景"),
    ];
    this.selectedId = this.layers[0].id;
    this.selection = null;
    this.aiBaselineRevision = null;
    this.resetHistory("新建文档", true);
  }
  private async decodeLayer(layer: LayerData): Promise<Layer> {
    const { image, mask, ...rest } = layer;
    const canvas = await decode(image);
    const result: Layer = { ...rest, canvas };
    if (mask) {
      result.mask = {
        canvas: await decode(mask.image),
        inverted: mask.inverted,
        feather: mask.feather,
        disabled: mask.disabled,
      };
    }
    return result;
  }
  async load(json: string, saved = true) {
    const data = parseProject(json);
    this.checkAdoption(data, json);
    const decoded: Layer[] = [];
    for (const layer of data.layers) decoded.push(await this.decodeLayer(layer));
    this.name = data.name;
    this.width = data.width;
    this.height = data.height;
    this.layers = decoded;
    this.selectedId = decoded[decoded.length - 1].id;
    this.selection = null;
    this.aiBaselineRevision = null;
    this.resetHistory("打开项目", saved);
  }
  async undo() {
    if (this.canUndo) await this.restore(this.historyIndex - 1);
  }
  async redo() {
    if (this.canRedo) await this.restore(this.historyIndex + 1);
  }
  async restore(index: number) {
    this.busy = true;
    this.notify();
    try {
      const data = parseProject(this.history[index].json);
      this.checkAdoption(data, this.history[index].json);
      const layers: Layer[] = [];
      for (const layer of data.layers) layers.push(await this.decodeLayer(layer));
      this.name = data.name;
      this.width = data.width;
      this.height = data.height;
      this.layers = layers;
      this.selectedId = this.history[index].selectedId;
      this.historyIndex = index;
      this.selection = null;
      this.pending = false;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async openImage(data: string, name: string) {
    const canvas = await decode(data, (width, height) =>
      checkMemory(
        estimateMemory(
          this.pixelBudget + width * height,
          this.width * this.height + width * height,
          data.length * 2,
          this.historyBytes,
        ),
        this.memoryBudget,
      ),
    );
    this.name = name.replace(/\.[^.]+$/, "").slice(0, 200);
    this.width = canvas.width;
    this.height = canvas.height;
    this.layers = [layerFromCanvas(canvas, name.slice(0, 200))];
    this.selectedId = this.layers[0].id;
    this.selection = null;
    this.aiBaselineRevision = null;
    this.resetHistory("打开图像", false);
  }
  async importImage(data: string, name: string) {
    const canvas = await decode(data, (width, height) =>
      this.checkLayerAllocation(width, height),
    );
    this.assertBudget(canvas);
    const layer = layerFromCanvas(canvas, name.slice(0, 200));
    const scale = Math.min(
      1,
      this.width / canvas.width,
      this.height / canvas.height,
    );
    layer.scaleX = scale;
    layer.scaleY = scale;
    layer.x = (this.width - canvas.width * scale) / 2;
    layer.y = (this.height - canvas.height * scale) / 2;
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.commit("导入图像");
  }
  async importProjectLayers(json: string) {
    const data = parseProject(json);
    const decoded: Layer[] = [];
    for (const layer of data.layers) decoded.push(await this.decodeLayer(layer));
    const added = decoded.reduce((sum, layer) => {
      let pixels = layer.canvas.width * layer.canvas.height;
      if (layer.mask) pixels += layer.mask.canvas.width * layer.mask.canvas.height;
      return sum + pixels;
    }, 0);
    if (
      this.layers.length + decoded.length > MAX_LAYERS ||
      this.pixelBudget + added > MAX_LAYER_PIXELS
    )
      throw new Error(
        "图层上限为 40 个，总像素上限为 4800 万。请删除或合并一些图层。",
      );
    checkMemory(
      estimateMemory(
        this.pixelBudget + added,
        this.width * this.height,
        json.length * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
    this.layers.push(...decoded);
    this.selectedId = decoded[decoded.length - 1].id;
    this.commit("导入 PSD 图层");
  }
  addBlank() {
    const canvas = this.allocateLayer(this.width, this.height);
    this.assertBudget(canvas);
    const layer = layerFromCanvas(canvas, `图层 ${this.layers.length + 1}`);
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.commit("新建图层");
  }
  select(id: string) {
    this.selectedId = id;
    this.notify();
  }
  patch(
    patch: Partial<Omit<Layer, "canvas" | "id" | "mask">>,
    label: string,
    live = false,
  ) {
    if (
      this.selected.locked &&
      !Object.keys(patch).every((key) => ["locked", "visible"].includes(key))
    )
      throw new Error("请先解锁图层。");
    if (patch.adjustments && !("filter" in ctx(this.selected.canvas))) {
      const padding = Math.ceil(patch.adjustments.blur) * 6;
      checkMemory(
        estimateMemory(
          this.pixelBudget +
            (this.selected.canvas.width + padding) *
              (this.selected.canvas.height + padding) *
              4,
          this.width * this.height,
          (this.snapshot?.length ?? 0) * 2,
          this.historyBytes,
        ),
        this.memoryBudget,
      );
    }
    Object.assign(this.selected, patch);
    this.change();
    if (!live) this.commit(label);
  }
  adjust(patch: Partial<Adjustments>, live = false) {
    this.patch(
      { adjustments: { ...this.selected.adjustments, ...patch } },
      "调整颜色",
      live,
    );
  }
  duplicate() {
    const original = this.selected;
    const canvas = this.allocateLayer(
      original.canvas.width,
      original.canvas.height,
    );
    this.assertBudget(canvas);
    ctx(canvas).drawImage(original.canvas, 0, 0);
    const clone: Layer = {
      ...original,
      id: crypto.randomUUID(),
      name: `${original.name.slice(0, 180)} 副本`,
      canvas,
      adjustments: { ...original.adjustments },
      text: original.text ? { ...original.text } : undefined,
      shape: original.shape
        ? { ...original.shape, points: original.shape.points.map((p) => ({ ...p })) }
        : undefined,
      adjustment: original.adjustment ? { ...original.adjustment, curve: [...original.adjustment.curve] } : undefined,
      locked: false,
    };
    if (original.mask) {
      const maskCanvas = makeCanvas(
        original.mask.canvas.width,
        original.mask.canvas.height,
      );
      ctx(maskCanvas).drawImage(original.mask.canvas, 0, 0);
      clone.mask = { ...original.mask, canvas: maskCanvas };
    }
    this.layers.splice(this.layers.indexOf(original) + 1, 0, clone);
    this.selectedId = clone.id;
    this.commit("复制图层");
  }
  remove() {
    if (this.selected.locked) throw new Error("请先解锁图层。");
    if (this.layers.length === 1) throw new Error("至少需要保留一个图层。");
    const index = this.layers.indexOf(this.selected);
    this.layers.splice(index, 1);
    this.selectedId = this.layers[Math.min(index, this.layers.length - 1)].id;
    this.commit("删除图层");
  }
  reorder(direction: number) {
    if (this.selected.locked) throw new Error("请先解锁图层。");
    const index = this.layers.indexOf(this.selected);
    const target = index + direction;
    if (target < 0 || target >= this.layers.length) return;
    const [layer] = this.layers.splice(index, 1);
    this.layers.splice(target, 0, layer);
    this.commit("调整图层顺序");
  }
  moveTo(id: string, targetId: string) {
    const source = this.layers.findIndex((layer) => layer.id === id);
    const target = this.layers.findIndex((layer) => layer.id === targetId);
    if (
      source < 0 ||
      target < 0 ||
      source === target ||
      this.layers[source].locked
    )
      return;
    const [layer] = this.layers.splice(source, 1);
    this.layers.splice(target, 0, layer);
    this.selectedId = id;
    this.commit("调整图层顺序");
  }

  private preparedMask(layer: Layer): HTMLCanvasElement | null {
    if (!layer.mask || layer.mask.disabled) return null;
    const source = layer.mask.canvas;
    const out = makeCanvas(layer.canvas.width, layer.canvas.height);
    const context = ctx(out);
    context.drawImage(
      source,
      0,
      0,
      source.width,
      source.height,
      0,
      0,
      out.width,
      out.height,
    );
    if (layer.mask.inverted) {
      context.globalCompositeOperation = "difference";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, out.width, out.height);
      context.globalCompositeOperation = "source-over";
    }
    if (layer.mask.feather > 0) {
      const pixels = context.getImageData(0, 0, out.width, out.height);
      featherMaskPixels(pixels.data, out.width, out.height, layer.mask.feather);
      context.putImageData(pixels, 0, 0);
    }
    return out;
  }

  drawLayer(
    context: CanvasRenderingContext2D,
    layer: Layer,
    _layerIndex = this.layers.indexOf(layer),
  ) {
    if (!layer.visible) return;
    context.save();
    context.globalAlpha = layer.opacity;
    context.globalCompositeOperation = layer.blend as GlobalCompositeOperation;

    if (layer.kind === "adjustment" && layer.adjustment) {
      const snapshot = context.getImageData(0, 0, this.width, this.height);
      applyAdjustmentPixels(snapshot.data, layer.adjustment);
      const temp = makeCanvas(this.width, this.height);
      ctx(temp).putImageData(snapshot, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = layer.opacity;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(temp, 0, 0);
      context.restore();
      return;
    }

    const adj = layer.adjustments;
    let source = layer.canvas,
      padding = 0;
    if ("filter" in context)
      context.filter = `brightness(${100 + adj.brightness}%) contrast(${100 + adj.contrast}%) saturate(${100 + adj.saturation}%) blur(${adj.blur}px)`;
    else if (adj.brightness || adj.contrast || adj.saturation || adj.blur) {
      padding = Math.ceil(adj.blur) * 3;
      const width = layer.canvas.width + padding * 2,
        height = layer.canvas.height + padding * 2;
      checkMemory(
        estimateMemory(
          this.pixelBudget + width * height * 4,
          this.width * this.height,
          (this.snapshot?.length ?? 0) * 2,
          this.historyBytes,
        ),
        this.memoryBudget,
      );
      source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const filtered = ctx(source);
      filtered.drawImage(layer.canvas, padding, padding);
      const pixels = filtered.getImageData(0, 0, width, height);
      adjustPixels(pixels.data, adj);
      blurPixels(pixels.data, width, height, adj.blur);
      filtered.putImageData(pixels, 0, 0);
    }

    const mask = this.preparedMask(layer);
    let drawSource = source;
    if (mask) {
      const masked = document.createElement("canvas");
      masked.width = source.width;
      masked.height = source.height;
      const mc = ctx(masked);
      mc.drawImage(source, 0, 0);
      mc.globalCompositeOperation = "destination-in";
      mc.drawImage(
        mask,
        padding,
        padding,
        layer.canvas.width,
        layer.canvas.height,
      );
      drawSource = masked;
    }

    context.translate(
      layer.x + (layer.canvas.width * layer.scaleX) / 2,
      layer.y + (layer.canvas.height * layer.scaleY) / 2,
    );
    context.rotate((layer.rotation * Math.PI) / 180);
    context.scale(
      layer.scaleX * (layer.flipX ? -1 : 1),
      layer.scaleY * (layer.flipY ? -1 : 1),
    );
    context.drawImage(
      drawSource,
      -layer.canvas.width / 2 - padding,
      -layer.canvas.height / 2 - padding,
    );
    context.restore();
  }

  render(canvas: HTMLCanvasElement) {
    if (canvas.width !== this.width) canvas.width = this.width;
    if (canvas.height !== this.height) canvas.height = this.height;
    const context = ctx(canvas);
    context.clearRect(0, 0, this.width, this.height);
    const needsClip = this.layers.some((l) => l.clipToBelow);
    if (!needsClip) {
      this.layers.forEach((layer, i) => this.drawLayer(context, layer, i));
      return;
    }
    const accum = makeCanvas(this.width, this.height);
    const ac = ctx(accum);
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (!layer.visible) continue;
      if (layer.clipToBelow && i > 0) {
        const piece = makeCanvas(this.width, this.height);
        const pc = ctx(piece);
        // Draw base stack alpha of the layer below as clip mask.
        const belowOnly = makeCanvas(this.width, this.height);
        this.drawLayer(ctx(belowOnly), this.layers[i - 1], i - 1);
        this.drawLayer(pc, layer, i);
        pc.globalCompositeOperation = "destination-in";
        pc.drawImage(belowOnly, 0, 0);
        ac.drawImage(piece, 0, 0);
      } else {
        this.drawLayer(ac, layer, i);
      }
    }
    context.drawImage(accum, 0, 0);
  }
  exportImage(format: "png" | "jpeg", quality: number, background: string) {
    checkMemory(
      estimateMemory(
        this.pixelBudget + this.width * this.height,
        this.width * this.height,
        (this.snapshot?.length ?? 0) * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
    const canvas = makeCanvas(this.width, this.height);
    const context = ctx(canvas);
    if (format === "jpeg") {
      context.fillStyle = background;
      context.fillRect(0, 0, this.width, this.height);
    }
    // Composite onto the prepared canvas (preserve JPEG background).
    const stack = makeCanvas(this.width, this.height);
    this.render(stack);
    context.drawImage(stack, 0, 0);
    return canvas.toDataURL(`image/${format}`, quality);
  }
  hit(point: Point): Layer | undefined {
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible || layer.locked) continue;
      if (layer.kind === "adjustment") continue;
      const p = worldToLocal(point, geometry(layer));
      if (
        p.x >= 0 &&
        p.y >= 0 &&
        p.x < layer.canvas.width &&
        p.y < layer.canvas.height &&
        ctx(layer.canvas).getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1)
          .data[3] > 10
      )
        return layer;
    }
  }

  private ensureSelectionMask(): HTMLCanvasElement {
    if (this.selection?.mask) return this.selection.mask;
    const mask = emptyMask(this.width, this.height);
    if (this.selection) {
      const c = ctx(mask);
      c.fillStyle = "#fff";
      fillSelectionShape(c, this.selection);
      c.fill();
      this.selection.mask = mask;
    }
    return mask;
  }

  private clipPaintToSelection(
    context: CanvasRenderingContext2D,
    layer: Layer,
  ) {
    if (!this.selection) return;
    const g = geometry(layer);
    const s = this.selection;
    if (s.points && s.points.length > 2) {
      context.beginPath();
      s.points
        .map((p) => worldToLocal(p, g))
        .forEach((p, i) =>
          i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
        );
      context.closePath();
      context.clip();
      return;
    }
    context.beginPath();
    if (s.kind === "ellipse") {
      const c = worldToLocal(
        { x: s.x + s.width / 2, y: s.y + s.height / 2 },
        g,
      );
      const edge = worldToLocal(
        { x: s.x + s.width, y: s.y + s.height / 2 },
        g,
      );
      const rx = Math.hypot(edge.x - c.x, edge.y - c.y);
      const edgeY = worldToLocal(
        { x: s.x + s.width / 2, y: s.y + s.height },
        g,
      );
      const ry = Math.hypot(edgeY.x - c.x, edgeY.y - c.y);
      context.ellipse(
        c.x,
        c.y,
        Math.max(0.5, rx),
        Math.max(0.5, ry),
        0,
        0,
        Math.PI * 2,
      );
    } else {
      [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height },
      ]
        .map((p) => worldToLocal(p, g))
        .forEach((p, i) =>
          i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
        );
      context.closePath();
    }
    context.clip();
  }

  private paintTarget(): { layer: Layer; context: CanvasRenderingContext2D } {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (!layer.visible) throw new Error("请先显示图层。");
    if (this.maskPaintMode) {
      if (!layer.mask) this.addMask();
      return { layer, context: ctx(layer.mask!.canvas) };
    }
    if (layer.text || layer.shape)
      throw new Error("文本/形状图层需先栅格化，或新建图层再绘画。");
    if (layer.kind === "adjustment")
      throw new Error("调整图层不能直接绘制，请选择像素图层。");
    return { layer, context: ctx(layer.canvas) };
  }

  paint(from: Point, to: Point, erase: boolean, pressure = 1) {
    const { layer, context } = this.paintTarget();
    const g = this.maskPaintMode
      ? {
          ...geometry(layer),
          width: layer.mask!.canvas.width,
          height: layer.mask!.canvas.height,
          scaleX: (layer.canvas.width * layer.scaleX) / layer.mask!.canvas.width,
          scaleY:
            (layer.canvas.height * layer.scaleY) / layer.mask!.canvas.height,
        }
      : geometry(layer);
    const a = worldToLocal(from, g);
    const b = worldToLocal(to, g);
    context.save();
    if (!this.maskPaintMode) this.clipPaintToSelection(context, layer);
    context.globalCompositeOperation = erase
      ? "destination-out"
      : "source-over";
    context.globalAlpha = this.brushOpacity;
    const radius =
      (this.brushSize * pressure) / Math.sqrt(Math.max(0.01, g.scaleX * g.scaleY)) / 2;
    const hardness = Math.max(0, Math.min(1, this.brushHardness));
    const color = this.maskPaintMode ? "#ffffff" : this.color;
    const toRgba = (hex: string, alpha: number) => {
      const h = hex.replace("#", "");
      const n =
        h.length === 3
          ? h
              .split("")
              .map((c) => c + c)
              .join("")
          : h;
      const r = parseInt(n.slice(0, 2), 16);
      const g = parseInt(n.slice(2, 4), 16);
      const b = parseInt(n.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    };
    context.strokeStyle = context.fillStyle = color;
    context.lineWidth = radius * 2;
    context.lineCap = context.lineJoin = "round";
    if (hardness < 0.99) {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.35)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const g2 = context.createRadialGradient(
          x,
          y,
          radius * hardness,
          x,
          y,
          Math.max(0.1, radius),
        );
        g2.addColorStop(0, toRgba(color, 1));
        g2.addColorStop(1, toRgba(color, 0));
        context.fillStyle = g2;
        context.beginPath();
        context.arc(x, y, Math.max(0.1, radius), 0, Math.PI * 2);
        context.fill();
      }
    } else if (a.x === b.x && a.y === b.y) {
      context.beginPath();
      context.arc(b.x, b.y, Math.max(0.1, radius), 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    context.restore();
    this.change();
  }

  /** Merge a new selection region according to selectionMode. */
  applySelection(next: Selection) {
    if (next.width < 0) {
      next.x += next.width;
      next.width = -next.width;
    }
    if (next.height < 0) {
      next.y += next.height;
      next.height = -next.height;
    }
    // Clip to document.
    const x2 = Math.min(this.width, next.x + next.width);
    const y2 = Math.min(this.height, next.y + next.height);
    next.x = Math.max(0, next.x);
    next.y = Math.max(0, next.y);
    next.width = Math.max(0, x2 - next.x);
    next.height = Math.max(0, y2 - next.y);

    if (this.selectionMode === "replace" || !this.selection) {
      const mask = emptyMask(this.width, this.height);
      const c = ctx(mask);
      c.fillStyle = "#fff";
      fillSelectionShape(c, next);
      c.fill();
      next.mask = mask;
      this.selection = next;
      this.notify();
      return;
    }
    const mask = this.ensureSelectionMask();
    const c = ctx(mask);
    c.fillStyle = "#fff";
    c.globalCompositeOperation =
      this.selectionMode === "add" ? "source-over" : "destination-out";
    fillSelectionShape(c, next);
    c.fill();
    c.globalCompositeOperation = "source-over";
    const bounds = selectionBounds(mask);
    if (!bounds) {
      this.selection = null;
    } else {
      this.selection = {
        kind: next.kind,
        ...bounds,
        mask,
        points: next.points,
      };
    }
    this.notify();
  }

  expandSelection(pixels: number) {
    if (!this.selection) throw new Error("没有可操作的选区。");
    const mask = this.ensureSelectionMask();
    const c = ctx(mask);
    const data = c.getImageData(0, 0, mask.width, mask.height);
    const amount = Math.round(pixels);
    if (amount === 0) return;
    // Morphological dilate/erode on R channel.
    const src = new Uint8ClampedArray(data.data);
    const w = mask.width,
      h = mask.height;
    const radius = Math.abs(amount);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let best = amount > 0 ? 0 : 255;
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const sx = x + dx,
              sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
            const v = src[(sy * w + sx) * 4];
            if (amount > 0) best = Math.max(best, v);
            else best = Math.min(best, v);
          }
        data.data[(y * w + x) * 4] = best;
        data.data[(y * w + x) * 4 + 1] = best;
        data.data[(y * w + x) * 4 + 2] = best;
      }
    c.putImageData(data, 0, 0);
    const bounds = selectionBounds(mask);
    if (!bounds) this.selection = null;
    else this.selection = { ...this.selection, ...bounds, mask };
    this.notify();
  }

  contractSelection(pixels: number) {
    this.expandSelection(-Math.abs(pixels));
  }

  featherSelection(radius: number) {
    if (!this.selection) throw new Error("没有可操作的选区。");
    const mask = this.ensureSelectionMask();
    const c = ctx(mask);
    const data = c.getImageData(0, 0, mask.width, mask.height);
    featherMaskPixels(data.data, mask.width, mask.height, radius);
    c.putImageData(data, 0, 0);
    this.notify();
  }

  /** Local patch-match style content-aware fill inside the selection. */
  contentAwareFill() {
    if (!this.selection) throw new Error("没有可操作的选区。");
    const layer = this.selected;
    if (layer.locked || layer.text || layer.shape || layer.kind === "adjustment")
      throw new Error("请先解锁或栅格化图层。");
    const g = geometry(layer);
    const context = ctx(layer.canvas);
    const image = context.getImageData(
      0,
      0,
      layer.canvas.width,
      layer.canvas.height,
    );
    const mask = this.ensureSelectionMask();
    const maskData = ctx(mask).getImageData(0, 0, mask.width, mask.height).data;
    const patch = 5;
    const w = layer.canvas.width,
      h = layer.canvas.height;
    const src = new Uint8ClampedArray(image.data);
    const isSelected = (lx: number, ly: number) => {
      const world = localToWorld({ x: lx, y: ly }, g);
      const ix = Math.floor(world.x),
        iy = Math.floor(world.y);
      if (ix < 0 || iy < 0 || ix >= mask.width || iy >= mask.height)
        return false;
      return maskData[(iy * mask.width + ix) * 4] > 32;
    };
    const candidates: Point[] = [];
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        if (!isSelected(x, y) && src[(y * w + x) * 4 + 3] > 10)
          candidates.push({ x, y });
      }
    if (!candidates.length) throw new Error("选区周围没有可用于填充的内容。");
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!isSelected(x, y)) continue;
        let best = candidates[0],
          bestDist = Infinity;
        for (let i = 0; i < Math.min(40, candidates.length); i++) {
          const c = candidates[Math.floor(Math.random() * candidates.length)];
          const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
          if (d < bestDist && d > patch * patch) {
            bestDist = d;
            best = c;
          }
        }
        const si = (best.y * w + best.x) * 4;
        const di = (y * w + x) * 4;
        image.data[di] = src[si];
        image.data[di + 1] = src[si + 1];
        image.data[di + 2] = src[si + 2];
        image.data[di + 3] = src[si + 3];
      }
    blurPixels(image.data, w, h, 1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (isSelected(x, y)) continue;
        const i = (y * w + x) * 4;
        image.data[i] = src[i];
        image.data[i + 1] = src[i + 1];
        image.data[i + 2] = src[i + 2];
        image.data[i + 3] = src[i + 3];
      }
    context.putImageData(image, 0, 0);
    this.commit("内容识别填充");
  }

  wandSelect(point: Point, tolerance = 32) {
    const layer = this.selected;
    const g = geometry(layer);
    const local = worldToLocal(point, g);
    const x = Math.floor(local.x),
      y = Math.floor(local.y);
    if (
      x < 0 ||
      y < 0 ||
      x >= layer.canvas.width ||
      y >= layer.canvas.height
    )
      throw new Error("点击位置不在当前图层内。");
    const data = ctx(layer.canvas).getImageData(
      0,
      0,
      layer.canvas.width,
      layer.canvas.height,
    ).data;
    const w = layer.canvas.width,
      h = layer.canvas.height;
    const seed = (y * w + x) * 4;
    const sr = data[seed],
      sg = data[seed + 1],
      sb = data[seed + 2],
      sa = data[seed + 3];
    const visited = new Uint8Array(w * h);
    const stack = [x, y];
    const mask = emptyMask(this.width, this.height);
    const mc = ctx(mask);
    const match = (i: number) =>
      Math.abs(data[i] - sr) <= tolerance &&
      Math.abs(data[i + 1] - sg) <= tolerance &&
      Math.abs(data[i + 2] - sb) <= tolerance &&
      Math.abs(data[i + 3] - sa) <= tolerance;
    while (stack.length) {
      const cy = stack.pop()!,
        cx = stack.pop()!;
      const idx = cy * w + cx;
      if (visited[idx]) continue;
      visited[idx] = 1;
      if (!match(idx * 4)) continue;
      const world = localToWorld({ x: cx + 0.5, y: cy + 0.5 }, g);
      mc.fillStyle = "#fff";
      mc.fillRect(Math.floor(world.x), Math.floor(world.y), 1, 1);
      if (cx > 0) stack.push(cx - 1, cy);
      if (cx + 1 < w) stack.push(cx + 1, cy);
      if (cy > 0) stack.push(cx, cy - 1);
      if (cy + 1 < h) stack.push(cx, cy + 1);
    }
    const bounds = selectionBounds(mask);
    if (!bounds) {
      this.selection = null;
      this.notify();
      return;
    }
    this.applySelection({ kind: "wand", ...bounds, mask });
  }

  shape(selection: Selection, ellipse: boolean) {
    if (selection.width < 1 || selection.height < 1) return;
    const width = Math.max(1, Math.ceil(selection.width));
    const height = Math.max(1, Math.ceil(selection.height));
    const canvas = this.allocateLayer(width, height);
    this.assertBudget(canvas);
    const shape: ShapeContent = {
      kind: ellipse ? "ellipse" : "rectangle",
      fill: this.color,
      stroke: this.color,
      strokeWidth: 0,
      points: [],
    };
    this.rasterizeShape(canvas, shape);
    const layer = layerFromCanvas(canvas, ellipse ? "椭圆" : "矩形");
    layer.shape = shape;
    layer.kind = "shape";
    layer.x = selection.x;
    layer.y = selection.y;
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.commit(ellipse ? "绘制椭圆" : "绘制矩形");
  }

  private rasterizeShape(canvas: HTMLCanvasElement, shape: ShapeContent) {
    const context = ctx(canvas);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = shape.fill;
    context.strokeStyle = shape.stroke;
    context.lineWidth = shape.strokeWidth;
    if (shape.kind === "ellipse") {
      context.beginPath();
      context.ellipse(
        canvas.width / 2,
        canvas.height / 2,
        canvas.width / 2,
        canvas.height / 2,
        0,
        0,
        2 * Math.PI,
      );
      context.fill();
      if (shape.strokeWidth > 0) context.stroke();
    } else if (shape.kind === "rectangle") {
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (shape.strokeWidth > 0)
        context.strokeRect(
          shape.strokeWidth / 2,
          shape.strokeWidth / 2,
          canvas.width - shape.strokeWidth,
          canvas.height - shape.strokeWidth,
        );
    } else if (shape.points.length > 1) {
      context.beginPath();
      shape.points.forEach((p, i) =>
        i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
      );
      if (shape.kind === "polygon") {
        context.closePath();
        context.fill();
      }
      if (shape.strokeWidth > 0) context.stroke();
    }
  }

  updateShape(patch: Partial<ShapeContent>) {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (!layer.shape) return;
    const shape = {
      ...layer.shape,
      ...patch,
      points: patch.points ?? layer.shape.points,
    };
    this.rasterizeShape(layer.canvas, shape);
    layer.shape = shape;
    this.commit("编辑形状");
  }

  private textCanvas(text: TextContent, replacing?: Layer): HTMLCanvasElement {
    const measure = ctx(makeCanvas(1, 1));
    const fontName = text.font;
    measure.font = `${text.bold ? "700" : "400"} ${text.size}px "${fontName}"`;
    const lines = text.value.split("\n");
    const padding = Math.ceil(text.size * 0.25);
    const width = Math.max(
      1,
      Math.ceil(
        Math.max(...lines.map((line) => measure.measureText(line).width)) +
          padding * 2,
      ),
    );
    const height = Math.max(
      1,
      Math.ceil(lines.length * text.size * 1.3 + padding * 2),
    );
    const canvas = this.allocateLayer(width, height, replacing);
    const context = ctx(canvas);
    context.font = measure.font;
    context.textBaseline = "top";
    context.fillStyle = text.color;
    const align: TextAlign = text.align ?? "left";
    context.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
    lines.forEach((line, i) => {
      const x =
        align === "center"
          ? width / 2
          : align === "right"
            ? width - padding
            : padding;
      context.fillText(line, x, padding + i * text.size * 1.3);
    });
    return canvas;
  }

  /** Detect whether a font family appears available via canvas metrics. */
  fontAvailable(font: string): boolean {
    const probe = 'mmmmmmmmmwwwwwwwlli';
    const canvas = makeCanvas(1, 1);
    const context = ctx(canvas);
    context.font = `72px monospace`;
    const base = context.measureText(probe).width;
    context.font = `72px "${font}", monospace`;
    const mixed = context.measureText(probe).width;
    context.font = `72px "${font}"`;
    const only = context.measureText(probe).width;
    return mixed !== base || only !== base;
  }

  addText(point: Point, value = "输入文字") {
    const font = "Segoe UI" as TextContent["font"];
    const missing = this.fontAvailable(font) ? undefined : font;
    const text: TextContent = {
      value,
      font,
      size: 72,
      color: this.color,
      bold: false,
      align: "left",
      ...(missing ? { missingFont: missing } : {}),
    };
    const canvas = this.textCanvas(text);
    this.assertBudget(canvas);
    const layer = layerFromCanvas(canvas, value.slice(0, 24));
    layer.text = text;
    layer.kind = "text";
    layer.x = point.x;
    layer.y = point.y;
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.tool = "move";
    this.commit("添加文字");
  }
  updateText(patch: Partial<TextContent>) {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (!layer.text) return;
    const text = { ...layer.text, ...patch };
    if (text.value.length > 10000) throw new Error("文字最多为 10000 字符。");
    if (patch.font !== undefined) {
      if (!this.fontAvailable(patch.font)) text.missingFont = patch.font;
      else delete text.missingFont;
    }
    const canvas = this.textCanvas(text, layer);
    this.assertBudget(canvas, layer);
    layer.canvas = canvas;
    layer.text = text;
    layer.name = text.value.slice(0, 24) || "文字";
    this.commit("编辑文字");
  }
  rasterize() {
    if (this.selected.locked) throw new Error("请先解锁图层。");
    this.selected.text = undefined;
    this.selected.shape = undefined;
    this.selected.kind = "raster";
    this.commit("栅格化");
  }
  clearSelection() {
    const layer = this.selected;
    if (layer.locked || layer.text || layer.shape)
      throw new Error("请先解锁或栅格化图层。");
    const context = ctx(layer.canvas);
    if (!this.selection)
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    else {
      context.save();
      this.clipPaintToSelection(context, layer);
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      context.restore();
    }
    this.commit("清除像素");
  }

  crop(aspect?: number | null) {
    const s = this.selection;
    if (!s || s.width < 1 || s.height < 1)
      throw new Error("先拖出矩形选区，再裁切画布。");
    let { x, y, width, height } = s;
    const ratio = aspect ?? this.cropAspect;
    if (ratio && ratio > 0) {
      const current = width / height;
      if (current > ratio) {
        const next = height * ratio;
        x += (width - next) / 2;
        width = next;
      } else {
        const next = width / ratio;
        y += (height - next) / 2;
        height = next;
      }
    }
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.layers.forEach((layer) => {
      layer.x -= x;
      layer.y -= y;
    });
    this.selection = null;
    this.commit("裁切画布");
  }

  /** Free transform via scale/rotation already on layer; perspective warps corners. */
  perspectiveTransform(cornersDoc: [Point, Point, Point, Point]) {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (layer.kind === "adjustment")
      throw new Error("调整图层不支持透视变形。");
    const src = layer.canvas;
    const out = this.allocateLayer(src.width, src.height, layer);
    this.assertBudget(out, layer);
    const sc = ctx(src).getImageData(0, 0, src.width, src.height);
    const dc = ctx(out).createImageData(out.width, out.height);
    // Bilinear inverse mapping from unit square to destination quad.
    const [tl, tr, br, bl] = cornersDoc;
    // Map layer local (u,v) in 0..1 to document, then sample.
    // Here we treat cornersDoc as local-space destinations for the four corners.
    for (let y = 0; y < out.height; y++)
      for (let x = 0; x < out.width; x++) {
        const u = x / (out.width - 1 || 1);
        const v = y / (out.height - 1 || 1);
        const topX = tl.x + (tr.x - tl.x) * u;
        const topY = tl.y + (tr.y - tl.y) * u;
        const botX = bl.x + (br.x - bl.x) * u;
        const botY = bl.y + (br.y - bl.y) * u;
        const sx = topX + (botX - topX) * v;
        const sy = topY + (botY - topY) * v;
        const ix = Math.floor(sx),
          iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= src.width || iy >= src.height) continue;
        const si = (iy * src.width + ix) * 4;
        const di = (y * out.width + x) * 4;
        dc.data[di] = sc.data[si];
        dc.data[di + 1] = sc.data[si + 1];
        dc.data[di + 2] = sc.data[si + 2];
        dc.data[di + 3] = sc.data[si + 3];
      }
    ctx(out).putImageData(dc, 0, 0);
    layer.canvas = out;
    layer.text = undefined;
    layer.shape = undefined;
    layer.kind = "raster";
    this.commit("透视变形");
  }

  imageSize(width: number, height: number) {
    checkDimensions(width, height);
    const sx = width / this.width;
    const sy = height / this.height;
    this.layers.forEach((layer) => {
      layer.x *= sx;
      layer.y *= sy;
      layer.scaleX *= sx;
      layer.scaleY *= sy;
    });
    this.width = width;
    this.height = height;
    this.selection = null;
    this.commit("图像大小");
  }

  canvasSize(
    width: number,
    height: number,
    anchor:
      | "center"
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right" = "center",
  ) {
    checkDimensions(width, height);
    let dx = 0,
      dy = 0;
    if (anchor === "center") {
      dx = (width - this.width) / 2;
      dy = (height - this.height) / 2;
    } else if (anchor === "top-right") dx = width - this.width;
    else if (anchor === "bottom-left") dy = height - this.height;
    else if (anchor === "bottom-right") {
      dx = width - this.width;
      dy = height - this.height;
    }
    this.layers.forEach((layer) => {
      layer.x += dx;
      layer.y += dy;
    });
    this.width = width;
    this.height = height;
    this.selection = null;
    this.commit("画布大小");
  }

  trim(padding = 0) {
    const canvas = makeCanvas(this.width, this.height);
    this.render(canvas);
    const data = ctx(canvas).getImageData(0, 0, this.width, this.height).data;
    let minX = this.width,
      minY = this.height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        if (data[(y * this.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    if (maxX < 0) throw new Error("画布为空，无法修整。");
    minX = Math.max(0, minX - padding);
    minY = Math.max(0, minY - padding);
    maxX = Math.min(this.width - 1, maxX + padding);
    maxY = Math.min(this.height - 1, maxY + padding);
    this.width = maxX - minX + 1;
    this.height = maxY - minY + 1;
    this.layers.forEach((layer) => {
      layer.x -= minX;
      layer.y -= minY;
    });
    this.selection = null;
    this.commit("修整画布");
  }

  mergeDown() {
    const top = this.selected;
    const index = this.layers.indexOf(top);
    if (index < 1) throw new Error("底部图层无法向下合并。");
    const bottom = this.layers[index - 1];
    if (top.locked || bottom.locked) throw new Error("请先解锁两个图层。");
    if (!top.visible || !bottom.visible) throw new Error("请先显示两个图层。");
    if (bottom.blend !== "source-over" || top.blend !== "source-over")
      throw new Error("两个图层都须使用“正常”混合模式，才能向下合并。");
    if (
      this.pixelBudget -
        top.canvas.width * top.canvas.height -
        bottom.canvas.width * bottom.canvas.height +
        this.width * this.height >
      MAX_LAYER_PIXELS
    )
      throw new Error("合并会超过图层像素上限。");
    checkMemory(
      estimateMemory(
        this.pixelBudget + this.width * this.height,
        this.width * this.height,
        (this.snapshot?.length ?? 0) * 2,
        this.historyBytes,
      ),
      this.memoryBudget,
    );
    const canvas = makeCanvas(this.width, this.height);
    const context = ctx(canvas);
    this.drawLayer(context, bottom, index - 1);
    this.drawLayer(context, top, index);
    const merged = layerFromCanvas(canvas, bottom.name);
    this.layers.splice(index - 1, 2, merged);
    this.selectedId = merged.id;
    this.commit("向下合并");
  }

  // --- Masks ---
  addMask() {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (layer.mask) return;
    const canvas = makeCanvas(layer.canvas.width, layer.canvas.height);
    ctx(canvas).fillStyle = "#fff";
    ctx(canvas).fillRect(0, 0, canvas.width, canvas.height);
    layer.mask = {
      canvas,
      inverted: false,
      feather: 0,
      disabled: false,
    };
    this.commit("添加蒙版");
  }
  invertMask() {
    const layer = this.selected;
    if (!layer.mask) throw new Error("当前图层没有蒙版。");
    layer.mask.inverted = !layer.mask.inverted;
    this.commit("反相蒙版");
  }
  featherMask(radius: number) {
    const layer = this.selected;
    if (!layer.mask) throw new Error("当前图层没有蒙版。");
    layer.mask.feather = Math.max(0, Math.min(250, radius));
    this.commit("羽化蒙版");
  }
  setMaskDisabled(disabled: boolean) {
    const layer = this.selected;
    if (!layer.mask) throw new Error("当前图层没有蒙版。");
    layer.mask.disabled = disabled;
    this.commit(disabled ? "停用蒙版" : "启用蒙版");
  }
  removeMask() {
    const layer = this.selected;
    if (!layer.mask) return;
    layer.mask = undefined;
    this.commit("删除蒙版");
  }
  setClipToBelow(enabled: boolean) {
    this.patch({ clipToBelow: enabled }, enabled ? "创建剪贴蒙版" : "释放剪贴蒙版");
  }

  // --- Clone / heal / gradient ---
  cloneStamp(from: Point, to: Point) {
    if (!this.cloneSource) throw new Error("先 Alt/Option 点击设置仿制源。");
    const { layer, context } = this.paintTarget();
    if (this.maskPaintMode) throw new Error("仿制图章不能用于蒙版绘制。");
    const g = geometry(layer);
    const a = worldToLocal(from, g);
    const b = worldToLocal(to, g);
    const src = worldToLocal(this.cloneSource, g);
    const offsetX = src.x - a.x;
    const offsetY = src.y - a.y;
    const radius =
      this.brushSize / Math.sqrt(layer.scaleX * layer.scaleY) / 2;
    context.save();
    this.clipPaintToSelection(context, layer);
    context.globalAlpha = this.brushOpacity;
    context.beginPath();
    context.arc(b.x, b.y, Math.max(0.5, radius), 0, Math.PI * 2);
    context.clip();
    context.drawImage(
      layer.canvas,
      b.x + offsetX - radius,
      b.y + offsetY - radius,
      radius * 2,
      radius * 2,
      b.x - radius,
      b.y - radius,
      radius * 2,
      radius * 2,
    );
    context.restore();
    this.cloneSource = {
      x: this.cloneSource.x + (to.x - from.x),
      y: this.cloneSource.y + (to.y - from.y),
    };
    this.change();
  }

  spotHeal(point: Point) {
    const layer = this.selected;
    if (layer.locked || layer.text || layer.shape)
      throw new Error("请先解锁或栅格化图层。");
    const g = geometry(layer);
    const local = worldToLocal(point, g);
    const radius = Math.max(
      2,
      this.brushSize / Math.sqrt(layer.scaleX * layer.scaleY) / 2,
    );
    const context = ctx(layer.canvas);
    const x0 = Math.max(0, Math.floor(local.x - radius));
    const y0 = Math.max(0, Math.floor(local.y - radius));
    const size = Math.ceil(radius * 2);
    const sampleX = Math.min(
      layer.canvas.width - size,
      Math.max(0, x0 + Math.round(radius * 2.5)),
    );
    const sampleY = Math.min(
      layer.canvas.height - size,
      Math.max(0, y0),
    );
    context.save();
    context.beginPath();
    context.arc(local.x, local.y, radius, 0, Math.PI * 2);
    context.clip();
    context.globalAlpha = this.brushOpacity;
    context.drawImage(
      layer.canvas,
      sampleX,
      sampleY,
      size,
      size,
      x0,
      y0,
      size,
      size,
    );
    context.restore();
    // Soften.
    const pad = Math.ceil(radius) + 2;
    const sx = Math.max(0, Math.floor(local.x - pad));
    const sy = Math.max(0, Math.floor(local.y - pad));
    const sw = Math.min(layer.canvas.width - sx, pad * 2);
    const sh = Math.min(layer.canvas.height - sy, pad * 2);
    if (sw > 0 && sh > 0) {
      const img = context.getImageData(sx, sy, sw, sh);
      blurPixels(img.data, sw, sh, 1.5);
      context.putImageData(img, sx, sy);
    }
    this.commit("污点修复");
  }

  gradientFill(from: Point, to: Point, radial = false) {
    const layer = this.selected;
    if (layer.locked || layer.text || layer.shape)
      throw new Error("请先解锁或栅格化图层。");
    const g = geometry(layer);
    const a = worldToLocal(from, g);
    const b = worldToLocal(to, g);
    const context = ctx(layer.canvas);
    context.save();
    this.clipPaintToSelection(context, layer);
    context.globalAlpha = this.brushOpacity;
    const grad = radial
      ? context.createRadialGradient(
          a.x,
          a.y,
          0,
          a.x,
          a.y,
          Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        )
      : context.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, this.color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = grad;
    context.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    context.restore();
    this.commit("渐变");
  }

  // --- Adjustment layers & filters ---
  addAdjustmentLayer(type: AdjustmentType = "levels") {
    const canvas = this.allocateLayer(8, 8);
    this.assertBudget(canvas);
    ctx(canvas).fillStyle = "#808080";
    ctx(canvas).fillRect(0, 0, 8, 8);
    const layer = layerFromCanvas(canvas, `调整 · ${type}`);
    layer.kind = "adjustment";
    layer.adjustment = defaultAdjustment(type);
    layer.x = 0;
    layer.y = 0;
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.commit("新建调整图层");
  }

  patchAdjustment(patch: Partial<AdjustmentLayerParams>, live = false) {
    const layer = this.selected;
    if (layer.kind !== "adjustment" || !layer.adjustment)
      throw new Error("请选择调整图层。");
    layer.adjustment = { ...layer.adjustment, ...patch };
    if (patch.curve) layer.adjustment.curve = [...patch.curve];
    this.change();
    if (!live) this.commit("调整图层");
  }

  applyFilter(
    kind: "gaussian" | "motion" | "sharpen" | "noise",
    params: {
      radius?: number;
      angle?: number;
      amount?: number;
      monochrome?: boolean;
    } = {},
    live = false,
  ) {
    const layer = this.selected;
    if (layer.locked || layer.text || layer.shape || layer.kind === "adjustment")
      throw new Error("请先解锁或栅格化像素图层。");
    // Work on a copy so live preview can be cancelled by undo restore.
    const canvas = layer.canvas;
    const image = ctx(canvas).getImageData(0, 0, canvas.width, canvas.height);
    if (kind === "gaussian")
      blurPixels(image.data, canvas.width, canvas.height, params.radius ?? 4);
    else if (kind === "motion")
      motionBlurPixels(
        image.data,
        canvas.width,
        canvas.height,
        params.radius ?? 8,
        params.angle ?? 0,
      );
    else if (kind === "sharpen")
      sharpenPixels(
        image.data,
        canvas.width,
        canvas.height,
        params.amount ?? 50,
        params.radius ?? 1,
      );
    else
      noisePixels(image.data, params.amount ?? 20, params.monochrome ?? false);
    ctx(canvas).putImageData(image, 0, 0);
    this.change();
    if (!live) this.commit(`滤镜 · ${kind}`);
  }

  // --- AI helpers (REQ-004) ---
  captureSelectionOrLayerPng(): string {
    if (this.selection && this.selection.width >= 1 && this.selection.height >= 1) {
      const canvas = makeCanvas(
        Math.max(1, Math.round(this.selection.width)),
        Math.max(1, Math.round(this.selection.height)),
      );
      const full = makeCanvas(this.width, this.height);
      this.render(full);
      ctx(canvas).drawImage(
        full,
        this.selection.x,
        this.selection.y,
        this.selection.width,
        this.selection.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      this.aiBaselineRevision = this.revision;
      return canvas.toDataURL("image/png");
    }
    const layer = this.selected;
    this.aiBaselineRevision = this.revision;
    return layer.canvas.toDataURL("image/png");
  }

  assertAiRevision(expected?: number | null) {
    const baseline = expected ?? this.aiBaselineRevision;
    if (baseline == null) return;
    if (this.revision !== baseline)
      throw new Error("文档已变更，请重新生成 AI 预览后再应用。");
  }

  async applyAiPreviewImage(dataUrl: string, expectedRevision?: number) {
    this.assertAiRevision(expectedRevision);
    const canvas = await decode(dataUrl, (width, height) =>
      this.checkLayerAllocation(width, height),
    );
    this.assertBudget(canvas);
    const layer = layerFromCanvas(canvas, "AI 结果");
    if (this.selection && this.selection.width >= 1) {
      layer.x = this.selection.x;
      layer.y = this.selection.y;
      layer.scaleX = this.selection.width / canvas.width;
      layer.scaleY = this.selection.height / canvas.height;
    } else {
      layer.x = this.selected.x;
      layer.y = this.selected.y;
    }
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.aiBaselineRevision = null;
    this.commit("应用 AI 预览");
  }

  demo() {
    this.newDocument("静谧山野", 1200, 800, "#ebe7dd");
    const canvas = makeCanvas(1200, 800);
    const context = ctx(canvas);
    const gradient = context.createLinearGradient(0, 250, 0, 800);
    gradient.addColorStop(0, "#859c88");
    gradient.addColorStop(1, "#263d35");
    context.fillStyle = gradient;
    context.beginPath();
    context.moveTo(0, 470);
    context.bezierCurveTo(220, 420, 250, 640, 450, 430);
    context.bezierCurveTo(580, 320, 720, 300, 850, 400);
    context.bezierCurveTo(1000, 510, 1070, 420, 1200, 430);
    context.lineTo(1200, 800);
    context.lineTo(0, 800);
    context.closePath();
    context.fill();
    const hills = layerFromCanvas(canvas, "远山");
    this.layers.push(hills);
    this.color = "#c58056";
    this.shape({ kind: "rect", x: 916, y: 100, width: 154, height: 154 }, true);
    this.selected.name = "日光";
    this.color = "#293d35";
    this.addText({ x: 80, y: 95 }, "A QUIETER\nPERSPECTIVE");
    this.updateText({ font: "Georgia", size: 82 });
    this.color = "#ebe7dd";
    this.addText({ x: 80, y: 670 }, "慢下来，看见更多。");
    this.updateText({ size: 28 });
    this.color = "#efb87a";
    this.selectedId = hills.id;
    this.resetHistory("打开示例", false);
  }
}

export type { Blend, LayerKind, ShapeKind, SelectionKind, SelectionMode };
