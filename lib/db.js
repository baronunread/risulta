import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const key = (bytes = 18) => randomBytes(bytes).toString("base64url");

function configure(db) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  return db;
}

function migrate(db, migrations) {
  let version = Number(db.prepare("PRAGMA user_version").get().user_version);
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version=${migration.version}`);
      db.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

const siteMigrations = [
  { version: 1, up: (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT,
      visitor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS daily_salts (
      day TEXT PRIMARY KEY,
      value BLOB NOT NULL
    );`) },
  { version: 2, up: (db) => {
    const columns = new Set(db.prepare("PRAGMA table_info(events)").all().map((column) => column.name));
    if (!columns.has("visitor")) db.exec("ALTER TABLE events ADD COLUMN visitor TEXT");
  } },
  { version: 3, up: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)") },
  { version: 4, up: (db) => db.exec(`
    ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN medium TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN campaign TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN content TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN term TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_events_visitor_ts ON events(visitor, ts);
  `) },
  { version: 5, up: (db) => db.exec(`
    ALTER TABLE events ADD COLUMN value REAL;
    CREATE INDEX IF NOT EXISTS idx_events_name_ts ON events(name, ts);
  `) },
];

const controlMigrations = [
  { version: 1, up: (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL COLLATE NOCASE UNIQUE,
      public_key TEXT NOT NULL UNIQUE,
      db_name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_users (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','viewer')),
      PRIMARY KEY (user_id, site_id)
    );
  `) },
  { version: 2, up: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)") },
  { version: 3, up: (db) => db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''") },
  { version: 4, up: (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      event_name TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE (site_id, name)
    );
    CREATE TABLE IF NOT EXISTS funnels (
      id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (site_id, name)
    );
    CREATE TABLE IF NOT EXISTS funnel_steps (
      funnel_id INTEGER NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position > 0),
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      PRIMARY KEY (funnel_id, position),
      UNIQUE (funnel_id, goal_id)
    );
  `) },
];

function initializeSite(db) {
  configure(db);
  migrate(db, siteMigrations);
  return db;
}

export class SiteStore {
  constructor(path) {
    this.db = initializeSite(new DatabaseSync(path));
    this.insertStatement = this.db.prepare(`
      INSERT INTO events (ts, name, path, referrer, visitor, source, medium, campaign, content, term, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.sessionAttributionStatement = this.db.prepare(`
      SELECT source, medium, campaign, content, term FROM events
      WHERE name = 'pageview' AND visitor = ? AND ts >= ?
      ORDER BY ts DESC LIMIT 1`);
    this.summaryStatement = this.db.prepare(`
      WITH scoped AS (
        SELECT ts, visitor, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS previous_ts
        FROM events WHERE ts >= ? AND name = 'pageview'
      )
      SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors,
        coalesce(sum(CASE WHEN previous_ts IS NULL OR ts - previous_ts > 1800 THEN 1 ELSE 0 END), 0) AS visits
      FROM scoped`);
    this.currentStatement = this.db.prepare(`
      SELECT count(DISTINCT visitor) AS n FROM events
      WHERE ts >= unixepoch() - 300 AND name = 'pageview'`);
    this.byDayStatement = this.db.prepare(`
      SELECT date(ts, 'unixepoch') AS day, count(*) AS pageviews,
        count(DISTINCT visitor) AS visitors
      FROM events WHERE ts >= ? AND name = 'pageview'
      GROUP BY day ORDER BY day`);
    this.byHourStatement = this.db.prepare(`
      SELECT cast(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour,
        count(*) AS pageviews, count(DISTINCT visitor) AS visitors
      FROM events WHERE ts >= ? AND name = 'pageview'
      GROUP BY hour ORDER BY hour`);
    this.topPathsStatement = this.db.prepare(`
      SELECT path AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors
      FROM events WHERE ts >= ? AND name = 'pageview'
      GROUP BY path ORDER BY visitors DESC, pageviews DESC LIMIT 8`);
    this.topRefsStatement = this.db.prepare(`
      SELECT coalesce(nullif(source,''),'Direct / None') AS label,
        count(*) AS pageviews, count(DISTINCT visitor) AS visitors
      FROM events WHERE ts >= ? AND name = 'pageview'
      GROUP BY label ORDER BY visitors DESC, pageviews DESC LIMIT 8`);
    this.topCampaignsStatement = this.db.prepare(`
      SELECT campaign AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors
      FROM events WHERE ts >= ? AND name = 'pageview' AND campaign != ''
      GROUP BY campaign ORDER BY visitors DESC, pageviews DESC LIMIT 8`);
    this.goalStatement = this.db.prepare(`
      SELECT count(*) AS conversions, count(DISTINCT visitor) AS unique_conversions,
        coalesce(sum(value), 0) AS value
      FROM events WHERE ts >= ? AND name = ? AND (? = '' OR path = ?)`);
    this.findSaltStatement = this.db.prepare("SELECT value FROM daily_salts WHERE day = ?");
    this.addSaltStatement = this.db.prepare("INSERT OR IGNORE INTO daily_salts (day, value) VALUES (?, ?)");
    this.removeSaltsStatement = this.db.prepare("DELETE FROM daily_salts WHERE day != ?");
    this.saltDay = "";
    this.saltValue = null;
  }

  insert(event) {
    let attribution = event.attribution || { source: "", medium: "", campaign: "", content: "", term: "" };
    if (event.name === "pageview") {
      const activeSession = this.sessionAttributionStatement.get(event.visitor, event.ts - 1800);
      if (activeSession) attribution = activeSession;
    }
    this.insertStatement.run(event.ts, event.name, event.path, event.referrer, event.visitor,
      attribution.source, attribution.medium, attribution.campaign, attribution.content, attribution.term, event.value);
  }

  salt(day) {
    if (day === this.saltDay && this.saltValue) return this.saltValue;
    this.removeSaltsStatement.run(day);
    this.addSaltStatement.run(day, randomBytes(32));
    this.saltDay = day;
    this.saltValue = this.findSaltStatement.get(day).value;
    return this.saltValue;
  }

  analytics(since, goals = []) {
    const summary = this.summaryStatement.get(since);
    return {
      summary,
      current: Number(this.currentStatement.get().n),
      byDay: this.byDayStatement.all(since),
      byHour: this.byHourStatement.all(since),
      paths: this.topPathsStatement.all(since),
      referrers: this.topRefsStatement.all(since),
      campaigns: this.topCampaignsStatement.all(since),
      goals: goals.map((goal) => ({ ...goal, ...this.goalStatement.get(since, goal.event_name, goal.path, goal.path), conversion_rate: Number(summary.visitors) ? Number(this.goalStatement.get(since, goal.event_name, goal.path, goal.path).unique_conversions) / Number(summary.visitors) : 0 })),
    };
  }

  close() {
    this.db.close();
  }
}

export class RisultaDatabase {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sitesDir = join(dataDir, "sites");
    mkdirSync(this.sitesDir, { recursive: true });
    this.control = configure(new DatabaseSync(join(dataDir, "control.db")));
    migrate(this.control, controlMigrations);
    this.stores = new Map();
    this.maxOpenSites = Math.max(1, Number(process.env.RISULTA_MAX_OPEN_SITES || 32));
  }

  userCount() {
    return Number(this.control.prepare("SELECT count(*) AS n FROM users").get().n);
  }

  createUser(email, passwordHash, role = "viewer", siteIds = [], displayName = "") {
    const resolvedName = displayName || email.split("@")[0];
    this.control.exec("BEGIN IMMEDIATE");
    try {
      const result = this.control.prepare(`
        INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(email, passwordHash, role, resolvedName, Math.floor(Date.now() / 1000));
      const userId = Number(result.lastInsertRowid);
      if (role === "viewer") {
        const assign = this.control.prepare("INSERT OR IGNORE INTO site_users (user_id, site_id, role) VALUES (?, ?, 'viewer')");
        for (const siteId of siteIds) assign.run(userId, siteId);
      }
      this.control.exec("COMMIT");
      return this.findUserById(userId);
    } catch (error) {
      this.control.exec("ROLLBACK");
      throw error;
    }
  }

  findUserByEmail(email) {
    return this.control.prepare("SELECT * FROM users WHERE email = ?").get(email);
  }

  findUserById(id) {
    return this.control.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  listUsers() {
    return this.control.prepare(`
      SELECT users.id, users.email, users.display_name, users.role, users.created_at,
        group_concat(sites.name, ', ') AS sites
      FROM users LEFT JOIN site_users ON site_users.user_id = users.id
      LEFT JOIN sites ON sites.id = site_users.site_id
      GROUP BY users.id ORDER BY users.created_at, users.id`).all();
  }

  createSession(tokenHash, userId, csrf, expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    this.control.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    this.control.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(tokenHash, userId, csrf, now, expiresAt);
  }

  findSession(tokenHash) {
    return this.control.prepare(`
      SELECT sessions.token_hash, sessions.csrf, sessions.expires_at,
        users.id AS user_id, users.email, users.display_name, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
      .get(tokenHash, Math.floor(Date.now() / 1000));
  }

  deleteSession(tokenHash) {
    this.control.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  changePassword(userId, passwordHash, currentTokenHash) {
    this.control.exec("BEGIN IMMEDIATE");
    try {
      this.control.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
      this.control.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, currentTokenHash);
      this.control.exec("COMMIT");
    } catch (error) {
      this.control.exec("ROLLBACK");
      throw error;
    }
  }

  updateProfile(userId, displayName, email) {
    this.control.prepare("UPDATE users SET display_name = ?, email = ? WHERE id = ?").run(displayName, email, userId);
  }

  deleteUser(userId) {
    const user = this.findUserById(userId);
    if (!user) return false;
    if (user.role === "admin" && Number(this.control.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get().n) < 2) return false;
    this.control.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return true;
  }

  createSite(name, domain) {
    const dbName = `${key(12)}.db`;
    const result = this.control.prepare(`
      INSERT INTO sites (name, domain, public_key, db_name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(name, domain, key(), dbName, Math.floor(Date.now() / 1000));
    const site = this.control.prepare("SELECT * FROM sites WHERE id = ?").get(Number(result.lastInsertRowid));
    this.siteStore(site);
    return site;
  }

  listSitesForUser(user) {
    if (user.role === "admin") return this.control.prepare("SELECT * FROM sites ORDER BY name COLLATE NOCASE").all();
    return this.control.prepare(`
      SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id
      WHERE site_users.user_id = ? ORDER BY sites.name COLLATE NOCASE`).all(user.user_id || user.id);
  }

  getSiteForUser(siteId, user) {
    if (user.role === "admin") return this.control.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
    return this.control.prepare(`
      SELECT sites.* FROM sites JOIN site_users ON site_users.site_id = sites.id
      WHERE sites.id = ? AND site_users.user_id = ?`).get(siteId, user.user_id || user.id);
  }

  getSiteByKey(publicKey) {
    return this.control.prepare("SELECT * FROM sites WHERE public_key = ?").get(publicKey);
  }

  listGoals(siteId) {
    return this.control.prepare("SELECT * FROM goals WHERE site_id = ? ORDER BY created_at, id").all(siteId);
  }

  createGoal(siteId, name, eventName, path = "") {
    const result = this.control.prepare(`
      INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(siteId, name, eventName, path, Math.floor(Date.now() / 1000));
    return this.control.prepare("SELECT * FROM goals WHERE id = ?").get(Number(result.lastInsertRowid));
  }

  async snapshot(directory) {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${key(6)}`;
    const temporary = join(directory, `.${id}.partial`);
    const target = join(directory, id);
    mkdirSync(temporary, { recursive: true });
    mkdirSync(join(temporary, "sites"));
    await backup(this.control, join(temporary, "control.db"));
    const sites = this.control.prepare("SELECT * FROM sites ORDER BY id").all();
    for (const site of sites) await backup(this.siteStore(site).db, join(temporary, "sites", site.db_name));
    renameSync(temporary, target);
    return target;
  }

  siteStore(site) {
    if (!site) return null;
    if (this.stores.has(site.id)) {
      const store = this.stores.get(site.id);
      this.stores.delete(site.id);
      this.stores.set(site.id, store);
      return store;
    }
    while (this.stores.size >= this.maxOpenSites) {
      const oldestId = this.stores.keys().next().value;
      this.stores.get(oldestId).close();
      this.stores.delete(oldestId);
    }
    this.stores.set(site.id, new SiteStore(join(this.sitesDir, site.db_name)));
    return this.stores.get(site.id);
  }

  close() {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    this.control.close();
  }
}
