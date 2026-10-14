import { parseProject } from "./project";
export interface Recovery {
  content: string;
  writtenAt: number;
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
        const valid = (request.result as Recovery[]).filter((entry) => {
          try {
            parseProject(entry.content);
            return Number.isFinite(entry.writtenAt);
          } catch {
            return false;
          }
        });
        finish(valid.sort((a, b) => b.writtenAt - a.writtenAt)[0] ?? null);
      };
    });
  },
  async write(content: string): Promise<number> {
    if (window.desktop) return window.desktop.writeRecovery(content);
    parseProject(content);
    return transaction("readwrite", (store, finish) => {
      const latest = store.get("latest");
      latest.onsuccess = () => {
        if (latest.result) store.put(latest.result, "previous");
        const writtenAt = Date.now();
        store.put({ content, writtenAt }, "latest");
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
