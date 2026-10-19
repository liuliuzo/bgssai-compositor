import {
  computeSnapshotChecksum,
  parseProject,
  recoverProjectState,
  type QuarantinedLayerReport,
} from "./project";
export interface Recovery {
  content: string;
  writtenAt: number;
  checksum?: string;
  sequence?: number;
  salvaged?: boolean;
  quarantinedLayers?: QuarantinedLayerReport[];
}

// IndexedDB transactions work offline in both native mobile WebViews and browsers.
// Keep two records; transaction aborts (including quota exhaustion) preserve both.
let dbPromise: Promise<IDBDatabase> | undefined;
function database() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("bgssai-compositor-local", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("recovery");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, finish: (value: T) => void) => void,
) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("recovery", mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("本地恢复存储失败，请手动保存。"));
    operation(tx.objectStore("recovery"), (value) => {
      result = value;
    });
  });
}
export const recovery = {
  async read(): Promise<Recovery | null> {
    if (window.desktop) return window.desktop.readRecovery();
    return transaction("readonly", (store, finish) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const candidates = (request.result as Recovery[]).filter(
          (entry) =>
            entry &&
            typeof entry.content === "string" &&
            Number.isFinite(entry.writtenAt) &&
            (!entry.checksum ||
              entry.checksum === computeSnapshotChecksum(entry.content)),
        );
        const sorted = candidates.sort((a, b) => b.writtenAt - a.writtenAt);
        for (const entry of sorted) {
          try {
            parseProject(entry.content);
            finish(entry);
            return;
          } catch {
            /* try next or salvage */
          }
        }
        for (const entry of sorted) {
          try {
            const recovered = recoverProjectState(entry.content);
            finish({
              ...entry,
              content: recovered.json,
              salvaged: true,
              quarantinedLayers: recovered.quarantinedLayers,
            });
            return;
          } catch {
            /* skip unrecoverable entry */
          }
        }
        finish(null);
      };
    });
  },
  async write(content: string): Promise<number> {
    if (window.desktop) return window.desktop.writeRecovery(content);
    parseProject(content);
    const checksum = computeSnapshotChecksum(content);
    return transaction("readwrite", (store, finish) => {
      const latest = store.get("latest");
      latest.onsuccess = () => {
        const prior = latest.result as Recovery | undefined;
        if (prior) store.put(prior, "previous");
        const writtenAt = Date.now();
        const sequence = (prior?.sequence ?? 0) + 1;
        store.put({ content, writtenAt, checksum, sequence }, "latest");
        finish(writtenAt);
      };
    });
  },
  async clear(): Promise<void> {
    if (window.desktop) return window.desktop.clearRecovery();
    return transaction("readwrite", (store, finish) => {
      store.clear();
      finish(undefined);
    });
  },
};

