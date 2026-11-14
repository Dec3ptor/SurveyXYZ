// Thin promise wrapper over IndexedDB. All survey data lives on the device.
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('surveyxyz', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('surveys', { keyPath: 'id' });
      db.createObjectStore('points', { keyPath: 'id', autoIncrement: true }).createIndex('survey', 'surveyId');
      db.createObjectStore('obs', { keyPath: 'id' }).createIndex('survey', 'surveyId');
      db.createObjectStore('photos', { keyPath: 'id' }).createIndex('survey', 'surveyId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const res = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(res && 'result' in res ? res.result : res);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value));
export const putMany = (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); });
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const all = (store) => run(store, 'readonly', (s) => s.getAll());
export const bySurvey = (store, surveyId) => run(store, 'readonly', (s) => s.index('survey').getAll(surveyId));

export async function deleteSurvey(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['surveys', 'points', 'obs', 'photos'], 'readwrite');
    tx.objectStore('surveys').delete(id);
    for (const name of ['points', 'obs', 'photos']) {
      const req = tx.objectStore(name).index('survey').openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const c = req.result;
        if (c) { tx.objectStore(name).delete(c.primaryKey); c.continue(); }
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
