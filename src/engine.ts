import {
  checkDimensions,
  defaults,
  localToWorld,
  worldToLocal,
  MAX_LAYER_PIXELS,
  MAX_LAYERS,
  MAX_PROJECT_BYTES,
  parseProject,
  pngDimensions,
  type Adjustments,
  type Blend,
  type Geometry,
  type LayerData,
  type Point,
  type ProjectData,
  type TextContent,
} from "./project";
import {
  checkMemory,
  estimateMemory,
  DEFAULT_MEMORY_BYTES,
  HISTORY_BYTES,
} from "./memory";
import { imageDimensions } from "./image-header";
import { adjustPixels, blurPixels } from "./filters";

export type Tool =
  | "move"
  | "brush"
  | "eraser"
  | "select"
  | "rectangle"
  | "ellipse"
  | "text"
  | "eyedropper"
  | "hand";
export type Layer = Omit<LayerData, "image"> & { canvas: HTMLCanvasElement };
export interface Selection {
  x: number;
  y: number;
  width: number;
  height: number;
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

export class Editor {
  name = "未命名";
  width = 1600;
  height = 1000;
  layers: Layer[] = [];
  selectedId = "";
  selection: Selection | null = null;
  tool: Tool = "move";
  color = "#efb87a";
  brushSize = 28;
  brushOpacity = 1;
  private listeners = new Set<() => void>();
  revision = 0;
  history: Snapshot[] = [];
  historyIndex = -1;
  private savedJSON = "";
  private pending = false;
  busy = false;
  memoryBudget = DEFAULT_MEMORY_BYTES;
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
      return sum + size.width * size.height;
    }, 0);
    const softwareFilters = !("filter" in ctx(this.layers[0].canvas));
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
    return this.layers.reduce(
      (total, layer) => total + layer.canvas.width * layer.canvas.height,
      0,
    );
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
      layers: this.layers.map(({ canvas, ...layer }) => ({
        ...layer,
        image: canvas.toDataURL("image/png"),
      })),
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
    this.resetHistory("新建文档", true);
  }
  async load(json: string, saved = true) {
    const data = parseProject(json);
    this.checkAdoption(data, json);
    const decoded: Layer[] = [];
    // Decode every layer before replacing the current document; failed opens are atomic.
    for (const { image, ...layer } of data.layers)
      decoded.push({ ...layer, canvas: await decode(image) });
    this.name = data.name;
    this.width = data.width;
    this.height = data.height;
    this.layers = decoded;
    this.selectedId = decoded[decoded.length - 1].id;
    this.selection = null;
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
      for (const { image, ...layer } of data.layers)
        layers.push({ ...layer, canvas: await decode(image) });
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
    patch: Partial<Omit<Layer, "canvas" | "id">>,
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
      locked: false,
    };
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
  drawLayer(context: CanvasRenderingContext2D, layer: Layer) {
    if (!layer.visible) return;
    context.save();
    context.globalAlpha = layer.opacity;
    context.globalCompositeOperation = layer.blend as GlobalCompositeOperation;
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
      source,
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
    this.layers.forEach((layer) => this.drawLayer(context, layer));
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
    this.layers.forEach((layer) => this.drawLayer(context, layer));
    return canvas.toDataURL(`image/${format}`, quality);
  }
  hit(point: Point): Layer | undefined {
    for (const layer of [...this.layers].reverse()) {
      if (!layer.visible || layer.locked) continue;
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
  paint(from: Point, to: Point, erase: boolean, pressure = 1) {
    const layer = this.selected;
    if (layer.locked) throw new Error("请先解锁图层。");
    if (layer.text)
      throw new Error("文本图层需先点击“栅格化”，或新建一个图层再绘画。");
    if (!layer.visible) throw new Error("请先显示图层。");
    const context = ctx(layer.canvas);
    const g = geometry(layer);
    const a = worldToLocal(from, g);
    const b = worldToLocal(to, g);
    context.save();
    // Clip the brush in document space, transformed back into layer coordinates.
    if (this.selection) {
      const s = this.selection;
      const points = [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height },
      ].map((p) => worldToLocal(p, g));
      context.beginPath();
      points.forEach((p, i) =>
        i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
      );
      context.closePath();
      context.clip();
    }
    context.globalCompositeOperation = erase
      ? "destination-out"
      : "source-over";
    context.globalAlpha = this.brushOpacity;
    context.fillStyle = context.strokeStyle = this.color;
    const radius =
      (this.brushSize * pressure) / Math.sqrt(layer.scaleX * layer.scaleY) / 2;
    if (a.x === b.x && a.y === b.y) {
      context.beginPath();
      context.arc(b.x, b.y, Math.max(0.1, radius), 0, Math.PI * 2);
      context.fill();
    } else {
      context.lineWidth = radius * 2;
      context.lineCap = context.lineJoin = "round";
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    context.restore();
    this.change();
  }
  shape(selection: Selection, ellipse: boolean) {
    if (selection.width < 1 || selection.height < 1) return;
    const canvas = this.allocateLayer(
      Math.max(1, Math.ceil(selection.width)),
      Math.max(1, Math.ceil(selection.height)),
    );
    this.assertBudget(canvas);
    const context = ctx(canvas);
    context.fillStyle = this.color;
    if (ellipse) {
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
    } else context.fillRect(0, 0, canvas.width, canvas.height);
    const layer = layerFromCanvas(canvas, ellipse ? "椭圆" : "矩形");
    layer.x = selection.x;
    layer.y = selection.y;
    this.layers.push(layer);
    this.selectedId = layer.id;
    this.commit(ellipse ? "绘制椭圆" : "绘制矩形");
  }
  private textCanvas(text: TextContent, replacing?: Layer): HTMLCanvasElement {
    const measure = ctx(makeCanvas(1, 1));
    measure.font = `${text.bold ? "700" : "400"} ${text.size}px "${text.font}"`;
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
    lines.forEach((line, i) =>
      context.fillText(line, padding, padding + i * text.size * 1.3),
    );
    return canvas;
  }
  addText(point: Point, value = "输入文字") {
    const text: TextContent = {
      value,
      font: "Segoe UI",
      size: 72,
      color: this.color,
      bold: false,
    };
    const canvas = this.textCanvas(text);
    this.assertBudget(canvas);
    const layer = layerFromCanvas(canvas, value.slice(0, 24));
    layer.text = text;
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
    this.commit("栅格化文字");
  }
  clearSelection() {
    const layer = this.selected;
    if (layer.locked || layer.text) throw new Error("请先解锁或栅格化图层。");
    const context = ctx(layer.canvas);
    if (!this.selection)
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    else {
      const s = this.selection;
      const points = [
        { x: s.x, y: s.y },
        { x: s.x + s.width, y: s.y },
        { x: s.x + s.width, y: s.y + s.height },
        { x: s.x, y: s.y + s.height },
      ].map((p) => worldToLocal(p, geometry(layer)));
      context.save();
      context.beginPath();
      points.forEach((p, i) =>
        i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y),
      );
      context.closePath();
      context.clip();
      context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      context.restore();
    }
    this.commit("清除像素");
  }
  crop() {
    const s = this.selection;
    if (!s || s.width < 1 || s.height < 1)
      throw new Error("先拖出矩形选区，再裁切画布。");
    this.width = Math.max(1, Math.round(s.width));
    this.height = Math.max(1, Math.round(s.height));
    this.layers.forEach((layer) => {
      layer.x -= s.x;
      layer.y -= s.y;
    });
    this.selection = null;
    this.commit("裁切画布");
  }
  mergeDown() {
    const top = this.selected;
    const index = this.layers.indexOf(top);
    if (index < 1) throw new Error("底部图层无法向下合并。");
    const bottom = this.layers[index - 1];
    if (top.locked || bottom.locked) throw new Error("请先解锁两个图层。");
    if (!top.visible || !bottom.visible) throw new Error("请先显示两个图层。");
    // Backdrop-dependent blending cannot be flattened into an independent layer faithfully.
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
    this.drawLayer(context, bottom);
    this.drawLayer(context, top);
    const merged = layerFromCanvas(canvas, bottom.name);
    this.layers.splice(index - 1, 2, merged);
    this.selectedId = merged.id;
    this.commit("向下合并");
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
    this.shape({ x: 916, y: 100, width: 154, height: 154 }, true);
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
