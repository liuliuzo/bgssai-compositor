function u16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}
function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}
function i16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value, 0);
  return bytes;
}
function pascalName(name: string) {
  const raw = Buffer.from(name, "ascii");
  const body = Buffer.concat([Buffer.from([raw.length]), raw]);
  const pad = (4 - (body.length % 4)) % 4;
  return Buffer.concat([body, Buffer.alloc(pad)]);
}
function tagged(key: string, data: Buffer) {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.from([0])]) : data;
  return Buffer.concat([
    Buffer.from("8BIM", "ascii"),
    Buffer.from(key, "ascii"),
    u32(padded.length),
    padded,
  ]);
}
function utf16(value: string) {
  const body = Buffer.alloc(value.length * 2);
  for (let i = 0; i < value.length; i++) body.writeUInt16BE(value.charCodeAt(i), i * 2);
  return Buffer.concat([u32(value.length), body]);
}
function descriptorKey(id: string) {
  if (id.length === 4) return Buffer.concat([Buffer.alloc(4), Buffer.from(id, "ascii")]);
  return Buffer.concat([u32(id.length), Buffer.from(id, "ascii")]);
}
function tysh(value: string, engine: string) {
  const header = Buffer.alloc(56);
  header.writeUInt16BE(1, 0);
  header.writeDoubleBE(1, 2);
  header.writeDoubleBE(1, 26);
  header.writeUInt16BE(50, 50);
  header.writeUInt32BE(16, 52);
  const engineBytes = Buffer.from(engine, "ascii");
  const descriptor = Buffer.concat([
    utf16(""),
    descriptorKey("TxLr"),
    u32(2),
    descriptorKey("Txt "),
    Buffer.from("TEXT", "ascii"),
    utf16(value),
    descriptorKey("EngineData"),
    Buffer.from("tdta", "ascii"),
    u32(engineBytes.length),
    engineBytes,
  ]);
  return Buffer.concat([header, descriptor]);
}
function rleSolid(value: number, width: number, height: number) {
  const row = Buffer.from([(1 - width) & 0xff, value]);
  const counts = Buffer.alloc(height * 2);
  for (let y = 0; y < height; y++) counts.writeUInt16BE(row.length, y * 2);
  return Buffer.concat([counts, ...Array.from({ length: height }, () => Buffer.from(row))]);
}

interface FixtureChannel {
  id: number;
  compression: 0 | 1 | 2;
  pixels: Buffer;
  width: number;
  height: number;
}
export interface FixtureLayer {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  opacity?: number;
  blend?: string;
  channels?: FixtureChannel[];
  mask?: { pixels: Buffer; flags?: number };
  tags?: { key: string; data: Buffer }[];
  text?: { value: string; engine: string };
}

export function buildPsd(options: {
  width: number;
  height: number;
  depth?: number;
  colorMode?: number;
  version?: number;
  layers?: FixtureLayer[];
}) {
  const header = Buffer.alloc(26);
  header.write("8BPS", 0);
  header.writeUInt16BE(options.version ?? 1, 4);
  header.writeUInt16BE(3, 12);
  header.writeUInt32BE(options.height, 14);
  header.writeUInt32BE(options.width, 18);
  header.writeUInt16BE(options.depth ?? 8, 22);
  header.writeUInt16BE(options.colorMode ?? 3, 24);
  const records: Buffer[] = [];
  const channelData: Buffer[] = [];
  // Callers describe the editor stack bottom-to-top; PSD stores the reverse.
  for (const layer of [...(options.layers ?? [])].reverse()) {
    const infos: Buffer[] = [];
    const channels = [...(layer.channels ?? [])];
    if (layer.mask) {
      channels.push({
        id: -2,
        compression: 0,
        pixels: layer.mask.pixels,
        width: layer.right - layer.left,
        height: layer.bottom - layer.top,
      });
    }
    for (const channel of channels) {
      const body =
        channel.compression === 1
          ? rleSolid(channel.pixels[0], channel.width, channel.height)
          : channel.pixels;
      const payload = Buffer.concat([u16(channel.compression), body]);
      const info = Buffer.alloc(6);
      info.writeInt16BE(channel.id, 0);
      info.writeUInt32BE(payload.length, 2);
      infos.push(info);
      channelData.push(payload);
    }
    const extraParts = [u32(layer.mask ? 20 : 0)];
    if (layer.mask) {
      const mask = Buffer.alloc(20);
      mask.writeInt32BE(layer.top, 0);
      mask.writeInt32BE(layer.left, 4);
      mask.writeInt32BE(layer.bottom, 8);
      mask.writeInt32BE(layer.right, 12);
      mask[16] = 0;
      mask[17] = layer.mask.flags ?? 0;
      extraParts.push(mask);
    }
    extraParts.push(u32(0), pascalName(layer.name));
    if (layer.text) extraParts.push(tagged("TySh", tysh(layer.text.value, layer.text.engine)));
    for (const tag of layer.tags ?? []) extraParts.push(tagged(tag.key, tag.data));
    const extra = Buffer.concat(extraParts);
    const rect = Buffer.alloc(16);
    rect.writeInt32BE(layer.top, 0);
    rect.writeInt32BE(layer.left, 4);
    rect.writeInt32BE(layer.bottom, 8);
    rect.writeInt32BE(layer.right, 12);
    records.push(
      Buffer.concat([
        rect,
        u16(infos.length),
        ...infos,
        Buffer.from("8BIM", "ascii"),
        Buffer.from((layer.blend ?? "norm").padEnd(4, " ").slice(0, 4), "ascii"),
        Buffer.from([layer.opacity ?? 255, 0, 0, 0]),
        u32(extra.length),
        extra,
      ]),
    );
  }
  const body = Buffer.concat([i16((options.layers ?? []).length), ...records, ...channelData]);
  const padded = body.length % 2 === 1 ? Buffer.concat([body, Buffer.from([0])]) : body;
  const section = Buffer.concat([u32(padded.length), padded, u32(0)]);
  return Buffer.concat([header, u32(0), u32(0), u32(section.length), section, u16(0)]);
}

export function dataUrl(bytes: Buffer) {
  return `data:application/octet-stream;base64,${bytes.toString("base64")}`;
}
export const engine =
  `/FontSize 18 /Values [ 1.0 ${17 / 255} ${19 / 255} ${35 / 255} ] /Name (Arial)`;

export function pixelLayer(
  name: string,
  left: number,
  rgba: [number, number, number, number],
  compression: 0 | 1,
  width = 2,
  height = 2,
): FixtureLayer {
  const channels = rgba.map((value, index) => ({
    id: index === 3 ? -1 : index,
    compression,
    pixels: Buffer.alloc(width * height, value),
    width,
    height,
  }));
  return {
    name,
    top: 0,
    left,
    bottom: height,
    right: left + width,
    channels,
  };
}
