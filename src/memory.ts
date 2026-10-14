export const MIB = 1024 * 1024;
export const HISTORY_BYTES = 96 * MIB;
export const DEFAULT_MEMORY_BYTES = 768 * MIB;

// Conservative working-set estimate, including live canvases, composition/filter
// surfaces, old and new documents during atomic adoption, and UTF-16 snapshots.
export function estimateMemory(
  layerPixels: number,
  documentPixels: number,
  serializedBytes: number,
  historyBytes = 0,
) {
  return (
    layerPixels * 4 + documentPixels * 16 + serializedBytes * 6 + historyBytes
  );
}
export function checkMemory(bytes: number, budget = DEFAULT_MEMORY_BYTES) {
  if (bytes > budget)
    throw new Error(
      `预计内存 ${Math.ceil(bytes / MIB)} MB 超过预算 ${Math.floor(budget / MIB)} MB。请先缩小画布、减少图层或关闭当前大项目。`,
    );
}
