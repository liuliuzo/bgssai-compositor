import assert from "node:assert/strict";
import test from "node:test";
import { describePsdLayers, parsePsdStructure } from "../src/io.ts";
import { assertCanSave, explainIoFailure, platformSlots } from "../src/export-guard.ts";

test("psd catalog layers stay non-editable and raster loss is explicit", () => {
  const partial = describePsdLayers(["背景", "标题"], false);
  assert.equal(partial.support, "unsupported");
  assert.ok(partial.layers.every((layer) => layer.editable === false));
  assert.ok(partial.layers.every((layer) => layer.kind !== "raster"));
  assert.ok(partial.lost.includes("可编辑文字"));
  const decoded = describePsdLayers(["背景", "标题"], true);
  assert.equal(decoded.support, "partial");
  assert.equal(decoded.layers.at(-1)?.fidelity, "rasterized");
  assert.equal(decoded.layers.at(-1)?.editable, false);
});

test("damaged psd is rejected and does not look like a saved project", () => {
  assert.throws(() => parsePsdStructure(new Uint8Array([1, 2, 3, 4])), /不是有效的 PSD/);
});

test("missing font, full disk and corrupt projects are not successes", () => {
  assert.throws(
    () => assertCanSave([{ kind: "text", text: { font: "Missing", missingFont: "Missing" } }]),
    /缺少字体「Missing」/,
  );
  assert.equal(explainIoFailure("ENOSPC").includes("磁盘空间不足"), true);
  assert.equal(explainIoFailure(undefined, "JSON parse").includes("损坏"), true);
  assert.ok(platformSlots().every((slot) => slot.status === "blocked"));
});
