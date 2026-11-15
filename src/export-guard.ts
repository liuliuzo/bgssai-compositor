export interface SaveLayer {
  kind?: string;
  text?: { font?: string; missingFont?: string };
}

export function missingFonts(layers: SaveLayer[] | undefined): string[] {
  const missing = new Set<string>();
  for (const layer of layers ?? []) {
    if (layer.kind !== "text" && layer.text == null) continue;
    if (layer.text?.missingFont) missing.add(layer.text.missingFont);
  }
  return [...missing];
}

export function explainIoFailure(code: string | undefined, fallback?: string): string {
  if (code === "ENOSPC" || code === "EDQUOT") return "磁盘空间不足，保存失败。";
  if (code === "ENOMEM" || code === "ERR_OUT_OF_MEMORY") return "内存不足，导出失败。";
  if (fallback && /corrupt|损坏|parse|JSON/i.test(fallback)) return "工程数据损坏，保存失败。";
  return fallback || "保存失败。";
}

export function assertCanSave(layers: SaveLayer[] | undefined, ioCode?: string, ioMessage?: string) {
  if (ioCode || (ioMessage && /ENOSPC|磁盘|损坏|内存/.test(ioMessage))) {
    throw new Error(explainIoFailure(ioCode, ioMessage));
  }
  const missing = missingFonts(layers);
  if (missing.length > 0) {
    throw new Error(`缺少字体「${missing.join("、")}」，无法保存。`);
  }
}

export const SIGNED_PACKAGE_REASON = "缺少签名证书与真机验证";

export function platformSlots() {
  return ["windows", "macos", "linux", "ios", "android"].map((platform) => ({
    platform,
    status: "blocked" as const,
    reason: SIGNED_PACKAGE_REASON,
  }));
}
