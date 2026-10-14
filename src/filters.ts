import type { Adjustments } from "./project";
export function adjustPixels(
  pixels: Uint8ClampedArray,
  adjustments: Adjustments,
) {
  const clamp = (value: number) => Math.max(0, Math.min(255, value));
  const brightness = 1 + adjustments.brightness / 100,
    contrast = 1 + adjustments.contrast / 100,
    saturation = 1 + adjustments.saturation / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = clamp((clamp(pixels[i] * brightness) - 127.5) * contrast + 127.5);
    const g = clamp(
      (clamp(pixels[i + 1] * brightness) - 127.5) * contrast + 127.5,
    );
    const b = clamp(
      (clamp(pixels[i + 2] * brightness) - 127.5) * contrast + 127.5,
    );
    const gray = r * 0.213 + g * 0.715 + b * 0.072;
    pixels[i] = gray + (r - gray) * saturation;
    pixels[i + 1] = gray + (g - gray) * saturation;
    pixels[i + 2] = gray + (b - gray) * saturation;
  }
}
// Three separable box passes approximate Gaussian blur. Premultiply before blur
// to avoid colored halos at transparent edges. Scratch storage is one RGBA array.
export function blurPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sigma: number,
) {
  if (sigma <= 0) return;
  const radius = Math.max(1, Math.round(sigma)),
    divisor = radius * 2 + 1;
  const temporary = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4)
    for (let c = 0; c < 3; c++) pixels[i + c] *= pixels[i + 3] / 255;
  const pass = (
    source: Uint8ClampedArray,
    target: Uint8ClampedArray,
    horizontal: boolean,
  ) => {
    const lines = horizontal ? height : width,
      length = horizontal ? width : height;
    const index = (line: number, position: number, channel: number) =>
      (horizontal ? line * width + position : position * width + line) * 4 +
      channel;
    for (let line = 0; line < lines; line++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let p = 0; p <= radius && p < length; p++)
          sum += source[index(line, p, c)];
        for (let p = 0; p < length; p++) {
          target[index(line, p, c)] = sum / divisor;
          const remove = p - radius,
            add = p + radius + 1;
          if (remove >= 0) sum -= source[index(line, remove, c)];
          if (add < length) sum += source[index(line, add, c)];
        }
      }
  };
  for (let iteration = 0; iteration < 3; iteration++) {
    pass(pixels, temporary, true);
    pass(temporary, pixels, false);
  }
  for (let i = 0; i < pixels.length; i += 4)
    if (pixels[i + 3])
      for (let c = 0; c < 3; c++) pixels[i + c] *= 255 / pixels[i + 3];
}
