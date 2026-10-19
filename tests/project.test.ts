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
  MAX_RECOVERY_DIMENSION,
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
        maskImage: "data:image/png;base64,corrupted-mask",
        maskEnabled: true,
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

  const result = recoverProjectState(corruptedPayload);
  assert.equal(result.recovered, true);
  assert.equal(result.project.width, MAX_RECOVERY_DIMENSION);
  assert.equal(result.project.height, 1);
  assert.equal(result.project.layers.length, 2);
  assert.deepEqual(result.quarantinedLayerIds, ["broken-layer"]);

  const first = result.project.layers[0];
  assert.equal(first.id, "healthy-1");
  assert.equal(first.opacity, 1);
  assert.equal(first.blend, "source-over");
  assert.equal(first.scaleX, 1);
  assert.equal(first.scaleY, 0.01);
  assert.equal(first.adjustments.brightness, 100);
  assert.equal(first.adjustments.contrast, -100);
  assert.equal(first.maskImage, undefined);

  const second = result.project.layers[1];
  assert.equal(second.id, "healthy-1-recovered-2");
  assert.equal(second.opacity, 0);
});
test("snapshot envelope verifies checksum and detects tampering", () => {
  const serialized = JSON.stringify(project());
  const envelope = createSnapshotEnvelope(serialized, 5, 1700000000000);
  const verified = verifySnapshotEnvelope(envelope);
  assert.equal(verified.valid, true);
  assert.equal(verified.generation, 5);
  assert.equal(verified.content, serialized);

  const tampered = { ...envelope, content: serialized.replace("测试文档", "篡改文档") };
  const badResult = verifySnapshotEnvelope(tampered);
  assert.equal(badResult.valid, false);
  assert.equal(badResult.reason, "checksum-mismatch");
});
test("HistoryRingBuffer bounds capacity, preserves redo on no-op commit, and validates integrity", () => {
  const ring = new HistoryRingBuffer<string>("state-0", 3);
  assert.equal(ring.canUndo(), false);
  assert.equal(ring.commit("state-1"), true);
  assert.equal(ring.commit("state-2"), true);
  assert.equal(ring.undo(), "state-1");
  assert.equal(ring.canRedo(), true);
  // No-op commit with identical state must not wipe redo stack
  assert.equal(ring.commit("state-1"), false);
  assert.equal(ring.canRedo(), true);
  assert.equal(ring.redo(), "state-2");

  // Exceeding capacity evicts oldest undo entry while maintaining integrity
  ring.commit("state-3");
  ring.commit("state-4");
  ring.commit("state-5");
  assert.equal(ring.validateIntegrity(), true);
  assert.equal(ring.depth().undo, 3);
  assert.equal(ring.undo(), "state-4");
  assert.equal(ring.undo(), "state-3");
  assert.equal(ring.undo(), "state-2");
  assert.equal(ring.undo(), null);
});

