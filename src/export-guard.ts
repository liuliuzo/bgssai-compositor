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
  if (code === "ENOSPC" || code === "EDQUOT") return "磁盘空间不足，工程未写入，不能记为保存成功。";
  if (code === "ENOMEM" || code === "ERR_OUT_OF_MEMORY") return "内存不足，导出已停止，没有写成成功。";
  if (fallback && /corrupt|损坏|parse|JSON/i.test(fallback)) return "工程数据损坏，未保存为成功。";
  return fallback || "保存失败，工程没有写成成功。";
}

export function assertCanSave(layers: SaveLayer[] | undefined, ioCode?: string, ioMessage?: string) {
  if (ioCode || (ioMessage && /ENOSPC|磁盘|损坏|内存/.test(ioMessage))) {
    throw new Error(explainIoFailure(ioCode, ioMessage));
  }
  const missing = missingFonts(layers);
  if (missing.length > 0) {
    throw new Error(`缺少字体「${missing.join("、")}」，已停止保存。未把文字层悄悄栅格成成功结果。`);
  }
}

export const SIGNED_PACKAGE_REASON = "本环境没有签名证书和真机，不能把未签名壳或网页入口写成已交付。";

export function platformSlots() {
  return ["windows", "macos", "linux", "ios", "android"].map((platform) => ({
    platform,
    status: "blocked" as const,
    reason: SIGNED_PACKAGE_REASON,
  }));
}
