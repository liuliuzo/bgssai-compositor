// Dependency-free rasterization of the app's original vector mark.
import { deflateSync } from "node:zlib";
import { mkdir, writeFile, access } from "node:fs/promises";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
function lineDistance(x, y, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
const lines = [
  [
    [59, 105],
    [128, 69],
  ],
  [
    [128, 69],
    [197, 105],
  ],
  [
    [197, 105],
    [128, 141],
  ],
  [
    [128, 141],
    [59, 105],
  ],
  [
    [59, 135],
    [128, 171],
  ],
  [
    [128, 171],
    [197, 135],
  ],
  [
    [59, 165],
    [128, 201],
  ],
  [
    [128, 201],
    [197, 165],
  ],
];
function png(size, opaque = false) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const channels = [0, 0, 0, 0];
      const samples = 4;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const px = ((x + (sx + 0.5) / samples) / size) * 256;
          const py = ((y + (sy + 0.5) / samples) / size) * 256;
          const qx = Math.max(42 - px, px - 214, 0);
          const qy = Math.max(42 - py, py - 214, 0);
          const inside = Math.hypot(qx, qy) <= 30;
          if (!inside) continue;
          const marked = lines.some(
            ([a, b]) => lineDistance(px, py, a, b) <= 5.5,
          );
          const color = marked
            ? [239, 184, 122]
            : [30 + py / 28, 36 + py / 35, 33 + py / 40];
          for (let c = 0; c < 3; c++) channels[c] += color[c];
          channels[3] += 255;
        }
      const offset = y * (1 + size * 4) + 1 + x * 4;
      for (let c = 0; c < 4; c++)
        raw[offset + c] = Math.round(channels[c] / samples ** 2);
      if (opaque) {
        const coverage = raw[offset + 3] / 255;
        for (let c = 0; c < 3; c++)
          raw[offset + c] += Math.round([22, 28, 25][c] * (1 - coverage));
        raw[offset + 3] = 255;
      }
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(png);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, i) => {
  const start = 6 + i * 16;
  header[start] = sizes[i] % 256;
  header[start + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(image.length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += image.length;
});
await mkdir("build", { recursive: true });
await writeFile("build/icon.ico", Buffer.concat([header, ...images]));
// macOS requires at least 512px; keep the same mark and opaque background.
await writeFile("build/icon.png", png(1024, true));
if (process.argv.includes("--mobile")) {
  await access("clients/ios/App/App/Assets.xcassets/AppIcon.appiconset");
  const icon = png(1024, true);
  await writeFile(
    "clients/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
    icon,
  );
  for (const file of [
    "splash-2732x2732.png",
    "splash-2732x2732-1.png",
    "splash-2732x2732-2.png",
  ])
    await writeFile(
      `clients/ios/App/App/Assets.xcassets/Splash.imageset/${file}`,
      icon,
    );
  for (const [density, size] of [
    ["mdpi", 48],
    ["hdpi", 72],
    ["xhdpi", 96],
    ["xxhdpi", 144],
    ["xxxhdpi", 192],
  ]) {
    for (const file of [
      "ic_launcher.png",
      "ic_launcher_round.png",
      "ic_launcher_foreground.png",
    ])
      await writeFile(
        `clients/android/app/src/main/res/mipmap-${density}/${file}`,
        png(size, true),
      );
  }
}
