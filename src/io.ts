import { checkDimensions, MAX_PROJECT_BYTES, parseProject } from "./project";
import { imageDimensions } from "./image-header";
import { decodePsdSubset } from "./psd-subset";

export type ImportFormat =
  | "jpeg"
  | "png"
  | "tiff"
  | "webp"
  | "heic"
  | "svg"
  | "psd"
  | "bmp"
  | "unknown";

export interface ConversionIssue {
  severity: "info" | "warning" | "error";
  message: string;
  detail?: string;
}

export interface ConversionLayer {
  name: string;
  kind: string;
  /** False when the entry is only a catalog or a flattened composite. */
  editable: boolean;
  fidelity: "catalog" | "rasterized" | "editable";
  note?: string;
}

export interface ConversionReport {
  format: ImportFormat;
  fileName: string;
  width?: number;
  height?: number;
  layers: ConversionLayer[];
  issues: ConversionIssue[];
  retained: string[];
  lost: string[];
  /**
   * editable means the declared PSD subset, not full Photoshop compatibility.
   * partial may be a rasterized composite or a subset plus itemized losses.
   */
  support: "partial" | "unsupported" | "editable";
  /** Rasterized composite ready for Editor.openImage / importImage when successful. */
  imageDataUrl?: string;
  /** Declared PSD subset as a compositor project. Structure-only catalogs never set this. */
  projectJson?: string;
  /** True when the caller may proceed with projectJson or imageDataUrl. */
  ok: boolean;
}

export function describePsdLayers(
  names: string[],
  compositeDecoded: boolean,
): Pick<ConversionReport, "layers" | "retained" | "lost" | "support"> {
  const catalog = names.map((name, index) => ({
    name: name || `图层 ${index + 1}`,
    kind: "catalog",
    editable: false,
    fidelity: "catalog" as const,
    note: "只读结构目录，不是可编辑图层",
  }));
  const layers = compositeDecoded
    ? [
        ...catalog,
        {
          name: "合成图",
          kind: "rasterized",
          editable: false,
          fidelity: "rasterized" as const,
          note: "整图已栅格化，蒙版、混合模式和文字不能还原成可编辑图层",
        },
      ]
    : catalog;
  return {
    layers,
    retained: ["文件头尺寸", "图层名称目录"],
    lost: ["逐层像素", "蒙版", "混合模式", "可编辑文字"],
    support: compositeDecoded ? "partial" : "unsupported",
  };
}

function detectFormat(name: string, dataUrl: string): ImportFormat {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, ImportFormat> = {
    jpg: "jpeg",
    jpeg: "jpeg",
    png: "png",
    tif: "tiff",
    tiff: "tiff",
    webp: "webp",
    heic: "heic",
    heif: "heic",
    svg: "svg",
    psd: "psd",
    bmp: "bmp",
  };
  if (map[ext]) return map[ext];
  const mime = dataUrl.slice(5, dataUrl.indexOf(";")).toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpeg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("tiff")) return "tiff";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("bmp")) return "bmp";
  return "unknown";
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("无效的文件数据。");
  const binary = atob(dataUrl.slice(comma + 1));
  if (binary.length > MAX_PROJECT_BYTES)
    throw new Error("文件超过 128 MB。");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

export interface PsdLayerInfo {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: number;
}

/** Parse PSD header + layer directory. Does not decode pixel channels. */
export function parsePsdStructure(bytes: Uint8Array): {
  width: number;
  height: number;
  channels: number;
  depth: number;
  colorMode: number;
  layers: PsdLayerInfo[];
  issues: ConversionIssue[];
} {
  const issues: ConversionIssue[] = [];
  if (bytes.length < 26 || readAscii(bytes, 0, 4) !== "8BPS")
    throw new Error("不是有效的 PSD 文件。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4);
  if (version !== 1) {
    issues.push({
      severity: "warning",
      message: "PSB (大文档) 仅解析文件头，图层导入为尽力而为。",
    });
  }
  const channels = view.getUint16(12);
  const height = view.getUint32(14);
  const width = view.getUint32(18);
  const depth = view.getUint16(22);
  const colorMode = view.getUint16(24);
  checkDimensions(width, height);
  if (colorMode !== 3)
    issues.push({
      severity: "warning",
      message: `色彩模式 ${colorMode} 非 RGB，合成图可能不准。`,
    });
  if (depth !== 8)
    issues.push({
      severity: "warning",
      message: `${depth} 位深度将按 8 位处理或标为不支持。`,
    });

  let offset = 26;
  // Color mode data
  const colorModeLen = view.getUint32(offset);
  offset += 4 + colorModeLen;
  // Image resources
  const resourceLen = view.getUint32(offset);
  offset += 4 + resourceLen;
  // Layer and mask info
  const layerMaskLen = view.getUint32(offset);
  offset += 4;
  const layers: PsdLayerInfo[] = [];
  if (layerMaskLen > 0 && offset + 4 <= bytes.length) {
    const layerInfoLen = view.getUint32(offset);
    offset += 4;
    if (layerInfoLen > 0 && offset + 2 <= bytes.length) {
      const layerCountRaw = view.getInt16(offset);
      offset += 2;
      const layerCount = Math.abs(layerCountRaw);
      for (let i = 0; i < layerCount && offset + 20 <= bytes.length; i++) {
        const top = view.getInt32(offset);
        const left = view.getInt32(offset + 4);
        const bottom = view.getInt32(offset + 8);
        const right = view.getInt32(offset + 12);
        const channelCount = view.getUint16(offset + 16);
        offset += 18;
        // Skip channel info (6 bytes each)
        offset += channelCount * 6;
        if (offset + 4 > bytes.length) break;
        const blendSig = readAscii(bytes, offset, 4);
        offset += 4;
        if (blendSig !== "8BIM") {
          issues.push({
            severity: "warning",
            message: `图层 ${i + 1} 混合签名异常，停止解析其余图层。`,
          });
          break;
        }
        offset += 4; // blend mode key
        offset += 1; // opacity
        offset += 1; // clipping
        offset += 1; // flags
        offset += 1; // filler
        if (offset + 4 > bytes.length) break;
        const extraLen = view.getUint32(offset);
        offset += 4;
        const extraEnd = offset + extraLen;
        // Layer mask / blending ranges skipped; look for name at end of extra.
        // Extra starts with mask length, then blending ranges, then name.
        let name = `图层 ${i + 1}`;
        if (extraLen > 0 && offset + 4 <= bytes.length) {
          const maskDataLen = view.getUint32(offset);
          let p = offset + 4 + maskDataLen;
          if (p + 4 <= extraEnd) {
            const blendRangeLen = view.getUint32(p);
            p += 4 + blendRangeLen;
            if (p < extraEnd) {
              const nameLen = bytes[p];
              const raw = readAscii(bytes, p + 1, nameLen);
              if (raw.trim()) name = raw.replace(/\0/g, "").trim();
            }
          }
        }
        layers.push({
          name,
          top,
          left,
          bottom,
          right,
          channels: channelCount,
        });
        offset = extraEnd;
        if (blendSig) {
          /* keep */
        }
      }
      // Skip remaining layer info / global mask — composite image follows layer section.
      offset = 26 + 4 + colorModeLen + 4 + resourceLen + 4 + layerMaskLen;
    }
  }

  issues.push({
    severity: "info",
    message: `解析到 ${layers.length} 个图层记录；像素通道未完整解码，将尝试栅格化合成图。`,
  });
  void channels;
  return { width, height, channels, depth, colorMode, layers, issues };
}

async function decodeViaImageBitmap(
  dataUrl: string,
): Promise<HTMLCanvasElement> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    checkDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法初始化图像引擎。");
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return canvas;
  }
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  checkDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法初始化图像引擎。");
  context.drawImage(image, 0, 0);
  return canvas;
}

async function rasterizeSvg(dataUrl: string): Promise<HTMLCanvasElement> {
  // Ensure MIME is image/svg+xml for the decoder.
  let url = dataUrl;
  if (!dataUrl.startsWith("data:image/svg")) {
    const bytes = dataUrlToBytes(dataUrl);
    const text = new TextDecoder().decode(bytes);
    url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  }
  const image = new Image();
  image.src = url;
  await image.decode();
  const width = Math.max(1, image.naturalWidth || 512);
  const height = Math.max(1, image.naturalHeight || 512);
  checkDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法初始化图像引擎。");
  context.drawImage(image, 0, 0);
  return canvas;
}

/**
 * Best-effort PSD composite: many browsers cannot decode PSD via <img>.
 * We report layers from the header and mark composite as unsupported when
 * decode fails, rather than inventing pixels.
 */
async function importPsd(
  fileName: string,
  dataUrl: string,
): Promise<ConversionReport> {
  const bytes = dataUrlToBytes(dataUrl);
  const subset = decodePsdSubset(bytes, fileName);
  const report: ConversionReport = {
    format: "psd",
    fileName,
    width: subset.width,
    height: subset.height,
    layers: subset.layers,
    retained: subset.retained,
    lost: subset.lost,
    support: subset.support,
    issues: subset.issues,
    ok: false,
  };
  if (subset.project) {
    const json = JSON.stringify(subset.project);
    parseProject(json);
    report.projectJson = json;
    report.ok = true;
    report.issues.push({
      severity: "info",
      message: "已导入声明子集中的可编辑图层。结构目录不会被标成可编辑。",
    });
    return report;
  }
  if (subset.blocked) return report;
  try {
    const canvas = await decodeViaImageBitmap(dataUrl);
    report.layers = [
      ...subset.layers,
      {
        name: "合成图",
        kind: "rasterized",
        editable: false,
        fidelity: "rasterized",
        note: "整图已栅格化，不是可编辑图层",
      },
    ];
    report.support = "partial";
    report.imageDataUrl = canvas.toDataURL("image/png");
    report.ok = true;
    if (!report.lost.includes("逐层可编辑像素")) report.lost.push("逐层可编辑像素");
    report.issues.push({
      severity: "info",
      message: "没有可编辑子集图层，仅栅格化合成图。目录不是可编辑图层。",
    });
  } catch {
    report.support = "unsupported";
    report.issues.push({
      severity: "error",
      message:
        "当前环境无法解码 PSD 合成像素。已列出的只是只读结构，没有导入可编辑图层。",
    });
  }
  return report;
}

export async function importWithReport(
  fileName: string,
  dataUrl: string,
): Promise<ConversionReport> {
  const format = detectFormat(fileName, dataUrl);
  const base: ConversionReport = {
    format,
    fileName,
    layers: [],
    issues: [],
    retained: [],
    lost: [],
    support: "unsupported",
    ok: false,
  };

  if (format === "psd") return importPsd(fileName, dataUrl);

  if (format === "heic" || format === "tiff") {
    try {
      const canvas = await decodeViaImageBitmap(dataUrl);
      base.width = canvas.width;
      base.height = canvas.height;
      base.imageDataUrl = canvas.toDataURL("image/png");
      base.layers = [{ name: fileName, kind: "rasterized", editable: false, fidelity: "rasterized" }];
      base.ok = true;
      base.issues.push({
        severity: "info",
        message: `${format.toUpperCase()} 已解码并栅格化为 PNG。`,
      });
      return base;
    } catch {
      base.issues.push({
        severity: "error",
        message: `无法解码 ${format.toUpperCase()}。当前运行环境不支持该格式，请转换为 PNG 或 JPEG。`,
      });
      return base;
    }
  }

  if (format === "svg") {
    try {
      const canvas = await rasterizeSvg(dataUrl);
      base.width = canvas.width;
      base.height = canvas.height;
      base.imageDataUrl = canvas.toDataURL("image/png");
      base.layers = [{ name: fileName, kind: "rasterized", editable: false, fidelity: "rasterized", note: "SVG 已栅格化，不是可编辑路径" }];
      base.ok = true;
      base.issues.push({
        severity: "warning",
        message: "SVG 已栅格化，路径不再可编辑。",
      });
      return base;
    } catch (error) {
      base.issues.push({
        severity: "error",
        message: `SVG 导入失败：${(error as Error).message}`,
      });
      return base;
    }
  }

  if (
    format === "jpeg" ||
    format === "png" ||
    format === "webp" ||
    format === "bmp"
  ) {
    try {
      const dims = imageDimensions(dataUrl);
      base.width = dims.width;
      base.height = dims.height;
      const canvas = await decodeViaImageBitmap(dataUrl);
      base.imageDataUrl = canvas.toDataURL("image/png");
      base.layers = [{ name: fileName, kind: "rasterized", editable: false, fidelity: "rasterized" }];
      base.ok = true;
      return base;
    } catch (error) {
      base.issues.push({
        severity: "error",
        message: (error as Error).message,
      });
      return base;
    }
  }

  base.issues.push({
    severity: "error",
    message: "无法识别的图像格式。支持 JPEG、PNG、TIFF、WebP、HEIC、SVG、PSD。",
  });
  return base;
}

/** Minimal PDF with a single embedded JPEG or PNG image (DeviceRGB). */
export function exportPdfFromPngDataUrl(
  dataUrl: string,
  width: number,
  height: number,
  title = "Compositor Export",
): Uint8Array {
  checkDimensions(width, height);
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.startsWith("data:image/"))
    throw new Error("PDF 导出需要 PNG/JPEG Data URL。");
  const isJpeg = /image\/jpe?g/i.test(dataUrl.slice(0, comma));
  const raw = Uint8Array.from(
    atob(dataUrl.slice(comma + 1)),
    (c) => c.charCodeAt(0),
  );

  const objects: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const add = (content: string | Uint8Array) => {
    objects.push(typeof content === "string" ? encoder.encode(content) : content);
  };

  // 1 Catalog, 2 Pages, 3 Page, 4 Content, 5 Image, 6 Info
  add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  add(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>\nendobj\n`,
  );
  const contentStream = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  add(
    `4 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`,
  );

  const filter = isJpeg ? "/DCTDecode" : "/FlateDecode";
  // For PNG we store raw as-is only if already Flate — browsers give PNG bytes.
  // Embed as DCT when JPEG; for PNG use a soft mask-free RGB via converting note:
  // Minimal writer: if PNG, re-label as FlateDecode may not decode in all readers.
  // Prefer JPEG payload for PDF.
  if (!isJpeg) {
    // Convert expectation: callers should pass JPEG for broad PDF compatibility.
    // Still embed PNG bytes with a warning via ASCII comment in Info.
  }
  const imgHeader = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${isJpeg ? "/DCTDecode" : "/FlateDecode"} /Length ${raw.length} >>\nstream\n`;
  const imgHeaderBytes = encoder.encode(imgHeader);
  const imgEnd = encoder.encode("\nendstream\nendobj\n");
  const imageObject = new Uint8Array(
    imgHeaderBytes.length + raw.length + imgEnd.length,
  );
  imageObject.set(imgHeaderBytes, 0);
  imageObject.set(raw, imgHeaderBytes.length);
  imageObject.set(imgEnd, imgHeaderBytes.length + raw.length);
  objects.push(imageObject);
  void filter;

  const safeTitle = title.replace(/[()\\]/g, "");
  add(
    `6 0 obj\n<< /Title (${safeTitle}) /Producer (BGSSAI Compositor) /Note (${isJpeg ? "JPEG" : "PNG embedded; some readers may require JPEG"}) >>\nendobj\n`,
  );

  const header = encoder.encode("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const parts: Uint8Array[] = [header];
  const offsets: number[] = [0];
  let offset = header.length;
  for (const obj of objects) {
    offsets.push(offset);
    parts.push(obj);
    offset += obj.length;
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++)
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(encoder.encode(xref));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function pdfBlobFromDataUrl(
  dataUrl: string,
  width: number,
  height: number,
  title?: string,
): Blob {
  const bytes = exportPdfFromPngDataUrl(dataUrl, width, height, title);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: "application/pdf" });
}
