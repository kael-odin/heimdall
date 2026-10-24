/**
 * Cross-tab receipt collections, stored as one IndexedDB value per key.
 *
 * Why not localStorage: both receipt stores used to serialize
 * "read the JSON collection -> modify -> write it back" with Web Locks. A lock
 * guarantees one holder at a time, not that the holder sees the latest value:
 * a localStorage write in one tab is not guaranteed to be visible to the next
 * holder in another tab. Under load (full Chromium, separate tabs, other tabs
 * writing localStorage) the old pattern lost 300 of 300 updates; the same loop
 * with IndexedDB transactions lost 0, because IndexedDB orders readwrite
 * transactions across tabs and every transaction reads committed state.
 *
 * This backend keeps the exact text value the stores always wrote (the
 * canonical JSON collection), so verification, smokes and humans read the same
 * bytes as before; only the storage location changed.
 */
const DATABASE = 'heimdall-receipts';
const STORE = 'collections';

function failure(message, cause) {
  return Object.assign(new Error(message), { code: 'INVALID_RESPONSE', cause });
}

export function idbAvailable(factory = globalThis.indexedDB) {
  return !!factory && typeof factory.open === 'function';
}

let shared = null;
/** One connection per page for every receipt store; null where IndexedDB does not exist (Node tests). */
export function defaultReceiptCollections() {
  if (!idbAvailable()) return null;
  shared ??= createIdbCollections();
  return shared;
}

/**
 * @param {IDBFactory} factory
 * @returns {{ get(key: string): Promise<string|null>, update(key: string, decide: (raw: string|null) => ({ write?: string|null, result?: any })): Promise<any> }}
 */
export function createIdbCollections(factory = globalThis.indexedDB) {
  if (!idbAvailable(factory)) throw failure('当前浏览器不支持本机记录存储（IndexedDB）。');
  let opening = null;
  const database = () => {
    opening ??= new Promise((resolve, reject) => {
      const pending = factory.open(DATABASE, 1);
      pending.onupgradeneeded = () => { if (!pending.result.objectStoreNames.contains(STORE)) pending.result.createObjectStore(STORE); };
      pending.onsuccess = () => {
        const db = pending.result;
        // Another tab upgrading would otherwise block forever; drop and reopen on next use.
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      pending.onerror = () => reject(failure('本机记录存储无法打开。', pending.error));
      pending.onblocked = () => reject(failure('本机记录存储正被其他页面升级占用，请关闭旧页面后重试。'));
    }).catch(cause => { opening = null; throw cause; });
    return opening;
  };
  const finished = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure('本机记录未能完整保存。', transaction.error));
    transaction.onerror = () => reject(failure('本机记录未能完整保存。', transaction.error));
  });
  return Object.freeze({
    async get(key) {
      const db = await database(), transaction = db.transaction(STORE, 'readonly');
      const value = await new Promise((resolve, reject) => {
        const request = transaction.objectStore(STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(failure('本机记录无法读取。', request.error));
      });
      await finished(transaction);
      return value === undefined ? null : value;
    },
    /**
     * Atomic read-modify-write. `decide` runs synchronously inside the
     * transaction with the committed value; it returns `{ write }` to store a
     * string, `{ write: null }` to delete, or no `write` to leave it unchanged.
     * Throwing from `decide` aborts the transaction and rethrows the error.
     */
    async update(key, decide) {
      const db = await database(), transaction = db.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
      const done = finished(transaction);
      let planned, problem = null;
      await new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onerror = () => reject(failure('本机记录无法读取。', request.error));
        request.onsuccess = () => {
          try {
            planned = decide(request.result === undefined ? null : request.result) ?? {};
            if ('write' in planned) {
              if (planned.write === null) store.delete(key);
              else if (typeof planned.write === 'string') store.put(planned.write, key);
              else throw failure('本机记录写入值无效。');
            }
          } catch (cause) { problem = cause; try { transaction.abort(); } catch { /* Already finishing. */ } }
          resolve();
        };
      });
      try { await done; } catch (cause) { throw problem ?? cause; }
      if (problem) throw problem;
      return planned.result;
    },
  });
}
