// Risulta Sprout (single standalone binary, no platform).
//
// One app sprout, one D1 database, static assets embedded in the binary, no
// service bindings (standalone builds reject them: there is no edge). The
// existing Bun Risulta app is untouched; this is a smaller sibling that
// reuses its domain rules where the sprout runtime allows.
//
// Deliberate scope limits, not deferred work:
// - No accounts. The sprout runtime has no scrypt/crypto.subtle for password
//   auth. Run on localhost or behind a proxy you control; network access is
//   admin access.
// - No salted daily visitor hashes. `visitor` is an opaque client-supplied
//   string bounded to 64 chars. Real Risulta derives a daily site-local
//   SHA-256 from IP + User-Agent and stores neither input. Do not treat
//   these counts as privacy-preserving.
// - Single logical D1 instead of one SQLite file per site. Every site-owned
//   row carries site_id and every query scopes on it.
// - Polling dashboard (5-second interval, pauses in hidden tabs, backs off
//   on errors), no SSE (streaming responses are unsupported).
// - Synchronous bounded CSV export. There are no cron jobs, queues or
//   background workers standalone; reports generate on request.

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}

function redirect(to) {
  return new Response("", { status: 303, headers: { location: to } });
}

function ensureSchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, ts INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '', value REAL);" +
      "CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, name TEXT NOT NULL, event_name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (site_id, name));",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_visitor_ts ON events(site_id, visitor, ts);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_site_name_ts ON events(site_id, name, ts);");
}

function cleanDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .slice(0, 253);
}

function validDomain(value) {
  if (value === "localhost") return true;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function validEventName(name) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(String(name || ""));
}

function validValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000) return false;
  return n;
}

// Split "path + query" into a bounded pathname and bounded UTM attribution.
// Non-attribution query parameters are dropped, never stored.
function splitPathAndAttribution(rawPath) {
  const raw = String(rawPath || "").slice(0, 2048);
  const q = raw.indexOf("?");
  const pathname = (q === -1 ? raw : raw.slice(0, q)).slice(0, 2048) || "/";
  const out = { path: pathname, source: "", medium: "", campaign: "", content: "", term: "" };
  if (q === -1) return out;
  const params = new URLSearchParams(raw.slice(q + 1));
  out.source = String(params.get("utm_source") || "").trim().slice(0, 128);
  out.medium = String(params.get("utm_medium") || "").trim().slice(0, 128);
  out.campaign = String(params.get("utm_campaign") || "").trim().slice(0, 128);
  out.content = String(params.get("utm_content") || "").trim().slice(0, 128);
  out.term = String(params.get("utm_term") || "").trim().slice(0, 128);
  return out;
}

function referrerHost(value) {
  const raw = String(value || "").trim().slice(0, 2048);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

// Range selection: explicit UTC from/to (YYYY-MM-DD, at most 366 days) or a
// period in days. until is one second past now so events in the current
// second stay visible. Uses Date.UTC with explicit components only.
function parseRange(searchParams, now) {
  const fromRaw = searchParams.get("from") || "";
  const toRaw = searchParams.get("to") || "";
  if (fromRaw !== "" || toRaw !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
      return { error: "from and to must be YYYY-MM-DD" };
    }
    const f = fromRaw.split("-");
    const t = toRaw.split("-");
    const since = Math.floor(Date.UTC(Number(f[0]), Number(f[1]) - 1, Number(f[2])) / 1000);
    const toDay = Math.floor(Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2])) / 1000);
    if (!(since <= toDay)) return { error: "from must not be after to" };
    if (toDay - since > 366 * 86400) return { error: "range exceeds 366 days" };
    return { since, until: Math.min(toDay + 86400, now + 1), label: fromRaw + ".." + toRaw };
  }
  const period = searchParams.get("period") || "7";
  const days = period === "1" ? 1 : period === "30" ? 30 : 7;
  return { since: now - days * 86400, until: now + 1, label: days + "d" };
}

function siteSummary(db, siteId, since, until) {
  return db.prepare(
    "WITH scoped AS (SELECT ts, visitor, lag(ts) OVER (PARTITION BY visitor ORDER BY ts) AS prev FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
      "SELECT count(*) AS pageviews, count(DISTINCT visitor) AS visitors, " +
      "coalesce(sum(CASE WHEN prev IS NULL OR ts - prev > 1800 THEN 1 ELSE 0 END), 0) AS visits FROM scoped",
  ).bind(siteId, since, until).first();
}

function siteGoals(db, siteId, since, until, visitors) {
  const goals = db.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(siteId).all().results;
  const out = [];
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    const r = db.prepare(
      "SELECT count(*) AS conversions, count(DISTINCT visitor) AS unique_conversions, coalesce(sum(value), 0) AS value " +
        "FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = ? AND (? = '' OR path = ?)",
    ).bind(siteId, since, until, g.event_name, g.path, g.path).first();
    out.push({
      name: g.name,
      event_name: g.event_name,
      path: g.path,
      conversions: r.conversions,
      unique_conversions: r.unique_conversions,
      value: r.value,
      conversion_rate: visitors ? r.unique_conversions / visitors : 0,
    });
  }
  return out;
}

// Bounded report query mirroring the Bun app's report semantics: exact-match
// filters, pageviews-only dimensions except event, sortable, paginated.
function siteReport(db, siteId, since, until, dimension, filters, limit, offset, sort) {
  const dimensions = {
    path: { label: "path", pageviewsOnly: true },
    source: { label: "coalesce(nullif(source,''),'Direct / None')", pageviewsOnly: true },
    medium: { label: "coalesce(nullif(medium,''),'None')", pageviewsOnly: true },
    campaign: { label: "coalesce(nullif(campaign,''),'None')", pageviewsOnly: true },
    event: { label: "name", pageviewsOnly: false },
  };
  const selected = dimensions[dimension] || dimensions.path;
  const conditions = ["site_id = ?", "ts >= ?", "ts < ?"];
  const values = [siteId, since, until];
  if (selected.pageviewsOnly) conditions.push("name = 'pageview'");
  const columns = [["path", "path"], ["campaign", "campaign"], ["event", "name"]];
  for (let i = 0; i < columns.length; i++) {
    if (filters[columns[i][0]]) {
      conditions.push(columns[i][1] + " = ?");
      values.push(filters[columns[i][0]]);
    }
  }
  if (filters.source) {
    conditions.push("coalesce(nullif(source,''),'Direct / None') = ?");
    values.push(filters.source);
  }
  if (filters.medium) {
    conditions.push("coalesce(nullif(medium,''),'None') = ?");
    values.push(filters.medium);
  }
  const where = conditions.join(" AND ");
  const ordering = sort === "pageviews" || sort === "value" ? sort : "visitors";
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const boundedOffset = Math.max(0, Math.min(10000, Number(offset) || 0));
  const grouped =
    "SELECT " + selected.label + " AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors, coalesce(sum(value), 0) AS value " +
    "FROM events WHERE " + where + " GROUP BY label";
  const listed = db.prepare(grouped + " ORDER BY " + ordering + " DESC, label LIMIT ? OFFSET ?");
  const result = listed.bind(...values, boundedLimit, boundedOffset).all().results;
  const counted = db.prepare("SELECT count(*) AS n FROM (" + grouped + ")");
  const total = Number(counted.bind(...values).first().n);
  return { dimension: selected === dimensions[dimension] ? dimension : "path", filters, rows: result, total, limit: boundedLimit, offset: boundedOffset, sort: ordering };
}

function csvEscape(value) {
  const s = String(value === null || value === undefined ? "" : value);
  if (s.indexOf('"') !== -1 || s.indexOf(",") !== -1 || s.indexOf("\n") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function reportCsv(report) {
  const lines = ["label,pageviews,visitors,value"];
  for (let i = 0; i < report.rows.length; i++) {
    const r = report.rows[i];
    lines.push(csvEscape(r.label) + "," + r.pageviews + "," + r.visitors + "," + csvEscape(r.value));
  }
  return lines.join("\n") + "\n";
}

function trackerFor(publicKey) {
  return (
    "/*! Risulta tracker - MIT */(()=>{let l=\"\";const s=document.currentScript,e=new URL(\"/api/event/" +
    publicKey +
    "\",s.src).href,p=(n,v)=>fetch(e,{method:\"POST\",mode:\"cors\",keepalive:true,headers:{\"Content-Type\":\"text/plain\"},body:JSON.stringify({name:n,path:location.pathname+location.search,referrer:document.referrer,domain:location.hostname,value:v})}).catch(()=>{}),f=()=>{const p=location.pathname+location.search;if(p===l)return;l=p;return(window.risulta??={}).track(\"pageview\")};for(const k of[\"pushState\",\"replaceState\"]){const o=history[k];history[k]=function(){const r=o.apply(this,arguments);f();return r}}(window.risulta??={}).track=p;addEventListener(\"popstate\",f);addEventListener(\"pageshow\",e=>{if(e.persisted){l=\"\";f()}});f()})();"
  );
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageShell(title, body) {
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<link rel=\"stylesheet\" href=\"/style.css\">" +
    "<title>" + escapeHtml(title) + "</title></head><body>" + body +
    "<footer><p>Risulta Sprout: single binary, no accounts. Run on localhost or behind a proxy you control.</p></footer></body></html>"
  );
}

function homePage(sites, origin) {
  const rows = sites
    .map(
      (s) =>
        "<li><a href=\"/sites/" + s.id + "\"><strong>" + escapeHtml(s.name) + "</strong></a> (" + escapeHtml(s.domain) + ")</li>",
    )
    .join("");
  return pageShell(
    "Risulta Sprout",
    "<header><h1>Risulta Sprout</h1><p>Single binary, no accounts: run on localhost or behind a proxy you control. " +
      "Visitor counts use an opaque bounded string, not salted daily hashes. Origin for snippets: " + escapeHtml(origin) + "</p></header><main>" +
      "<h2>Add a website</h2>" +
      "<form class=\"inline\" method=\"post\" action=\"/api/sites\"><input name=\"name\" placeholder=\"Example shop\" required> " +
      "<input name=\"domain\" placeholder=\"example.com\" required> <button>Add</button></form>" +
      "<h2>Websites</h2><ul>" + (rows || "<li>none yet</li>") + "</ul></main>",
  );
}

function sitePage(site, goals, origin) {
  const goalRows = goals
    .map((g) => "<li>" + escapeHtml(g.name) + " (" + escapeHtml(g.event_name) + (g.path ? ", " + escapeHtml(g.path) : "") + ")</li>")
    .join("");
  const snippet = '<script src="' + origin + "/js/" + site.public_key + '.js"></script>';
  return pageShell(
    site.name + " - Risulta Sprout",
    "<header><nav><a href=\"/\">All sites</a></nav><h1>" + escapeHtml(site.name) + "</h1><p>" + escapeHtml(site.domain) + "</p></header><main>" +
      "<h2>Tracker snippet</h2><code class=\"snippet\">" + escapeHtml(snippet) + "</code>" +
      "<h2>Live traffic</h2><p class=\"status\" id=\"poll-status\" data-state=\"live\">Starting.</p>" +
      "<p><a data-period href=\"/api/sites/" + site.id + "/stats?period=1\">1 day</a> " +
      "<a data-period href=\"/api/sites/" + site.id + "/stats?period=7\">7 days</a> " +
      "<a data-period href=\"/api/sites/" + site.id + "/stats?period=30\">30 days</a></p>" +
      "<div id=\"live-stats\" data-stats-url=\"/api/sites/" + site.id + "/stats?period=7\"><p>Loading.</p></div>" +
      "<h2>Goals</h2><ul>" + (goalRows || "<li>none yet</li>") + "</ul>" +
      "<form class=\"inline\" method=\"post\" action=\"/api/sites/" + site.id + "/goals\">" +
      "<input name=\"name\" placeholder=\"Signup\" required> " +
      "<input name=\"event_name\" placeholder=\"signup\" required> " +
      "<input name=\"path\" placeholder=\"/pricing (optional)\"> <button>Add goal</button></form>" +
      "<h2>Reports</h2><ul>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=path\">Pages (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=path&format=csv\">CSV</a></li>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=source\">Sources (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=source&format=csv\">CSV</a></li>" +
      "<li><a href=\"/api/sites/" + site.id + "/report?dimension=event\">Events (JSON)</a> / " +
      "<a href=\"/api/sites/" + site.id + "/report?dimension=event&format=csv\">CSV</a></li>" +
      "</ul></main>" +
      "<script src=\"/dashboard.js\"></script>",
  );
}

export default {
  fetch(request) {
    ensureSchema(env.DB);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz") return new Response("ok\n");
    if (path === "/favicon.ico") return new Response("", { status: 204 });

    if (path === "/" && method === "GET") {
      const sites = env.DB.prepare("SELECT id, name, domain, public_key FROM sites ORDER BY name").all().results;
      return new Response(homePage(sites, url.origin), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    const sitePageMatch = /^\/sites\/(\d+)$/.exec(path);
    if (sitePageMatch && method === "GET") {
      const site = env.DB.prepare("SELECT id, name, domain, public_key FROM sites WHERE id = ?").bind(Number(sitePageMatch[1])).first();
      if (!site) return new Response(pageShell("Not found", "<main><h1>Unknown site</h1></main>"), { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
      const goals = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
      return new Response(sitePage(site, goals, url.origin), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // Tracker asset: same behavior as lib/tracker.js in the Bun app.
    const jsMatch = /^\/js\/([A-Za-z0-9_-]+)\.js$/.exec(path);
    if (jsMatch && method === "GET") {
      const site = env.DB.prepare("SELECT id FROM sites WHERE public_key = ?").bind(jsMatch[1]).first();
      if (!site) return json({ error: "unknown site" }, 404);
      return new Response(trackerFor(jsMatch[1]), { headers: { "content-type": "text/javascript;charset=utf-8" } });
    }

    if (path === "/api/sites" && method === "GET") {
      return json(env.DB.prepare("SELECT id, name, domain, public_key, created_at FROM sites ORDER BY name").all().results);
    }

    if (path === "/api/sites" && method === "POST") {
      const ctype = request.headers.get("content-type") || "";
      const wantsJson = ctype.indexOf("application/json") !== -1;
      let name = "";
      let domain = "";
      if (wantsJson) {
        const input = JSON.parse(request.body || "{}");
        name = String(input.name || "").trim().slice(0, 80);
        domain = cleanDomain(input.domain);
      } else {
        const form = new URLSearchParams(request.body || "");
        name = String(form.get("name") || "").trim().slice(0, 80);
        domain = cleanDomain(form.get("domain"));
      }
      if (!name) return json({ error: "name is required" }, 400);
      if (!validDomain(domain)) return json({ error: "domain is invalid" }, 400);
      const exists = env.DB.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
      if (exists) return json({ error: "domain already registered" }, 409);
      const publicKey = crypto.randomUUID().replace(/-/g, "");
      const res = env.DB.prepare("INSERT INTO sites (name, domain, public_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(name, domain, publicKey, Math.floor(Date.now() / 1000))
        .run();
      if (wantsJson) return json({ id: res.meta.last_row_id, name, domain, publicKey }, 201);
      return redirect("/");
    }

    // Goals per site.
    const goalsMatch = /^\/api\/sites\/(\d+)\/goals$/.exec(path);
    if (goalsMatch) {
      const site = env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(Number(goalsMatch[1])).first();
      if (!site) return json({ error: "unknown site" }, 404);
      if (method === "GET") {
        return json(env.DB.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results);
      }
      if (method === "POST") {
        const ctype = request.headers.get("content-type") || "";
        const wantsJson = ctype.indexOf("application/json") !== -1;
        let name = "";
        let eventName = "";
        let goalPath = "";
        if (wantsJson) {
          const input = JSON.parse(request.body || "{}");
          name = String(input.name || "").trim().slice(0, 80);
          eventName = String(input.eventName || input.event_name || "").trim().slice(0, 64);
          goalPath = String(input.path || "").trim().slice(0, 2048);
        } else {
          const form = new URLSearchParams(request.body || "");
          name = String(form.get("name") || "").trim().slice(0, 80);
          eventName = String(form.get("event_name") || "").trim().slice(0, 64);
          goalPath = String(form.get("path") || "").trim().slice(0, 2048);
        }
        if (!name) return json({ error: "name is required" }, 400);
        if (!validEventName(eventName)) return json({ error: "event name is invalid" }, 400);
        if (goalPath !== "" && goalPath.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
        try {
          env.DB.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(site.id, name, eventName, goalPath, Math.floor(Date.now() / 1000))
            .run();
        } catch {
          return json({ error: "goal name already exists for this site" }, 409);
        }
        if (wantsJson) return json({ ok: true, name, eventName, path: goalPath }, 201);
        return redirect("/sites/" + site.id);
      }
    }

    // Collector: validates site key + hostname before persisting, then 202.
    const eventMatch = /^\/api\/event\/([A-Za-z0-9_-]+)$/.exec(path);
    if (eventMatch && method === "POST") {
      const site = env.DB.prepare("SELECT id, domain FROM sites WHERE public_key = ?").bind(eventMatch[1]).first();
      if (!site) return json({ error: "unknown site" }, 404);
      let input = {};
      try {
        input = JSON.parse(request.body || "{}");
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      const name = String(input.name || "");
      if (!validEventName(name)) return json({ error: "event name is invalid" }, 400);
      const value = validValue(input.value === undefined ? null : input.value);
      if (value === false) return json({ error: "value is out of range" }, 400);
      const domain = cleanDomain(input.domain);
      if (domain !== site.domain) return json({ error: "domain mismatch" }, 403);
      const parts = splitPathAndAttribution(input.path);
      if (parts.path.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
      const visitor = String(input.visitor || "").slice(0, 64);
      const ts = Math.floor(Date.now() / 1000);
      env.DB.prepare(
        "INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          site.id, ts, name, parts.path, referrerHost(input.referrer),
          visitor, parts.source, parts.medium, parts.campaign, parts.content, parts.term, value,
        )
        .run();
      return json({ ok: true }, 202);
    }

    // Stats: D1-backed summary with 30-minute visit boundary, configured
    // conversion goals, and an explicit or period-based range. Per-day rows
    // carry their own distinct counts; multi-day totals are visitor-days
    // only in the per-day breakdown, never summed.
    const statsMatch = /^\/api\/sites\/(\d+)\/stats$/.exec(path);
    if (statsMatch && method === "GET") {
      const site = env.DB.prepare("SELECT id, name, domain FROM sites WHERE id = ?").bind(Number(statsMatch[1])).first();
      if (!site) return json({ error: "unknown site" }, 404);
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) return json({ error: range.error }, 400);
      const summary = siteSummary(env.DB, site.id, range.since, range.until);
      const byDay = env.DB.prepare(
        "WITH scoped AS (SELECT ts, visitor FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview') " +
          "SELECT date(ts, 'unixepoch') AS day, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM scoped GROUP BY day ORDER BY day",
      ).bind(site.id, range.since, range.until).all().results;
      const paths = env.DB.prepare(
        "SELECT path AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
          "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY path ORDER BY visitors DESC, pageviews DESC LIMIT 8",
      ).bind(site.id, range.since, range.until).all().results;
      const sources = env.DB.prepare(
        "SELECT coalesce(nullif(source,''),'Direct / None') AS label, count(*) AS pageviews, count(DISTINCT visitor) AS visitors FROM events " +
          "WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'pageview' GROUP BY label ORDER BY visitors DESC, pageviews DESC LIMIT 8",
      ).bind(site.id, range.since, range.until).all().results;
      const goals = siteGoals(env.DB, site.id, range.since, range.until, Number(summary.visitors));
      return json({ site, range: range.label, summary, byDay, paths, sources, goals, note: "standalone: no accounts, opaque visitor strings, single D1" });
    }

    // Bounded report with exact-match filters, sortable and paginated, as
    // JSON or CSV download (synchronous; queue-based exports are Milestone 2).
    const reportMatch = /^\/api\/sites\/(\d+)\/report$/.exec(path);
    if (reportMatch && method === "GET") {
      const site = env.DB.prepare("SELECT id, name, domain FROM sites WHERE id = ?").bind(Number(reportMatch[1])).first();
      if (!site) return json({ error: "unknown site" }, 404);
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) return json({ error: range.error }, 400);
      const q = url.searchParams;
      const filters = {};
      const pathFilter = String(q.get("path") || "").slice(0, 2048);
      const sourceFilter = String(q.get("source") || "").slice(0, 128);
      const mediumFilter = String(q.get("medium") || "").slice(0, 128);
      const campaignFilter = String(q.get("campaign") || "").slice(0, 128);
      const eventFilter = String(q.get("event") || "").slice(0, 64);
      if (pathFilter !== "") filters.path = pathFilter;
      if (sourceFilter !== "") filters.source = sourceFilter;
      if (mediumFilter !== "") filters.medium = mediumFilter;
      if (campaignFilter !== "") filters.campaign = campaignFilter;
      if (eventFilter !== "") filters.event = eventFilter;
      const report = siteReport(
        env.DB, site.id, range.since, range.until,
        String(q.get("dimension") || "path"), filters,
        q.get("limit"), q.get("offset"), String(q.get("sort") || "visitors"),
      );
      if (String(q.get("format") || "") === "csv") {
        return new Response(reportCsv(report), {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": 'attachment; filename="site-' + site.id + "-" + report.dimension + '.csv"',
          },
        });
      }
      return json({ site, range: range.label, ...report });
    }

    // Embedded static assets (CSS + polling dashboard JS). The assets
    // directory is the URL root, so /style.css and /dashboard.js resolve.
    // Unknown API routes stay JSON; other unknown GETs fall through to
    // assets, which answer 404 when no file matches.
    if (path === "/api" || path.indexOf("/api/") === 0) return json({ error: "not found", path }, 404);
    if (method === "GET") return env.ASSETS.fetch(request);

    return json({ error: "not found", path }, 404);
  },
};
