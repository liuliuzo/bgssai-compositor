import { checkDimensions, pngDimensions } from "./project";
// Reject oversized encoded images before the browser allocates decoder surfaces.
export function imageDimensions(data: string) {
  if (data.startsWith("data:image/png;base64,")) return pngDimensions(data);
  const comma = data.indexOf(",");
  if (
    comma < 0 ||
    !/^data:image\/(jpeg|jpg|webp|bmp);base64$/i.test(data.slice(0, comma))
  )
    throw new Error("请选择 PNG、JPEG、WebP 或 BMP 图像。");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(data.slice(comma + 1, comma + 1 + 1024 * 1024)),
      (char) => char.charCodeAt(0),
    );
  } catch {
    throw new Error("图像编码无效");
  }
  const view = new DataView(bytes.buffer);
  let width = 0,
    height = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > bytes.length) break;
      const length = view.getUint16(i);
      if (length < 2 || i + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        height = view.getUint16(i + 3);
        width = view.getUint16(i + 5);
        break;
      }
      i += length;
    }
  } else if (
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    const type = String.fromCharCode(...bytes.slice(12, 16));
    if (type === "VP8X") {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    }
    if (type === "VP8 ") {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
    if (type === "VP8L" && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height =
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0xf) << 10);
    }
  } else if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) {
    width = view.getInt32(18, true);
    height = Math.abs(view.getInt32(22, true));
  }
  if (!width || !height)
    throw new Error("无法检查图像尺寸，请转换为 PNG 后导入。");
  checkDimensions(width, height);
  return { width, height };
}
