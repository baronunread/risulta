// Backup preferences and bounded history shared by the app and built-in maintenance.
let ready = false;
export function ensureBackupSchema(db) {
  if (ready) return;
  db.exec("CREATE TABLE IF NOT EXISTS backup_settings (id INTEGER PRIMARY KEY CHECK (id = 1), frequency TEXT NOT NULL DEFAULT 'off', hour INTEGER NOT NULL DEFAULT 2, minute INTEGER NOT NULL DEFAULT 0, retention INTEGER NOT NULL DEFAULT 14, runner_seen INTEGER NOT NULL DEFAULT 0);");
  db.exec("INSERT OR IGNORE INTO backup_settings (id) VALUES (1);");
  db.exec("CREATE TABLE IF NOT EXISTS backup_history (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0);");
  ready = true;
}
export function backupSettings(db) {
  return db.prepare("SELECT frequency, hour, minute, retention, runner_seen FROM backup_settings WHERE id = 1").first();
}
export function backupHistory(db) {
  return db.prepare("SELECT id, created_at, kind, status, path, bytes FROM backup_history ORDER BY id DESC LIMIT 20").all().results;
}
export function backupInput(input) {
  const frequency = String(input.frequency || "off");
  const time = String(input.time || "");
  const retention = Number(input.retention);
  if (frequency !== "off" && frequency !== "daily" && frequency !== "weekly") return { error: "Choose manual, daily or weekly backups." };
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return { error: "Choose a valid backup time in UTC." };
  if (!Number.isInteger(retention) || retention < 1 || retention > 90) return { error: "Keep between 1 and 90 scheduled backups." };
  return { frequency, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)), retention };
}
export function saveBackupSettings(db, input) {
  db.prepare("UPDATE backup_settings SET frequency = ?, hour = ?, minute = ?, retention = ? WHERE id = 1")
    .bind(input.frequency, input.hour, input.minute, input.retention).run();
}
export function recordBackup(db, snapshot) {
  db.prepare("INSERT INTO backup_history (created_at, kind, status, path, bytes) VALUES (?, 'manual', 'success', ?, ?)")
    .bind(Math.floor(Date.now() / 1000), snapshot.path, snapshot.bytes).run();
}
