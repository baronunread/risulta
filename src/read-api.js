// Site-bound credentials grant access only to the two existing read routes.
import { bytesToHex, randomHex } from "./auth.js";

export const READ_KEYS_SCHEMA = "CREATE TABLE IF NOT EXISTS read_api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);";

export async function readKeyHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export async function createReadKey(db, siteId) {
  const token = "risulta_read_" + randomHex(32);
  const createdAt = Math.floor(Date.now() / 1000);
  const result = db.prepare("INSERT INTO read_api_keys (site_id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(siteId, await readKeyHash(token), createdAt).run();
  return { id: Number(result.meta.last_row_id), site_id: siteId, created_at: createdAt, token };
}

export async function readKeySite(db, request) {
  if (request.method !== "GET") return null;
  const match = /^\/api\/sites\/([0-9]+)\/(stats|report)$/.exec(new URL(request.url).pathname);
  if (!match) return null;
  const header = request.headers.get("authorization") || "";
  if (!/^Bearer risulta_read_[0-9a-f]{64}$/i.test(header)) return null;
  const token = header.slice(7);
  return db.prepare("SELECT sites.* FROM sites JOIN read_api_keys ON read_api_keys.site_id = sites.id WHERE sites.id = ? AND read_api_keys.token_hash = ?")
    .bind(Number(match[1]), await readKeyHash(token)).first() || null;
}
