import type { AdjustmentLayerParams, Adjustments } from "./project";

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

/** Motion blur along an angle (degrees). Distance is smear length in pixels. */
export function motionBlurPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  distance: number,
  angleDeg: number,
) {
  if (distance <= 0) return;
  const steps = Math.max(1, Math.round(distance));
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const source = new Uint8ClampedArray(pixels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        w = 0;
      for (let s = -steps; s <= steps; s++) {
        const sx = Math.round(x + dx * s);
        const sy = Math.round(y + dy * s);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const i = (sy * width + sx) * 4;
        const alpha = source[i + 3] / 255;
        r += source[i] * alpha;
        g += source[i + 1] * alpha;
        b += source[i + 2] * alpha;
        a += source[i + 3];
        w += alpha;
      }
      const o = (y * width + x) * 4;
      if (w > 0) {
        pixels[o] = r / w;
        pixels[o + 1] = g / w;
        pixels[o + 2] = b / w;
        pixels[o + 3] = a / (steps * 2 + 1);
      }
    }
}

/** Unsharp-mask style sharpen. Amount 0–200, radius approximates blur sigma. */
export function sharpenPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  radius = 1,
) {
  if (amount <= 0) return;
  const blur = new Uint8ClampedArray(pixels);
  blurPixels(blur, width, height, Math.max(0.5, radius));
  const strength = amount / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    for (let c = 0; c < 3; c++) {
      const value = pixels[i + c] + (pixels[i + c] - blur[i + c]) * strength;
      pixels[i + c] = Math.max(0, Math.min(255, value));
    }
  }
}

/** Additive noise. Amount 0–100; monochrome keeps RGB channels equal. */
export function noisePixels(
  pixels: Uint8ClampedArray,
  amount: number,
  monochrome = false,
) {
  if (amount <= 0) return;
  const range = (amount / 100) * 128;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    if (monochrome) {
      const n = (Math.random() * 2 - 1) * range;
      pixels[i] = Math.max(0, Math.min(255, pixels[i] + n));
      pixels[i + 1] = Math.max(0, Math.min(255, pixels[i + 1] + n));
      pixels[i + 2] = Math.max(0, Math.min(255, pixels[i + 2] + n));
    } else {
      for (let c = 0; c < 3; c++)
        pixels[i + c] = Math.max(
          0,
          Math.min(255, pixels[i + c] + (Math.random() * 2 - 1) * range),
        );
    }
  }
}

function lerpCurve(curve: number[], input: number): number {
  if (curve.length < 2) return input;
  const t = input / 255;
  const pos = t * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(pos));
  const f = pos - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/** Apply non-destructive adjustment-layer params to an RGBA buffer. */
export function applyAdjustmentPixels(
  pixels: Uint8ClampedArray,
  params: AdjustmentLayerParams,
) {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue;
    let r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    if (params.type === "levels" || params.type === "curves") {
      const mapChannel = (v: number) => {
        const black = params.levelsBlack;
        const white = Math.max(black + 1, params.levelsWhite);
        let t = (v - black) / (white - black);
        t = Math.max(0, Math.min(1, t));
        const gamma = params.levelsMid / 100;
        t = Math.pow(t, 1 / Math.max(0.1, gamma));
        return lerpCurve(params.curve, t * 255);
      };
      if (params.type === "levels") {
        const black = params.levelsBlack;
        const white = Math.max(black + 1, params.levelsWhite);
        const gamma = params.levelsMid / 100;
        const map = (v: number) => {
          let t = (v - black) / (white - black);
          t = Math.max(0, Math.min(1, t));
          return clamp(Math.pow(t, 1 / Math.max(0.1, gamma)) * 255);
        };
        r = map(r);
        g = map(g);
        b = map(b);
      } else {
        r = clamp(mapChannel(r));
        g = clamp(mapChannel(g));
        b = clamp(mapChannel(b));
      }
    } else if (params.type === "hueSat") {
      const hsl = rgbToHsl(r, g, b);
      hsl.h = (hsl.h + params.hue / 360 + 1) % 1;
      hsl.s = Math.max(0, Math.min(1, hsl.s * (1 + params.sat / 100)));
      hsl.l = Math.max(0, Math.min(1, hsl.l + params.lightness / 100));
      const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      r = rgb.r;
      g = rgb.g;
      b = rgb.b;
    } else if (params.type === "exposure") {
      const exp = Math.pow(2, params.exposure);
      const gamma = Math.max(0.1, params.gamma);
      const map = (v: number) =>
        clamp(Math.pow(Math.max(0, (v / 255) * exp), 1 / gamma) * 255);
      r = map(r);
      g = map(g);
      b = map(b);
    } else if (params.type === "bw") {
      const gray = r * 0.213 + g * 0.715 + b * 0.072;
      const t = params.bwAmount / 100;
      r = clamp(r * (1 - t) + gray * t);
      g = clamp(g * (1 - t) + gray * t);
      b = clamp(b * (1 - t) + gray * t);
    }
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}

/** Soften an alpha mask (single channel in R or A). Uses R as mask strength. */
export function featherMaskPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
) {
  if (radius <= 0) return;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i];
    pixels[i] = a;
    pixels[i + 1] = a;
    pixels[i + 2] = a;
    pixels[i + 3] = 255;
  }
  blurPixels(pixels, width, height, radius);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i];
    pixels[i] = a;
    pixels[i + 1] = a;
    pixels[i + 2] = a;
    pixels[i + 3] = 255;
  }
}
