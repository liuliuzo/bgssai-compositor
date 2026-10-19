const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const {
  parseProject,
  recoverProjectState,
  computeSnapshotChecksum,
} = require("./project-validator.cjs");
const MAX_BYTES = 128 * 1024 * 1024;
const hash = (data) => createHash("sha256").update(data).digest("hex");

async function atomicWrite(target, data) {
  const temp = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.open(temp, "wx", 0o600);
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(temp, target);
  } finally {
    await file?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
}
function validate(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_BYTES)
    throw new Error("项目过大（上限 128 MB）");
  parseProject(content);
}

// Two independent generations: an interrupted write never removes the last snapshot.
class RecoveryStore {
  constructor(directory) {
    this.directory = directory;
    this.queue = Promise.resolve();
  }
  enqueue(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.directory)) {
      if (/^snapshot-[01]\.json\.[0-9a-f-]+\.tmp$/.test(name))
        await fs.unlink(path.join(this.directory, name)).catch(() => {});
    }
  }
  async snapshots(options = {}) {
    const allowSalvage = Boolean(options.allowSalvage);
    const entries = [];
    for (let slot = 0; slot < 2; slot++) {
      try {
        const target = path.join(this.directory, `snapshot-${slot}.json`);
        if ((await fs.stat(target)).size > MAX_BYTES * 2 + 2048) continue;
        const entry = JSON.parse(await fs.readFile(target, "utf8"));
        if (
          typeof entry.content !== "string" ||
          entry.sha256 !== hash(entry.content) ||
          (entry.checksum &&
            entry.checksum !== computeSnapshotChecksum(entry.content)) ||
          !Number.isSafeInteger(entry.sequence) ||
          !Number.isFinite(entry.writtenAt)
        )
          continue;
        try {
          validate(entry.content);
          entries.push({ ...entry, slot, salvaged: false, quarantinedLayers: [] });
        } catch (err) {
          if (!allowSalvage) throw err;
          const recovered = recoverProjectState(entry.content);
          entries.push({
            ...entry,
            content: recovered.json,
            slot,
            salvaged: true,
            clampedCanvas: recovered.clampedCanvas,
            quarantinedLayers: recovered.quarantinedLayers,
          });
        }
      } catch {
        /* Missing or damaged generation: use the other one. */
      }
    }
    return entries.sort((a, b) => b.sequence - a.sequence);
  }
  read() {
    return this.enqueue(async () => {
      await this.init();
      return (await this.snapshots())[0] ?? null;
    });
  }
  readWithSalvage() {
    return this.enqueue(async () => {
      await this.init();
      const strict = await this.snapshots({ allowSalvage: false });
      if (strict[0]) return strict[0];
      const salvaged = await this.snapshots({ allowSalvage: true });
      return salvaged[0] ?? null;
    });
  }
  write(content) {
    return this.enqueue(async () => {
      validate(content);
      await this.init();
      const latest = (await this.snapshots())[0];
      if (latest?.sha256 === hash(content)) return latest.writtenAt;
      const entry = {
        content,
        sha256: hash(content),
        checksum: computeSnapshotChecksum(content),
        sequence: (latest?.sequence ?? 0) + 1,
        writtenAt: Date.now(),
      };
      const slot = latest ? 1 - latest.slot : 0;
      const serialized = JSON.stringify(entry);
      if (Buffer.byteLength(serialized) > MAX_BYTES * 2 + 2048)
        throw new Error("自动恢复快照超过存储预算，请手动保存项目。");
      await atomicWrite(
        path.join(this.directory, `snapshot-${slot}.json`),
        serialized,
      );
      return entry.writtenAt;
    });
  }
  clear() {
    return this.enqueue(async () => {
      for (let i = 0; i < 2; i++)
        await fs
          .unlink(path.join(this.directory, `snapshot-${i}.json`))
          .catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
    });
  }
}
module.exports = { atomicWrite, RecoveryStore, hash, MAX_BYTES };

