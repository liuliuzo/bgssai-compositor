import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { checkMemory, estimateMemory, MIB } from "../src/memory.ts";
import { adjustPixels, blurPixels } from "../src/filters.ts";
import { defaults } from "../src/project.ts";
import { imageDimensions } from "../src/image-header.ts";
const require = createRequire(import.meta.url);
const { RecoveryStore, atomicWrite } = require("../electron/storage.cjs");
const { verifyManifest, download } = require("../electron/updates.cjs");
const { installWithRollback } = require("../electron/update-runner.cjs");
const sample = await fs.readFile(
  new URL("../fixtures/shared.bgcomp", import.meta.url),
  "utf8",
);

test("disk-full failure preserves the previous project and reports an unsuccessful save", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-test-"));
  const target = path.join(directory, "saved.bgcomp");
  try {
    await fs.writeFile(target, sample);
    t.mock.method(fs, "open", async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    await assert.rejects(atomicWrite(target, "new contents"), /磁盘空间不足/);
    assert.equal(await fs.readFile(target, "utf8"), sample);
    assert.deepEqual(await fs.readdir(directory), ["saved.bgcomp"]);
  } finally {
    t.mock.restoreAll();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("compositor-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("software filters preserve alpha, remove saturation, and blur transparent edges without color halos", () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 128]);
  adjustPixels(pixels, { ...defaults(), saturation: -100 });
  assert.equal(pixels[0], pixels[1]);
  assert.equal(pixels[1], pixels[2]);
  assert.equal(pixels[3], 128);
  const image = new Uint8ClampedArray(9 * 9 * 4);
  const i = (4 * 9 + 4) * 4;
  image[i] = 255;
  image[i + 3] = 255;
  blurPixels(image, 9, 9, 1);
  assert.ok(image[i + 3] > 0 && image[i + 3] < 255);
  assert.equal(image[i], 255);
  assert.equal(image[i + 1], 0);
});
test("compressed image headers enforce dimension budgets before decoding", () => {
  const bmp = Buffer.alloc(30);
  bmp.write("BM");
  bmp.writeInt32LE(100000, 18);
  bmp.writeInt32LE(100, 22);
  assert.throws(
    () => imageDimensions(`data:image/bmp;base64,${bmp.toString("base64")}`),
    /宽高/,
  );
  assert.equal(imageDimensions(JSON.parse(sample).layers[0].image).width, 1);
});
test("installer failure and startup failure roll back; rollback failure is never reported as success", async () => {
  for (const failure of ["install", "healthy", "none"]) {
    const calls: string[] = [];
    const actions = {
      install: async () => {
        calls.push("install");
        if (failure === "install") throw new Error("installer failed");
      },
      launch: async () => {
        calls.push("launch");
        return {};
      },
      healthy: async () => {
        calls.push("healthy");
        return failure !== "healthy";
      },
      stop: async () => {
        calls.push("stop");
      },
      rollback: async () => {
        calls.push("rollback");
      },
      launchPrevious: async () => {
        calls.push("previous");
      },
    };
    const result = await installWithRollback(actions);
    assert.equal(result.status, failure === "none" ? "updated" : "rolled-back");
    assert.deepEqual(
      calls,
      failure === "none"
        ? ["install", "launch", "healthy"]
        : failure === "install"
          ? ["install", "rollback", "previous"]
          : ["install", "launch", "healthy", "stop", "rollback", "previous"],
    );
  }
  await assert.rejects(
    installWithRollback({
      install: async () => {
        throw new Error("install failed");
      },
      rollback: async () => {
        throw new Error("rollback failed");
      },
    }),
    /rollback failed/,
  );
});
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function temporary(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compositor-test-"));
  try {
    await fn(dir);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("compositor-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("recovery persists newest valid generation, survives corruption, and cleans only owned temporary files", () =>
  temporary(async (directory) => {
    const store = new RecoveryStore(directory);
    await store.write(sample);
    const second = sample.replace("五端共同样例", "第二版");
    await store.write(second);
    assert.equal((await store.read()).content, second);
    await fs.writeFile(
      path.join(directory, "snapshot-1.json"),
      "partial write",
    );
    assert.equal((await new RecoveryStore(directory).read()).content, sample);
    await fs.writeFile(
      path.join(
        directory,
        "snapshot-1.json.12345678-1234-1234-1234-123456789012.tmp",
      ),
      "orphan",
    );
    await fs.writeFile(path.join(directory, "other.tmp"), "keep");
    await store.init();
    assert.deepEqual((await fs.readdir(directory)).sort(), [
      "other.tmp",
      "snapshot-0.json",
      "snapshot-1.json",
    ]);
    await assert.rejects(
      store.write('{"format":"bgssai-compositor","version":1,"layers":[]}'),
    );
    assert.equal((await store.read()).content, sample);
    const valid = JSON.parse(sample);
    valid.layers[0].opacity = 9;
    await assert.rejects(store.write(JSON.stringify(valid)));
    await Promise.all([store.write(second), store.clear()]);
    assert.equal(await store.read(), null);
  }));
test("memory budget accounts for transient adoption, history and serialized copies", () => {
  assert.equal(estimateMemory(100, 100, 100, 100), 2700);
  checkMemory(100 * MIB, 320 * MIB);
  assert.throws(() => checkMemory(321 * MIB, 320 * MIB), /超过预算/);
  assert.throws(
    () =>
      checkMemory(estimateMemory(96_000_000, 32_000_000, 64 * MIB, 96 * MIB)),
    /超过预算/,
  );
});
test("signed manifest rejects tampering, downgrade, expired feed, wrong platform and missing rollback", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "pem" });
  const artifact = (version: string) => ({
    platform: "win32",
    arch: "x64",
    file: `BGSSAI-Compositor-${version}-win-x64-setup.exe`,
    size: 4,
    sha256: digest("test"),
    url: `https://github.com/liuliuzo/bgssai-compossitor/releases/download/v${version}/BGSSAI-Compositor-${version}-win-x64-setup.exe`,
  });
  const data = {
    schema: 1,
    version: "0.2.0",
    sourceSha: "a".repeat(40),
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    artifacts: [artifact("0.2.0")],
    rollback: {
      version: "0.1.0",
      sourceSha: "b".repeat(40),
      artifact: artifact("0.1.0"),
    },
  };
  const envelope = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      payload: bytes.toString("base64"),
      signature: sign(null, bytes, privateKey).toString("base64"),
    };
  };
  const valid = envelope(data);
  assert.equal(
    verifyManifest(valid, key, "0.1.0", "win32", "x64").version,
    "0.2.0",
  );
  assert.throws(
    () =>
      verifyManifest(
        { ...valid, payload: Buffer.from("{}").toString("base64") },
        key,
        "0.1.0",
        "win32",
        "x64",
      ),
    /签名/,
  );
  assert.throws(
    () => verifyManifest(valid, key, "0.2.0", "win32", "x64"),
    /降级/,
  );
  assert.throws(
    () =>
      verifyManifest(
        envelope({ ...data, expiresAt: Date.now() - 100 }),
        key,
        "0.1.0",
        "win32",
        "x64",
      ),
    /有效期/,
  );
  assert.throws(
    () => verifyManifest(valid, key, "0.1.0", "darwin", "arm64"),
    /平台/,
  );
  assert.throws(
    () =>
      verifyManifest(
        envelope({ ...data, rollback: null }),
        key,
        "0.1.0",
        "win32",
        "x64",
      ),
    /回滚/,
  );
});
test("download corruption or network interruption preserves cached rollback and removes temporary candidate", () =>
  temporary(async (directory) => {
    const file = "BGSSAI-Compositor-0.2.0-win-x64-setup.exe";
    const artifact = {
      file,
      url: `https://github.com/liuliuzo/bgssai-compossitor/releases/download/v0.2.0/${file}`,
      size: 4,
      sha256: digest("good"),
    };
    await fs.writeFile(path.join(directory, "rollback.exe"), "old");
    await assert.rejects(
      download(
        artifact,
        directory,
        async () => new Response("bad!", { status: 200 }),
      ),
      /SHA256/,
    );
    assert.equal(
      await fs.readFile(path.join(directory, "rollback.exe"), "utf8"),
      "old",
    );
    assert.ok(
      !(await fs.readdir(directory)).some((name) => name.endsWith(".download")),
    );
    await assert.rejects(
      download(artifact, directory, async () => {
        throw new Error("offline");
      }),
      /offline/,
    );
    assert.equal(
      await fs.readFile(
        await download(
          artifact,
          directory,
          async () => new Response("good", { status: 200 }),
        ),
        "utf8",
      ),
      "good",
    );
  }));
