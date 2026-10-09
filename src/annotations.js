import { dayStringFromMs } from "./util.js";

export const ANNOTATION_SCHEMA = "CREATE TABLE IF NOT EXISTS annotations (id INTEGER PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE, ts INTEGER NOT NULL, text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 240));CREATE INDEX IF NOT EXISTS idx_annotations_site_ts ON annotations(site_id,ts,id);";

export function annotationInput(body) {
  const day = String(body.day || "");
  const text = String(body.text || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Choose a valid date." };
  const parts = day.split("-");
  const ts = Math.floor(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 1000);
  if (Number(parts[0]) < 2000 || Number(parts[0]) > 2100 || dayStringFromMs(ts * 1000) !== day) return { error: "Choose a valid date between 2000 and 2100." };
  if (!text || text.length > 240) return { error: "Write a note between 1 and 240 characters." };
  return { day, ts, text };
}

export function siteAnnotations(db, siteId, range) {
  const rows = range
    ? db.prepare("SELECT id,ts,text FROM annotations WHERE site_id=? AND ts>=? AND ts<? ORDER BY ts,id LIMIT 500").bind(siteId, Math.floor(range.since / 86400) * 86400, range.until).all().results
    : db.prepare("SELECT id,ts,text FROM annotations WHERE site_id=? ORDER BY ts DESC,id DESC LIMIT 500").bind(siteId).all().results;
  return rows.map((row) => ({ ...row, day: dayStringFromMs(Number(row.ts) * 1000) }));
}
