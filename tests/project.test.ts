import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDimensions,
  defaults,
  localToWorld,
  worldToLocal,
  parseProject,
  recoverProjectState,
  createSnapshotEnvelope,
  verifySnapshotEnvelope,
  HistoryRingBuffer,
  MAX_DIMENSION,
  computeSnapshotChecksum,
  type ProjectData,
  type Geometry,
} from "../src/project.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function project(): ProjectData {
  return {
    format: "bgssai-compositor",
    version: 1,
    name: "测试文档",
    width: 128,
    height: 96,
    layers: [
      {
        id: "one",
        name: "红色",
        visible: true,
        locked: false,
        opacity: 0.7,
        blend: "multiply",
        x: -4,
        y: 12,
        scaleX: 2,
        scaleY: 0.5,
        rotation: 30,
        flipX: true,
        flipY: false,
        adjustments: defaults(),
        image: png,
      },
    ],
  };
}
test("editable projects preserve layer metadata without accepting unknown properties", () => {
  const original = project();
  const parsed = parseProject(JSON.stringify({ ...original, admin: true }));
  assert.deepEqual(parsed, original);
  assert.equal("admin" in parsed, false);
});

test("project round trip retains selection and bounded undo/redo snapshots", () => {
  const first = project();
  const current = project();
  current.selection = { kind: "polygon", x: 2, y: 3, width: 10, height: 12,
    points: [{ x: 2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 15 }] };
  const future = { ...current, name: "重做后的名称" };
  const saved: ProjectData = { ...current, history: { index: 1, entries: [first, current, future].map((value) => ({
    json: JSON.stringify(value), label: "编辑", selectedId: "one",
  })) } };
  const parsed = parseProject(JSON.stringify(saved));
  assert.deepEqual(parsed.selection, current.selection);
  assert.equal(parsed.history?.index, 1);
  assert.equal(JSON.parse(parsed.history!.entries[2].json).name, "重做后的名称");
  assert.deepEqual(parseProject(JSON.stringify(parsed)), parsed);
});

test("system font replacements remain editable across project round trips", () => {
  for (const font of ["sans-serif", "serif", "monospace"] as const) {
    const data = project();
    data.layers[0].kind = "text";
    data.layers[0].text = { value: "跨端文字", font, size: 24, color: "#000000", bold: false };
    assert.deepEqual(parseProject(JSON.stringify(data)).layers[0].text, data.layers[0].text);
  }
});

test("invalid selection and history cannot be adopted as a project", () => {
  for (const selection of [
    { kind: "unknown", x: 0, y: 0, width: 1, height: 1 },
    { kind: "rect", x: 127, y: 0, width: 2, height: 1 },
    { kind: "rect", x: 0, y: 0, width: 0, height: 1 },
    { kind: "wand", x: 0, y: 0, width: 1, height: 1 },
    { kind: "rect", x: 0, y: 0, width: 1, height: 1, image: png },
  ]) assert.throws(() => parseProject(JSON.stringify({ ...project(), selection })), /选区/);
  const entry = { json: JSON.stringify(project()), label: "打开", selectedId: "one" };
  for (const history of [
    { index: 0, entries: [] },
    { index: 1, entries: [entry] },
    { index: 0.5, entries: [entry, entry] },
    { index: 0, entries: Array.from({ length: 31 }, () => entry) },
    { index: 0, entries: [{ ...entry, selectedId: "missing" }] },
    { index: 0, entries: [{ ...entry, json: JSON.stringify({ ...project(), name: "不一致" }) }] },
    { index: 0, entries: [{ ...entry, json: JSON.stringify({ ...project(), history: {} }) }] },
  ]) assert.throws(() => parseProject(JSON.stringify({ ...project(), history })), /历史/);
});
test("rejects bad versions, truncated images, duplicate IDs and malformed values", () => {
  assert.throws(() => parseProject("{"), /JSON/);
  assert.throws(
    () => parseProject(JSON.stringify({ ...project(), version: 99 })),
    /版本/,
  );
  const data = project();
  data.layers[0].image = "data:image/svg+xml;base64,PHN2Zz4=";
  assert.throws(() => parseProject(JSON.stringify(data)), /PNG/);
  const duplicate = project();
  duplicate.layers.push({ ...duplicate.layers[0] });
  assert.throws(() => parseProject(JSON.stringify(duplicate)), /重复/);
  for (const patch of [
    { opacity: 2 },
    { scaleX: 0 },
    { rotation: null },
    { blend: "copy" },
    { visible: "true" },
  ]) {
    const invalid = project();
    Object.assign(invalid.layers[0], patch);
    assert.throws(() => parseProject(JSON.stringify(invalid)));
  }
});
test("rejects oversized PNG dimensions before image decoding", () => {
  const data = project();
  const bytes = Buffer.from(png.split(",")[1], "base64");
  bytes.writeUInt32BE(100000, 16);
  data.layers[0].image = `data:image/png;base64,${bytes.toString("base64")}`;
  assert.throws(() => parseProject(JSON.stringify(data)), /宽高/);
});
test("dimension limits include fractional, non-finite and excessive pixel counts", () => {
  checkDimensions(4096, 4096);
  checkDimensions(8192, 1);
  for (const dimensions of [
    [0, 1],
    [1.5, 100],
    [8193, 1],
    [8192, 8192],
    [NaN, 1],
    [Infinity, 1],
  ])
    assert.throws(() => checkDimensions(...(dimensions as [number, number])));
});
test("brush coordinates correctly invert rotated, scaled and flipped layer transforms", () => {
  for (const flipX of [true, false])
    for (const flipY of [true, false]) {
      const geometry: Geometry = {
        x: -31,
        y: 18,
        width: 160,
        height: 90,
        scaleX: 2.2,
        scaleY: 0.4,
        rotation: 137,
        flipX,
        flipY,
      };
      for (const point of [
        { x: 0, y: 0 },
        { x: 78, y: 41 },
        { x: 160, y: 90 },
      ]) {
        const restored = worldToLocal(localToWorld(point, geometry), geometry);
        assert.ok(Math.abs(restored.x - point.x) < 1e-10);
        assert.ok(Math.abs(restored.y - point.y) < 1e-10);
      }
    }
});
test("worldToLocal safely guards against degenerate zero or non-finite scale", () => {
  const zeroScaleGeometry: Geometry = {
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    scaleX: 0,
    scaleY: Number.NaN,
    rotation: 45,
    flipX: false,
    flipY: false,
  };
  const pt = worldToLocal({ x: 50, y: 50 }, zeroScaleGeometry);
  assert.ok(Number.isFinite(pt.x));
  assert.ok(Number.isFinite(pt.y));
});
test("validates text layer contents and fonts", () => {
  const data = project();
  data.layers[0].text = {
    value: "你好\nCompositor",
    font: "Segoe UI",
    size: 48,
    color: "#abcdef",
    bold: true,
  };
  assert.deepEqual(
    parseProject(JSON.stringify(data)).layers[0].text,
    data.layers[0].text,
  );
  data.layers[0].text.color = "#zzzzzz";
  assert.throws(() => parseProject(JSON.stringify(data)), /样式/);
});
test("recoverProjectState clamps bounds, quarantines corrupted layers, and preserves valid layers", () => {
  const healthy = {
    format: "bgssai-compositor" as const,
    version: 1 as const,
    name: "完好文档",
    width: 128,
    height: 96,
    layers: [
      {
        id: "only",
        name: "完好",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "source-over" as const,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        adjustments: defaults(),
        image: png,
      },
    ],
  };
  const clean = recoverProjectState(JSON.stringify(healthy));
  assert.equal(clean.recovered, false);
  assert.equal(clean.clampedCanvas, false);
  assert.deepEqual(clean.quarantinedLayers, []);
  assert.equal(clean.project.layers.length, 1);

  const corruptedPayload = {
    format: "bgssai-compositor",
    version: 1,
    name: "恢复测试",
    width: 99999,
    height: -50,
    layers: [
      {
        id: "healthy-1",
        name: "正常图层",
        visible: true,
        locked: false,
        opacity: 3.5,
        blend: "unsupported-mode",
        x: 10,
        y: 20,
        scaleX: 0,
        scaleY: -5,
        rotation: 720,
        flipX: false,
        flipY: false,
        adjustments: { brightness: 500, contrast: -500 },
        image: png,
        mask: { image: "data:image/png;base64,corrupted-mask" },
      },
      {
        id: "healthy-1",
        name: "重名图层",
        visible: true,
        locked: false,
        opacity: -0.4,
        blend: "screen",
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
        adjustments: defaults(),
        image: png,
      },
      {
        id: "broken-layer",
        name: "损坏图层",
        image: "data:image/png;base64,not-a-valid-png",
      },
    ],
  };

  const result = recoverProjectState(JSON.stringify(corruptedPayload));
  assert.equal(result.recovered, true);
  assert.equal(result.clampedCanvas, true);
  assert.equal(result.project.width, MAX_DIMENSION);
  assert.equal(result.project.height, 1);
  assert.equal(result.project.layers.length, 2);
  assert.equal(
    result.quarantinedLayers.some(
      (item) => item.id === "broken-layer" && item.action === "quarantined",
    ),
    true,
  );
  assert.equal(
    result.quarantinedLayers.some(
      (item) => item.id === "healthy-1" && item.action === "mask_dropped",
    ),
    true,
  );

  const first = result.project.layers[0];
  assert.equal(first.id, "healthy-1");
  assert.equal(first.opacity, 1);
  assert.equal(first.blend, "source-over");
  assert.equal(first.scaleX, 0.01);
  assert.equal(first.scaleY, 0.01);
  assert.equal(first.rotation, 720);
  assert.equal(first.adjustments.brightness, 100);
  assert.equal(first.adjustments.contrast, -100);
  assert.equal(first.mask, undefined);

  const second = result.project.layers[1];
  assert.equal(second.id, "healthy-1-recovered-2");
  assert.equal(second.opacity, 0);
  assert.equal(second.blend, "screen");
  assert.throws(() => recoverProjectState("{"), /不是有效的 JSON/);
  assert.throws(
    () =>
      recoverProjectState(
        JSON.stringify({ ...corruptedPayload, layers: [corruptedPayload.layers[2]] }),
      ),
    /所有图层均已损坏/,
  );
});
test("snapshot envelope verifies checksum and detects tampering", () => {
  const serialized = JSON.stringify(project());
  const envelope = createSnapshotEnvelope(serialized, 5, 1700000000000);
  assert.equal(envelope.sequence, 5);
  assert.equal(envelope.checksum, computeSnapshotChecksum(serialized));
  const verified = verifySnapshotEnvelope(envelope);
  assert.equal(verified.valid, true);
  assert.equal(verified.salvaged, false);
  assert.equal(verified.envelope?.sequence, 5);
  assert.equal(verified.envelope?.content, serialized);
  assert.equal(verified.project?.name, "测试文档");

  const tampered = { ...envelope, content: serialized.replace("测试文档", "篡改文档") };
  const badResult = verifySnapshotEnvelope(tampered);
  assert.equal(badResult.valid, false);
  assert.equal(badResult.reason, "快照校验和不匹配");
  assert.equal(verifySnapshotEnvelope(null).reason, "快照外壳不是有效对象");
  assert.equal(
    verifySnapshotEnvelope({ ...envelope, content: "" }).reason,
    "快照缺少项目内容",
  );
  assert.equal(
    verifySnapshotEnvelope({ ...envelope, writtenAt: Number.NaN }).reason,
    "快照写入时间戳无效",
  );
  assert.throws(() => createSnapshotEnvelope("{", 1, 1), /不是有效的 JSON/);

  const damaged = JSON.stringify({
    format: "bgssai-compositor",
    version: 1,
    name: "待抢救",
    width: 99999,
    height: 10,
    layers: [
      {
        id: "keep",
        name: "保留",
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
        image: png,
      },
    ],
  });
  const salvageEnvelope = {
    schemaVersion: 1 as const,
    content: damaged,
    sequence: 2,
    writtenAt: 1700000000000,
  };
  assert.equal(verifySnapshotEnvelope(salvageEnvelope).valid, false);
  const salvaged = verifySnapshotEnvelope(salvageEnvelope, { allowSalvage: true });
  assert.equal(salvaged.valid, true);
  assert.equal(salvaged.salvaged, true);
  assert.equal(salvaged.project?.width, MAX_DIMENSION);
  assert.equal(salvaged.project?.layers[0].id, "keep");
});
test("HistoryRingBuffer bounds capacity, preserves redo on no-op commit, and validates integrity", () => {
  const ring = new HistoryRingBuffer(3);
  assert.equal(ring.canUndo, false);
  assert.equal(ring.canRedo, false);
  assert.equal(ring.push("state-0", "初始", "layer"), true);
  assert.equal(ring.canUndo, false);
  assert.equal(ring.push("state-1", "第一步", "layer"), true);
  assert.equal(ring.push("state-2", "第二步", "layer"), true);
  assert.equal(ring.stepUndo()?.json, "state-1");
  assert.equal(ring.canRedo, true);
  assert.equal(ring.push("state-1", "第一步", "layer"), false);
  assert.equal(ring.canRedo, true);
  assert.equal(ring.stepRedo()?.json, "state-2");

  assert.equal(ring.push("state-3", "第三步", "layer"), true);
  assert.equal(ring.push("state-4", "第四步", "layer"), true);
  assert.equal(ring.push("state-5", "第五步", "layer"), true);
  const integrity = ring.validateIntegrity();
  assert.equal(integrity.valid, true);
  assert.equal(integrity.entryCount, 3);
  assert.equal(integrity.issues.length, 0);
  assert.deepEqual(
    ring.entries.map((entry) => entry.json),
    ["state-3", "state-4", "state-5"],
  );
  assert.equal(ring.stepUndo()?.json, "state-4");
  assert.equal(ring.stepUndo()?.json, "state-3");
  assert.equal(ring.stepUndo(), null);

  const tight = new HistoryRingBuffer(10, 1024);
  assert.equal(tight.push("a".repeat(400), "大", "layer"), true);
  assert.equal(tight.push("b".repeat(400), "更大", "layer"), true);
  assert.equal(tight.entries.length, 1);
  assert.equal(tight.entries[0].json, "b".repeat(400));
  assert.equal(tight.canUndo, false);
  tight.index = 9;
  const broken = tight.validateIntegrity();
  assert.equal(broken.valid, false);
  assert.ok(broken.issues.length > 0);
});

