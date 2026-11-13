// The `blobs` hook: put, get and delete by a key the SERVER chooses. A part
// name or any other string from an uploaded file is never used as a key.
//
// memoryBlobs is for tests and tiny jobs. Self-hosted instances use a
// directory in the data dir (fileBlobs, wired where the app has a data dir);
// Cloud uses an object-storage binding (risulta-cloud).
export function memoryBlobs() {
  const map = new Map();
  return {
    async put(key, value) { map.set(key, String(value)); },
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async delete(key) { map.delete(key); },
    size() { return map.size; },
    keys() { return Array.from(map.keys()); },
  };
}

const SAFE_KEY = /^[A-Za-z0-9_\-/]{1,200}$/;
export function safeKey(key) {
  if (!SAFE_KEY.test(key) || key.indexOf("..") >= 0 || key.charAt(0) === "/") throw new Error("unsafe blob key");
  return key;
}

// The self-hosted default. The standalone binary has no general file reads, so
// parts wait in the shared database (a row per 900,000 characters, under D1's
// 2 MB row limit) and are deleted when the job ends. Cloud supplies object
// storage instead (risulta-cloud).
const CHUNK = 900000;
export function dbBlobs(db) {
  let ready = null;
  const ensure = () => ready || (ready = db.prepare("CREATE TABLE IF NOT EXISTS move_blobs (key TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (key, seq)) WITHOUT ROWID").run());
  return {
    async put(key, value) {
      safeKey(key);
      await ensure();
      const text = String(value);
      const list = [db.prepare("DELETE FROM move_blobs WHERE key = ?").bind(key)];
      let seq = 0;
      for (let i = 0; i < text.length || i === 0; i += CHUNK) list.push(db.prepare("INSERT INTO move_blobs (key, seq, body) VALUES (?, ?, ?)").bind(key, seq++, text.slice(i, i + CHUNK)));
      await db.batch(list);
    },
    async get(key) {
      safeKey(key);
      await ensure();
      const rows = (await db.prepare("SELECT body FROM move_blobs WHERE key = ? ORDER BY seq").bind(key).all()).results;
      return rows.length ? rows.map((row) => row.body).join("") : null;
    },
    async delete(key) {
      safeKey(key);
      await ensure();
      await db.prepare("DELETE FROM move_blobs WHERE key = ?").bind(key).run();
    },
  };
}
